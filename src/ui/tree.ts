import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { CloudflaredCli } from '../cloudflared/cli';
import { RemoteTunnel } from '../cloudflared/parse';
import { errorMessage, getLog } from '../log';
import { SetupService } from '../onboarding/setup';
import { credentialsPath } from '../platform';
import { TunnelManager } from '../tunnels/manager';
import { TunnelProcess } from '../tunnels/process';

const l10n = vscode.l10n;

export type Node = GroupNode | ProcessNode | RemoteNode | TokenNode | InfoNode;

export class GroupNode {
  readonly type = 'group';
  constructor(readonly id: 'quick' | 'named' | 'token', readonly label: string) {}
}
export class ProcessNode {
  readonly type = 'process';
  constructor(readonly proc: TunnelProcess) {}
}
export class RemoteNode {
  readonly type = 'remote';
  constructor(readonly tunnel: RemoteTunnel, readonly proc: TunnelProcess | undefined, readonly hasCredentials: boolean) {}
}
export class TokenNode {
  readonly type = 'token';
  constructor(readonly label: string, readonly proc: TunnelProcess | undefined) {}
}
export class InfoNode {
  readonly type = 'info';
  constructor(readonly label: string, readonly command?: vscode.Command, readonly icon?: string, readonly description?: string) {}
}

export class TunnelTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private remoteCache: RemoteTunnel[] | undefined;
  private remoteError: string | undefined;
  private loading: Promise<RemoteTunnel[]> | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly setup: SetupService,
    private readonly manager: TunnelManager,
    private readonly cli: CloudflaredCli,
  ) {
    this.subs.push(
      manager.onDidChange(() => this.emitter.fire(undefined)),
      setup.onDidChange(() => { this.remoteCache = undefined; this.emitter.fire(undefined); }),
    );
  }

  refresh(): void {
    this.remoteCache = undefined;
    this.remoteError = undefined;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'group': return this.groupItem(node);
      case 'process': return this.processItem(node);
      case 'remote': return this.remoteItem(node);
      case 'token': return this.tokenItem(node);
      case 'info': {
        const item = new vscode.TreeItem(node.label);
        item.command = node.command;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info');
        item.contextValue = 'info';
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const status = this.setup.status;
    if (!node) {
      if (!status.checked || !status.binary) { return []; }
      const groups: Node[] = [
        new GroupNode('quick', l10n.t('Quick tunnels')),
        new GroupNode('named', l10n.t('Named tunnels')),
      ];
      if (this.manager.getTokenLabels().length || this.manager.all().some((p) => p.spec.kind === 'token')) {
        groups.push(new GroupNode('token', l10n.t('Token tunnels')));
      }
      return groups;
    }
    if (node.type !== 'group') { return []; }
    switch (node.id) {
      case 'quick': {
        const procs = this.manager.all().filter((p) => p.spec.kind === 'quick');
        if (!procs.length) {
          return [new InfoNode(l10n.t('Expose a local port…'), { command: 'cloudflared.exposePort', title: '' }, 'add', l10n.t('no account needed'))];
        }
        return procs.map((p) => new ProcessNode(p));
      }
      case 'named': return this.namedChildren();
      case 'token': {
        const running = this.manager.all().filter((p) => p.spec.kind === 'token');
        const labels = new Set([...this.manager.getTokenLabels(), ...running.map((p) => p.spec.label)]);
        return [...labels].sort().map((label) => new TokenNode(label, running.find((p) => p.spec.label === label)));
      }
    }
  }

  private async namedChildren(): Promise<Node[]> {
    if (!this.setup.status.loggedIn) {
      return [
        new InfoNode(l10n.t('Sign in to Cloudflare…'), { command: 'cloudflared.login', title: '' }, 'sign-in', l10n.t('for tunnels on your domain')),
      ];
    }
    try {
      const tunnels = await this.loadRemote();
      if (!tunnels.length) {
        return [new InfoNode(l10n.t('Create a named tunnel…'), { command: 'cloudflared.createTunnel', title: '' }, 'add')];
      }
      return tunnels.map((t) => new RemoteNode(t, this.manager.findByTunnelId(t.id), fs.existsSync(credentialsPath(t.id))));
    } catch (err) {
      this.remoteError = errorMessage(err);
      getLog().error(`tunnel list failed: ${this.remoteError}`);
      return [
        new InfoNode(l10n.t('Could not list tunnels'), { command: 'cloudflared.refresh', title: '' }, 'warning', this.remoteError),
        new InfoNode(l10n.t('Sign in again…'), { command: 'cloudflared.login', title: '' }, 'sign-in'),
      ];
    }
  }

  private loadRemote(): Promise<RemoteTunnel[]> {
    if (this.remoteCache) { return Promise.resolve(this.remoteCache); }
    if (!this.loading) {
      this.loading = this.cli.listTunnels()
        .then((t) => { this.remoteCache = t; return t; })
        .finally(() => { this.loading = undefined; });
    }
    return this.loading;
  }

  private groupItem(node: GroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `group:${node.id}`;
    item.contextValue = `group:${node.id}`;
    const count = this.manager.all().filter((p) => p.spec.kind === node.id && p.isActive).length;
    if (count) { item.description = l10n.t('{0} active', String(count)); }
    return item;
  }

  private processItem(node: ProcessNode): vscode.TreeItem {
    const p = node.proc;
    const item = new vscode.TreeItem(p.spec.label);
    item.id = p.id;
    item.iconPath = stateIcon(p);
    item.description = p.publicUrl ?? (p.state === 'error' ? l10n.t('failed') : stateLabel(p.state));
    item.tooltip = tooltipFor(p);
    item.contextValue = contextFor(p, 'process');
    if (p.publicUrl && p.state === 'running') {
      item.command = { command: 'cloudflared.copyUrl', title: '', arguments: [node] };
    }
    return item;
  }

  private remoteItem(node: RemoteNode): vscode.TreeItem {
    const { tunnel, proc } = node;
    const cfg = this.manager.getConfig(tunnel.id);
    const item = new vscode.TreeItem(tunnel.name);
    item.id = `remote:${tunnel.id}`;
    const parts: string[] = [];
    if (cfg.hostname) { parts.push(cfg.hostname); }
    if (proc) {
      parts.push(proc.state === 'error' ? l10n.t('failed') : stateLabel(proc.state));
    } else if (tunnel.connections) {
      parts.push(l10n.t('connected elsewhere'));
    } else if (!node.hasCredentials) {
      parts.push(l10n.t('no credentials here'));
    }
    item.description = parts.join(' · ');
    item.iconPath = proc ? stateIcon(proc) : tunnel.connections
      ? new vscode.ThemeIcon('cloud', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('cloud', new vscode.ThemeColor('disabledForeground'));
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${tunnel.name}**  \n\`${tunnel.id}\`\n\n`);
    if (cfg.hostname) { md.appendMarkdown(`${l10n.t('Hostname')}: https://${cfg.hostname}  \n`); }
    if (cfg.useConfigFile) { md.appendMarkdown(`${l10n.t('Origin')}: ${l10n.t('cloudflared config file')}  \n`); }
    else if (cfg.localUrl) { md.appendMarkdown(`${l10n.t('Origin')}: ${cfg.localUrl}  \n`); }
    md.appendMarkdown(`${l10n.t('Edge connections')}: ${proc ? proc.connections : tunnel.connections}${tunnel.colos.length ? ` (${tunnel.colos.join(', ')})` : ''}  \n`);
    if (!node.hasCredentials) { md.appendMarkdown(`\n$(warning) ${l10n.t('No credentials file for this tunnel on this machine. Run it with a token or create the tunnel here.')}`); }
    if (proc?.error) { md.appendMarkdown(`\n$(error) ${proc.error}`); }
    md.supportThemeIcons = true;
    item.tooltip = md;
    const tokens = ['named'];
    if (proc) { tokens.push('process'); if (proc.isActive) { tokens.push('active'); } if (proc.state === 'error') { tokens.push('error'); } }
    if (cfg.hostname) { tokens.push('hasUrl'); }
    if (node.hasCredentials) { tokens.push('hasCreds'); }
    item.contextValue = tokens.join(':');
    return item;
  }

  private tokenItem(node: TokenNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label);
    item.id = `token:${node.label}`;
    item.iconPath = node.proc ? stateIcon(node.proc) : new vscode.ThemeIcon('key');
    item.description = node.proc ? stateLabel(node.proc.state) : l10n.t('saved token');
    const tokens = ['token'];
    if (node.proc) { tokens.push('process'); if (node.proc.isActive) { tokens.push('active'); } if (node.proc.state === 'error') { tokens.push('error'); } }
    item.contextValue = tokens.join(':');
    if (!node.proc) {
      item.command = { command: 'cloudflared.runWithToken', title: '', arguments: [node] };
    }
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
    for (const s of this.subs) { s.dispose(); }
  }
}

function contextFor(p: TunnelProcess, base: string): string {
  const tokens = [base, p.spec.kind];
  if (p.isActive) { tokens.push('active'); }
  if (p.state === 'error') { tokens.push('error'); }
  if (p.publicUrl) { tokens.push('hasUrl'); }
  return tokens.join(':');
}

function stateIcon(p: TunnelProcess): vscode.ThemeIcon {
  switch (p.state) {
    case 'starting': return new vscode.ThemeIcon('sync~spin');
    case 'running': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
    case 'stopping': return new vscode.ThemeIcon('sync~spin');
    case 'error': return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'stopped': return new vscode.ThemeIcon('circle-outline');
  }
}

function stateLabel(state: TunnelProcess['state']): string {
  switch (state) {
    case 'starting': return l10n.t('starting…');
    case 'running': return l10n.t('running');
    case 'stopping': return l10n.t('stopping…');
    case 'error': return l10n.t('error');
    case 'stopped': return l10n.t('stopped');
  }
}

function tooltipFor(p: TunnelProcess): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${p.spec.label}**  \n`);
  if (p.publicUrl) { md.appendMarkdown(`${p.publicUrl}  \n`); }
  if (p.spec.localUrl) { md.appendMarkdown(`${l10n.t('Origin')}: ${p.spec.localUrl}  \n`); }
  md.appendMarkdown(`${l10n.t('State')}: ${stateLabel(p.state)}  \n`);
  md.appendMarkdown(`${l10n.t('Edge connections')}: ${p.connections}  \n`);
  md.appendMarkdown(`${l10n.t('Started')}: ${p.startedAt.toLocaleTimeString()}  \n`);
  if (p.error) { md.appendMarkdown(`\n$(error) ${p.error}`); md.supportThemeIcons = true; }
  return md;
}
