import * as vscode from 'vscode';
import { CloudflaredCli } from '../cloudflared/cli';
import { RemoteTunnel, normalizeLocalUrl } from '../cloudflared/parse';
import { detectListeningPorts, rankPorts } from '../ports';
import { TunnelManager } from '../tunnels/manager';
import { TunnelProcess } from '../tunnels/process';

const l10n = vscode.l10n;

/** Asks for a local origin, suggesting ports currently listening on this machine. */
export async function pickLocalUrl(opts: { title: string; value?: string } ): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { url?: string; manual?: boolean };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = opts.title;
  qp.placeholder = l10n.t('Pick a detected port, or type a port, host:port or full URL (e.g. 3000, myapp.test, https://localhost:8443)');
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;
  qp.busy = true;
  qp.value = opts.value ?? '';

  const manualItem = (value: string): Item[] => {
    const url = normalizeLocalUrl(value);
    return url ? [{ label: `$(arrow-right) ${url}`, description: l10n.t('use this'), url, alwaysShow: true }] : [];
  };
  let detected: Item[] = [];
  const render = () => {
    qp.items = [...manualItem(qp.value), ...detected];
  };
  render();
  qp.show();

  void detectListeningPorts().then((ports) => {
    detected = rankPorts(ports).map((p) => ({
      label: `$(plug) localhost:${p.port}`,
      description: p.process ? p.process : undefined,
      detail: p.address && p.address !== '*' && !p.address.startsWith('127.') && p.address !== '[::1]' ? p.address : undefined,
      url: `http://localhost:${p.port}`,
    }));
    if (detected.length) {
      detected.unshift({ label: l10n.t('Listening on this machine'), kind: vscode.QuickPickItemKind.Separator });
    }
    qp.busy = false;
    render();
  }).catch(() => { qp.busy = false; });

  return new Promise<string | undefined>((resolve) => {
    qp.onDidChangeValue(render);
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      const url = item?.url ?? normalizeLocalUrl(qp.value);
      if (!url) {
        qp.placeholder = l10n.t('Enter a port number, host:port or URL.');
        return;
      }
      resolve(url);
      qp.hide();
    });
    qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
  });
}

export async function pickRemoteTunnel(
  cli: CloudflaredCli,
  manager: TunnelManager,
  opts: { title: string; filter?: (t: RemoteTunnel) => boolean },
): Promise<RemoteTunnel | undefined> {
  type Item = vscode.QuickPickItem & { tunnel: RemoteTunnel };
  const tunnels = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: l10n.t('Loading tunnels…') },
    () => cli.listTunnels(),
  );
  const filtered = opts.filter ? tunnels.filter(opts.filter) : tunnels;
  if (!filtered.length) {
    const choice = await vscode.window.showInformationMessage(
      l10n.t('No named tunnels found on this account. Create one?'),
      l10n.t('Create tunnel'),
    );
    if (choice) { await vscode.commands.executeCommand('cloudflared.createTunnel'); }
    return undefined;
  }
  const items: Item[] = filtered.map((t) => {
    const cfg = manager.getConfig(t.id);
    const running = manager.findByTunnelId(t.id);
    return {
      label: `$(cloud) ${t.name}`,
      description: [cfg.hostname, cfg.localUrl && `→ ${cfg.localUrl}`].filter(Boolean).join('  '),
      detail: running ? l10n.t('running in this window') : t.connections ? l10n.t('{0} connection(s) from elsewhere', String(t.connections)) : t.id,
      tunnel: t,
    };
  });
  const picked = await vscode.window.showQuickPick(items, { title: opts.title, placeHolder: l10n.t('Select a tunnel'), matchOnDescription: true });
  return picked?.tunnel;
}

export async function pickRunningTunnel(manager: TunnelManager, opts: { title: string; withUrl?: boolean }): Promise<TunnelProcess | undefined> {
  const candidates = manager.all().filter((p) => (opts.withUrl ? !!p.publicUrl : p.state !== 'stopped'));
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(l10n.t('No tunnels are running in this window.'));
    return undefined;
  }
  if (candidates.length === 1) { return candidates[0]; }
  type Item = vscode.QuickPickItem & { proc: TunnelProcess };
  const items: Item[] = candidates.map((p) => ({
    label: `$(globe) ${p.spec.label}`,
    description: p.publicUrl,
    detail: p.state,
    proc: p,
  }));
  const picked = await vscode.window.showQuickPick(items, { title: opts.title });
  return picked?.proc;
}
