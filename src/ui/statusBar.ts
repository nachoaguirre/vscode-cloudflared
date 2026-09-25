import * as vscode from 'vscode';
import { SetupService } from '../onboarding/setup';
import { getSettings } from '../settings';
import { TunnelManager } from '../tunnels/manager';

const l10n = vscode.l10n;

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly setup: SetupService, private readonly manager: TunnelManager) {
    this.item = vscode.window.createStatusBarItem('cloudflared.status', vscode.StatusBarAlignment.Left, 40);
    this.item.name = 'Cloudflared';
    this.item.command = 'cloudflared.statusMenu';
    this.subs.push(
      manager.onDidChange(() => this.update()),
      setup.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('cloudflared.showStatusBar')) { this.update(); } }),
    );
    this.update();
  }

  update(): void {
    if (!getSettings().showStatusBar) {
      this.item.hide();
      return;
    }
    const status = this.setup.status;
    const procs = this.manager.all();
    const starting = procs.filter((p) => p.state === 'starting').length;
    const running = procs.filter((p) => p.state === 'running').length;
    const failed = procs.filter((p) => p.state === 'error').length;

    this.item.backgroundColor = undefined;
    if (status.checked && !status.binary) {
      this.item.text = l10n.t('$(cloud) Set up cloudflared');
      this.item.tooltip = l10n.t('cloudflared is not installed. Click for a guided setup.');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (starting) {
      this.item.text = l10n.t('$(sync~spin) {0} tunnel(s) starting', String(starting + running));
      this.item.tooltip = l10n.t('Waiting for Cloudflare to assign a URL…');
    } else if (running) {
      const urls = procs.filter((p) => p.publicUrl && p.state === 'running').map((p) => p.publicUrl).join('\n');
      this.item.text = l10n.t('$(cloud) {0} tunnel(s)', String(running));
      this.item.tooltip = urls || l10n.t('{0} tunnel(s) running', String(running));
      if (failed) { this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); }
    } else if (failed) {
      this.item.text = l10n.t('$(cloud) tunnel failed');
      this.item.tooltip = l10n.t('A tunnel failed to start. Click to see details.');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.item.text = '$(cloud) Cloudflared';
      this.item.tooltip = status.binary
        ? l10n.t('cloudflared {0} · click to expose a port', status.binary.version ?? '')
        : l10n.t('Checking cloudflared…');
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
    for (const s of this.subs) { s.dispose(); }
  }
}
