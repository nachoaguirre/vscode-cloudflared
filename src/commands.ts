import * as vscode from 'vscode';
import { AuthService } from './cloudflared/auth';
import { BinaryService } from './cloudflared/binary';
import { CliError, CloudflaredCli } from './cloudflared/cli';
import { isValidHostname, isValidTunnelName, RemoteTunnel } from './cloudflared/parse';
import { errorMessage, getLog } from './log';
import { SetupService } from './onboarding/setup';
import { DOCS } from './platform';
import { getSettings } from './settings';
import { TunnelManager } from './tunnels/manager';
import { TunnelProcess } from './tunnels/process';
import { pickLocalUrl, pickRemoteTunnel, pickRunningTunnel } from './ui/pickers';
import { Node, ProcessNode, RemoteNode, TokenNode, TunnelTreeProvider } from './ui/tree';

const l10n = vscode.l10n;

export interface Services {
  binary: BinaryService;
  cli: CloudflaredCli;
  auth: AuthService;
  setup: SetupService;
  manager: TunnelManager;
  tree: TunnelTreeProvider;
}

export function registerCommands(context: vscode.ExtensionContext, s: Services): void {
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err) {
          getLog().error(`${id}: ${errorMessage(err)}`);
          const detail = err instanceof CliError ? err.message : errorMessage(err);
          const choice = await vscode.window.showErrorMessage(l10n.t('Cloudflared: {0}', detail), l10n.t('Show logs'));
          if (choice) { getLog().show(true); }
        }
      }),
    );

  reg('cloudflared.setup', () => s.setup.runWizard());
  reg('cloudflared.install', async () => { await s.binary.install(); await s.setup.refresh(true); });
  reg('cloudflared.login', async () => {
    if (!(await s.setup.ensureInstalled())) { return; }
    await s.auth.login();
    await s.setup.refresh();
  });
  reg('cloudflared.refresh', async () => { await s.setup.refresh(true); s.tree.refresh(); });
  reg('cloudflared.openDashboard', () => vscode.env.openExternal(vscode.Uri.parse(DOCS.dashboard)));
  reg('cloudflared.showLogs', (node?: unknown) => {
    const proc = procFromNode(node);
    if (proc) { proc.showLogs(); } else { getLog().show(true); }
  });

  // ---- quick tunnels ---------------------------------------------------------------------
  reg('cloudflared.exposePort', async (arg?: unknown) => {
    if (!(await s.setup.ensureInstalled())) { return; }
    const preset = typeof arg === 'string' ? arg : typeof arg === 'number' ? String(arg) : undefined;
    const localUrl = await pickLocalUrl({ title: l10n.t('Expose local port (quick tunnel)'), value: preset });
    if (!localUrl) { return; }
    const existing = s.manager.findQuickByLocalUrl(localUrl);
    if (existing?.publicUrl) {
      await announce(existing, s);
      return;
    }
    const proc = await s.manager.startQuick(localUrl);
    await waitAndAnnounce(proc, s);
  });

  // ---- named tunnels ---------------------------------------------------------------------
  reg('cloudflared.createTunnel', async () => {
    if (!(await s.setup.ensureLoggedIn(l10n.t('Named tunnels live on a domain you manage in Cloudflare, so you need to sign in first.')))) { return; }

    const name = await vscode.window.showInputBox({
      title: l10n.t('Create named tunnel (1/3): name'),
      prompt: l10n.t('A name to identify the tunnel, e.g. "my-laptop" or "shop-dev".'),
      placeHolder: 'my-app',
      ignoreFocusOut: true,
      validateInput: (v) => (isValidTunnelName(v) ? undefined : l10n.t('Use letters, numbers, spaces, dots, dashes or underscores.')),
    });
    if (!name) { return; }

    const hostname = await vscode.window.showInputBox({
      title: l10n.t('Create named tunnel (2/3): public hostname'),
      prompt: l10n.t('Subdomain of a domain in your Cloudflare account. A CNAME record is created for you. Leave empty to skip.'),
      placeHolder: 'app.example.com',
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() || isValidHostname(v) ? undefined : l10n.t('Enter a full hostname like app.example.com')),
    });
    if (hostname === undefined) { return; }

    const localUrl = await pickLocalUrl({ title: l10n.t('Create named tunnel (3/3): local service to expose') });
    if (!localUrl) { return; }

    const created = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: l10n.t('Creating tunnel "{0}"…', name) },
      async (progress) => {
        const { id, output } = await s.cli.createTunnel(name.trim());
        getLog().info(output.trim());
        if (!id) { throw new Error(l10n.t('Tunnel created but its id could not be read. Check the logs.')); }
        const tunnel: RemoteTunnel = { id, name: name.trim(), connections: 0, colos: [] };
        if (hostname.trim()) {
          progress.report({ message: l10n.t('routing {0}…', hostname.trim()) });
          try {
            getLog().info((await s.cli.routeDns(id, hostname.trim())).trim());
          } catch (err) {
            const msg = errorMessage(err);
            if (/already exists|record with that host/i.test(msg)) {
              const ow = await vscode.window.showWarningMessage(
                l10n.t('A DNS record for {0} already exists. Overwrite it to point to this tunnel?', hostname.trim()),
                { modal: true },
                l10n.t('Overwrite'),
              );
              if (ow) { getLog().info((await s.cli.routeDns(id, hostname.trim(), true)).trim()); } else { throw err; }
            } else {
              throw err;
            }
          }
        }
        await s.manager.setConfig(id, { localUrl, hostname: hostname.trim() || undefined, useConfigFile: false });
        return tunnel;
      },
    );
    s.tree.refresh();
    const proc = await s.manager.startNamed(created, s.manager.getConfig(created.id));
    await waitAndAnnounce(proc, s);
  });

  reg('cloudflared.runTunnel', async (node?: unknown) => {
    if (!(await s.setup.ensureLoggedIn())) { return; }
    const tunnel = node instanceof RemoteNode
      ? node.tunnel
      : await pickRemoteTunnel(s.cli, s.manager, { title: l10n.t('Start named tunnel'), filter: (t) => !s.manager.findByTunnelId(t.id) });
    if (!tunnel) { return; }
    const already = s.manager.findByTunnelId(tunnel.id);
    if (already?.isActive) {
      await announce(already, s);
      return;
    }
    let cfg = s.manager.getConfig(tunnel.id);
    if (!cfg.localUrl && !cfg.useConfigFile) {
      const ok = await askLocalUrl(tunnel, s);
      if (!ok) { return; }
      cfg = s.manager.getConfig(tunnel.id);
    }
    if (already) { s.manager.remove(already); }
    const proc = await s.manager.startNamed(tunnel, cfg);
    await waitAndAnnounce(proc, s);
  });

  reg('cloudflared.setLocalUrl', async (node?: unknown) => {
    const tunnel = node instanceof RemoteNode ? node.tunnel : await pickRemoteTunnel(s.cli, s.manager, { title: l10n.t('Set local service URL') });
    if (!tunnel) { return; }
    if (!(await askLocalUrl(tunnel, s))) { return; }
    const running = s.manager.findByTunnelId(tunnel.id);
    if (running?.isActive) {
      const choice = await vscode.window.showInformationMessage(l10n.t('Restart "{0}" to apply the new origin?', tunnel.name), l10n.t('Restart'));
      if (choice) {
        await s.manager.stop(running);
        const proc = await s.manager.startNamed(tunnel, s.manager.getConfig(tunnel.id));
        await waitAndAnnounce(proc, s);
      }
    }
  });

  reg('cloudflared.routeDns', async (node?: unknown) => {
    if (!(await s.setup.ensureLoggedIn())) { return; }
    const tunnel = node instanceof RemoteNode ? node.tunnel : await pickRemoteTunnel(s.cli, s.manager, { title: l10n.t('Route hostname to tunnel') });
    if (!tunnel) { return; }
    const current = s.manager.getConfig(tunnel.id).hostname;
    const hostname = await vscode.window.showInputBox({
      title: l10n.t('Route hostname to "{0}"', tunnel.name),
      prompt: l10n.t('Creates a CNAME record on your Cloudflare zone pointing to this tunnel.'),
      value: current,
      placeHolder: 'app.example.com',
      ignoreFocusOut: true,
      validateInput: (v) => (isValidHostname(v) ? undefined : l10n.t('Enter a full hostname like app.example.com')),
    });
    if (!hostname) { return; }
    try {
      const out = await s.cli.routeDns(tunnel.id, hostname.trim());
      getLog().info(out.trim());
    } catch (err) {
      if (!/already exists|record with that host/i.test(errorMessage(err))) { throw err; }
      const ow = await vscode.window.showWarningMessage(
        l10n.t('A DNS record for {0} already exists. Overwrite it to point to this tunnel?', hostname.trim()),
        { modal: true },
        l10n.t('Overwrite'),
      );
      if (!ow) { return; }
      getLog().info((await s.cli.routeDns(tunnel.id, hostname.trim(), true)).trim());
    }
    await s.manager.setConfig(tunnel.id, { hostname: hostname.trim() });
    void vscode.window.showInformationMessage(l10n.t('{0} now points to tunnel "{1}".', hostname.trim(), tunnel.name));
  });

  reg('cloudflared.deleteTunnel', async (node?: unknown) => {
    if (!(await s.setup.ensureLoggedIn())) { return; }
    const tunnel = node instanceof RemoteNode ? node.tunnel : await pickRemoteTunnel(s.cli, s.manager, { title: l10n.t('Delete named tunnel') });
    if (!tunnel) { return; }
    const running = s.manager.findByTunnelId(tunnel.id);
    if (running?.isActive) {
      void vscode.window.showWarningMessage(l10n.t('Stop the tunnel before deleting it.'));
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      l10n.t('Delete tunnel "{0}" from your Cloudflare account?', tunnel.name),
      { modal: true, detail: tunnel.connections ? l10n.t('It still has {0} active connection(s) from another machine; those will be dropped.', String(tunnel.connections)) : l10n.t('DNS records pointing to it are not removed automatically.') },
      l10n.t('Delete'),
    );
    if (!choice) { return; }
    await s.cli.deleteTunnel(tunnel.id, tunnel.connections > 0);
    await s.manager.forgetConfig(tunnel.id);
    s.tree.refresh();
    void vscode.window.showInformationMessage(l10n.t('Tunnel "{0}" deleted.', tunnel.name));
  });

  // ---- token tunnels ---------------------------------------------------------------------
  reg('cloudflared.runWithToken', async (node?: unknown) => {
    if (!(await s.setup.ensureInstalled())) { return; }
    let label: string | undefined;
    let token: string | undefined;
    if (node instanceof TokenNode) {
      label = node.label;
      token = await s.manager.getToken(label);
    }
    if (!token) {
      const saved = s.manager.getTokenLabels();
      if (!label && saved.length) {
        type Item = vscode.QuickPickItem & { label: string; isNew?: boolean };
        const items: Item[] = [
          ...saved.map((l) => ({ label: `$(key) ${l}`, value: l })).map((i) => ({ label: i.label, description: i.value })),
          { label: l10n.t('$(add) New token…'), isNew: true },
        ];
        const picked = await vscode.window.showQuickPick(items, { title: l10n.t('Run tunnel with token') });
        if (!picked) { return; }
        if (!picked.isNew) {
          label = picked.description!;
          token = await s.manager.getToken(label);
        }
      }
      if (!token) {
        token = await vscode.window.showInputBox({
          title: l10n.t('Tunnel token'),
          prompt: l10n.t('Paste the token from the Zero Trust dashboard (Networks → Tunnels → your tunnel → Install connector). It is stored in your OS keychain.'),
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim().length > 20 ? undefined : l10n.t('That does not look like a tunnel token.')),
        });
        if (!token) { return; }
        token = token.trim().replace(/^cloudflared.*--token\s+/, '');
        label = await vscode.window.showInputBox({
          title: l10n.t('Name for this token'),
          prompt: l10n.t('Only used to identify it in this extension.'),
          value: label ?? l10n.t('dashboard tunnel'),
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? undefined : l10n.t('Enter a name.')),
        });
        if (!label) { return; }
        label = label.trim();
        await s.manager.saveToken(label, token);
      }
    }
    const proc = await s.manager.startWithToken(token, label!);
    await waitAndAnnounce(proc, s);
  });

  // ---- lifecycle -------------------------------------------------------------------------
  reg('cloudflared.stopTunnel', async (node?: unknown) => {
    const proc = procFromNode(node) ?? (await pickRunningTunnel(s.manager, { title: l10n.t('Stop tunnel') }));
    if (!proc) { return; }
    await s.manager.stop(proc);
  });
  reg('cloudflared.restartTunnel', async (node?: unknown) => {
    const proc = procFromNode(node) ?? (await pickRunningTunnel(s.manager, { title: l10n.t('Restart tunnel') }));
    if (!proc) { return; }
    const fresh = await s.manager.restart(proc);
    await waitAndAnnounce(fresh, s);
  });
  reg('cloudflared.stopAll', async () => {
    const n = s.manager.active().length;
    await s.manager.stopAll();
    if (n) { void vscode.window.setStatusBarMessage(l10n.t('Stopped {0} tunnel(s)', String(n)), 3000); }
  });
  reg('cloudflared.copyUrl', async (node?: unknown) => {
    const url = await urlFromNode(node, s);
    if (!url) { return; }
    await vscode.env.clipboard.writeText(url);
    void vscode.window.setStatusBarMessage(l10n.t('Copied {0}', url), 3000);
  });
  reg('cloudflared.openInBrowser', async (node?: unknown) => {
    const url = await urlFromNode(node, s);
    if (url) { await vscode.env.openExternal(vscode.Uri.parse(url)); }
  });

  reg('cloudflared.statusMenu', async () => {
    type Item = vscode.QuickPickItem & { run?: () => unknown; proc?: TunnelProcess };
    const items: Item[] = [];
    for (const p of s.manager.all()) {
      items.push({
        label: `$(globe) ${p.spec.label}`,
        description: p.publicUrl,
        detail: p.state === 'error' ? `$(error) ${p.error}` : undefined,
        proc: p,
        buttons: [
          ...(p.publicUrl ? [
            { iconPath: new vscode.ThemeIcon('copy'), tooltip: l10n.t('Copy URL') },
            { iconPath: new vscode.ThemeIcon('link-external'), tooltip: l10n.t('Open') },
          ] : []),
          { iconPath: new vscode.ThemeIcon('output'), tooltip: l10n.t('Logs') },
          { iconPath: new vscode.ThemeIcon('debug-stop'), tooltip: l10n.t('Stop') },
        ],
        run: () => p.publicUrl ? vscode.env.clipboard.writeText(p.publicUrl).then(() => vscode.window.setStatusBarMessage(l10n.t('Copied {0}', p.publicUrl!), 3000)) : p.showLogs(),
      });
    }
    if (items.length) { items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }); }
    const status = s.setup.status;
    if (!status.binary) {
      items.push({ label: l10n.t('$(checklist) Set up cloudflared'), run: () => s.setup.runWizard() });
    } else {
      items.push({ label: l10n.t('$(globe) Expose local port…'), run: () => vscode.commands.executeCommand('cloudflared.exposePort') });
      items.push({ label: l10n.t('$(play) Start named tunnel…'), run: () => vscode.commands.executeCommand('cloudflared.runTunnel') });
      if (s.manager.active().length) {
        items.push({ label: l10n.t('$(stop-circle) Stop all tunnels'), run: () => vscode.commands.executeCommand('cloudflared.stopAll') });
      }
    }
    items.push({ label: l10n.t('$(list-tree) Show Tunnels view'), run: () => vscode.commands.executeCommand('cloudflared.tunnels.focus') });
    items.push({ label: l10n.t('$(output) Cloudflared logs'), run: () => getLog().show(true) });

    const qp = vscode.window.createQuickPick<Item>();
    qp.items = items;
    qp.title = status.binary ? l10n.t('Cloudflared {0}', status.binary.version ?? '') : 'Cloudflared';
    qp.onDidTriggerItemButton(async (e) => {
      const p = e.item.proc!;
      const tip = e.button.tooltip;
      if (tip === l10n.t('Copy URL') && p.publicUrl) { await vscode.env.clipboard.writeText(p.publicUrl); }
      else if (tip === l10n.t('Open') && p.publicUrl) { await vscode.env.openExternal(vscode.Uri.parse(p.publicUrl)); }
      else if (tip === l10n.t('Logs')) { p.showLogs(); }
      else if (tip === l10n.t('Stop')) { await s.manager.stop(p); }
      qp.hide();
    });
    qp.onDidAccept(async () => { const item = qp.selectedItems[0]; qp.hide(); await item?.run?.(); });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  });
}

function procFromNode(node: unknown): TunnelProcess | undefined {
  if (node instanceof ProcessNode) { return node.proc; }
  if (node instanceof RemoteNode || node instanceof TokenNode) { return node.proc; }
  if (node instanceof TunnelProcess) { return node; }
  return undefined;
}

async function urlFromNode(node: unknown, s: Services): Promise<string | undefined> {
  if (node instanceof RemoteNode) {
    const host = s.manager.getConfig(node.tunnel.id).hostname;
    if (host) { return `https://${host}`; }
  }
  const proc = procFromNode(node) ?? (await pickRunningTunnel(s.manager, { title: l10n.t('Which tunnel?'), withUrl: true }));
  if (!proc) { return undefined; }
  if (!proc.publicUrl) {
    void vscode.window.showInformationMessage(l10n.t('This tunnel has no public URL yet.'));
    return undefined;
  }
  return proc.publicUrl;
}

async function askLocalUrl(tunnel: RemoteTunnel, s: Services): Promise<boolean> {
  const current = s.manager.getConfig(tunnel.id);
  type Item = vscode.QuickPickItem & { mode: 'url' | 'config' };
  const items: Item[] = [
    { label: l10n.t('$(plug) Forward to a local service'), detail: l10n.t('Runs "cloudflared tunnel run --url <service>". Simplest option.'), mode: 'url' },
    { label: l10n.t('$(file-code) Use my cloudflared config file'), detail: l10n.t('Runs "cloudflared tunnel run" and relies on the ingress rules in ~/.cloudflared/config.yml.'), mode: 'config' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: l10n.t('How should "{0}" reach your service?', tunnel.name), ignoreFocusOut: true });
  if (!picked) { return false; }
  if (picked.mode === 'config') {
    await s.manager.setConfig(tunnel.id, { useConfigFile: true, localUrl: undefined });
    return true;
  }
  const url = await pickLocalUrl({ title: l10n.t('Local service for "{0}"', tunnel.name), value: current.localUrl });
  if (!url) { return false; }
  await s.manager.setConfig(tunnel.id, { localUrl: url, useConfigFile: false });
  return true;
}

async function waitAndAnnounce(proc: TunnelProcess, s: Services): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: l10n.t('Starting tunnel {0}…', proc.spec.label) },
    () => s.manager.waitUntilUp(proc),
  );
  if (proc.state === 'error') {
    const choice = await vscode.window.showErrorMessage(
      l10n.t('Tunnel "{0}" failed: {1}', proc.spec.label, proc.error ?? l10n.t('unknown error')),
      l10n.t('Show logs'),
      l10n.t('Retry'),
    );
    if (choice === l10n.t('Show logs')) { proc.showLogs(); }
    if (choice === l10n.t('Retry')) { await waitAndAnnounce(await s.manager.restart(proc), s); }
    return;
  }
  if (proc.state === 'starting') {
    void vscode.window.showWarningMessage(l10n.t('Tunnel "{0}" is taking longer than usual. Check the logs.', proc.spec.label), l10n.t('Show logs')).then((c) => c && proc.showLogs());
    return;
  }
  await announce(proc, s);
}

async function announce(proc: TunnelProcess, _s: Services): Promise<void> {
  const settings = getSettings();
  const url = proc.publicUrl;
  if (!url) {
    void vscode.window.showInformationMessage(l10n.t('Tunnel "{0}" is running.', proc.spec.label));
    return;
  }
  if (settings.copyUrlOnStart) { await vscode.env.clipboard.writeText(url); }
  if (settings.openBrowserOnStart) { void vscode.env.openExternal(vscode.Uri.parse(url)); }
  const headline = settings.copyUrlOnStart ? l10n.t('{0} → {1}  (copied)', proc.spec.label, url) : l10n.t('{0} → {1}', proc.spec.label, url);
  const hint = proc.spec.kind === 'quick' ? ' ' + l10n.t('DNS for new quick tunnels can take a minute or two to resolve.') : '';
  const choice = await vscode.window.showInformationMessage(
    headline + hint,
    l10n.t('Open'),
    l10n.t('Copy'),
    l10n.t('Stop'),
  );
  if (choice === l10n.t('Open')) { await vscode.env.openExternal(vscode.Uri.parse(url)); }
  if (choice === l10n.t('Copy')) { await vscode.env.clipboard.writeText(url); }
  if (choice === l10n.t('Stop')) { await _s.manager.stop(proc); }
}

export type { Node };
