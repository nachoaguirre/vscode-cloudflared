import * as vscode from 'vscode';
import { AuthService } from '../cloudflared/auth';
import { BinaryInfo, BinaryService } from '../cloudflared/binary';
import { getLog } from '../log';
import { DOCS } from '../platform';

const l10n = vscode.l10n;

export interface SetupStatus {
  checked: boolean;
  binary?: BinaryInfo;
  loggedIn: boolean;
}

/** Knows what is missing and walks the user through fixing it. */
export class SetupService implements vscode.Disposable {
  private _status: SetupStatus = { checked: false, loggedIn: false };
  private readonly emitter = new vscode.EventEmitter<SetupStatus>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly binary: BinaryService, private readonly auth: AuthService) {}

  get status(): SetupStatus {
    return this._status;
  }

  async refresh(force = false): Promise<SetupStatus> {
    const binary = await this.binary.locate(force);
    const loggedIn = binary ? await this.auth.isLoggedIn() : false;
    this._status = { checked: true, binary, loggedIn };
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'cloudflared.ready', true),
      vscode.commands.executeCommand('setContext', 'cloudflared.installed', !!binary),
      vscode.commands.executeCommand('setContext', 'cloudflared.loggedIn', loggedIn),
    ]);
    this.emitter.fire(this._status);
    return this._status;
  }

  /** Makes sure the binary exists, offering to install it. Undefined when the user bails out. */
  async ensureInstalled(): Promise<BinaryInfo | undefined> {
    const existing = await this.binary.locate();
    if (existing) { return existing; }
    const choice = await vscode.window.showInformationMessage(
      l10n.t('cloudflared is not installed on this machine. It is required to create tunnels. Install it now?'),
      { modal: true, detail: l10n.t('The extension can download the official binary for you, or use your package manager. Nothing else on your system is changed.') },
      l10n.t('Install cloudflared'),
    );
    if (choice !== l10n.t('Install cloudflared')) { return undefined; }
    const info = await this.binary.install();
    await this.refresh(true);
    return info;
  }

  /** Makes sure cert.pem exists, offering the login flow. */
  async ensureLoggedIn(reason?: string): Promise<boolean> {
    if (!(await this.ensureInstalled())) { return false; }
    if (await this.auth.isLoggedIn()) {
      if (!this._status.loggedIn) { await this.refresh(); }
      return true;
    }
    const choice = await vscode.window.showInformationMessage(
      reason ?? l10n.t('This action needs a Cloudflare account. Sign in now?'),
      {
        modal: true,
        detail: l10n.t('Your browser will open the Cloudflare dashboard. Choose the domain you want to use for tunnels; the certificate is stored locally in {0}.', this.auth.certPath()),
      },
      l10n.t('Sign in'),
      l10n.t('Create a free account'),
    );
    if (choice === l10n.t('Create a free account')) {
      await vscode.env.openExternal(vscode.Uri.parse(DOCS.signup));
      return false;
    }
    if (choice !== l10n.t('Sign in')) { return false; }
    const ok = await this.auth.login();
    await this.refresh();
    return ok;
  }

  /** Interactive checklist: shows what is done and lets the user run the next step. */
  async runWizard(): Promise<void> {
    const status = await this.refresh(true);
    type Item = vscode.QuickPickItem & { action?: 'install' | 'login' | 'expose' | 'create' | 'walkthrough' | 'docs' };
    const done = (label: string, detail: string): Item => ({ label: `$(pass-filled) ${label}`, detail, alwaysShow: true });
    const todo = (label: string, detail: string, action: Item['action']): Item => ({ label: `$(circle-large-outline) ${label}`, detail, action, alwaysShow: true });

    const items: Item[] = [];
    items.push(
      status.binary
        ? { ...done(l10n.t('cloudflared {0} installed', status.binary.version ?? ''), status.binary.path), action: 'install' }
        : todo(l10n.t('Install cloudflared'), l10n.t('Download the connector binary. Takes a few seconds.'), 'install'),
    );
    items.push(
      todo(
        l10n.t('Expose a local port (quick tunnel)'),
        l10n.t('Temporary public HTTPS URL for a local port. No account needed.'),
        status.binary ? 'expose' : undefined,
      ),
    );
    items.push(
      status.loggedIn
        ? { ...done(l10n.t('Signed in to Cloudflare'), this.auth.certPath()), action: 'login' }
        : todo(l10n.t('Sign in to Cloudflare (optional)'), l10n.t('Needed only for permanent tunnels on your own domain.'), status.binary ? 'login' : undefined),
    );
    items.push(
      todo(
        l10n.t('Create a named tunnel on your domain'),
        l10n.t('Creates the tunnel, routes a hostname and starts it.'),
        status.loggedIn ? 'create' : undefined,
      ),
    );
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: l10n.t('$(book) Open the step-by-step walkthrough'), action: 'walkthrough' });
    items.push({ label: l10n.t('$(link-external) Cloudflare Tunnel documentation'), action: 'docs' });

    const nextTodo = items.find((i) => i.action && i.label.startsWith('$(circle-large-outline)'));
    const picked = await vscode.window.showQuickPick(items, {
      title: l10n.t('Cloudflare Tunnel setup'),
      placeHolder: nextTodo ? l10n.t('Next step: {0}', nextTodo.label.replace(/^\$\([^)]+\)\s*/, '')) : l10n.t('Everything is set up. Pick an action.'),
      ignoreFocusOut: true,
    });
    if (!picked?.action) {
      if (picked && !picked.action) {
        void vscode.window.showInformationMessage(l10n.t('Complete the previous steps first.'));
      }
      return;
    }
    switch (picked.action) {
      case 'install':
        await this.binary.install();
        await this.refresh(true);
        return this.runWizard();
      case 'login':
        await this.auth.login();
        await this.refresh();
        return this.runWizard();
      case 'expose':
        await vscode.commands.executeCommand('cloudflared.exposePort');
        return;
      case 'create':
        await vscode.commands.executeCommand('cloudflared.createTunnel');
        return;
      case 'walkthrough':
        await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'nachoaguirre.vscode-cloudflared#cloudflared.gettingStarted', false);
        return;
      case 'docs':
        await vscode.env.openExternal(vscode.Uri.parse(DOCS.namedTunnels));
        return;
    }
  }

  /** First-run nudge: only once, only when nothing is installed. */
  async maybeShowFirstRunHint(context: vscode.ExtensionContext): Promise<void> {
    const KEY = 'cloudflared.firstRunHintShown';
    if (context.globalState.get<boolean>(KEY)) { return; }
    const status = this._status.checked ? this._status : await this.refresh();
    if (status.binary) {
      await context.globalState.update(KEY, true);
      return;
    }
    await context.globalState.update(KEY, true);
    const choice = await vscode.window.showInformationMessage(
      l10n.t('Cloudflare Tunnel: cloudflared is not installed yet. Want a guided setup?'),
      l10n.t('Get started'),
      l10n.t('Later'),
    );
    if (choice === l10n.t('Get started')) {
      getLog().info('First-run wizard started');
      await this.runWizard();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
