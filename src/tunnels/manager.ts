import * as vscode from 'vscode';
import { BinaryService } from '../cloudflared/binary';
import { getSettings } from '../settings';
import { TunnelProcess, TunnelSpec } from './process';

export interface NamedTunnelConfig {
  /** Local origin to forward to; undefined means "use cloudflared config file". */
  localUrl?: string;
  /** Public hostname routed to this tunnel via DNS. */
  hostname?: string;
  useConfigFile?: boolean;
}

const CONFIG_KEY = 'cloudflared.namedTunnelConfig';
const TOKEN_LABELS_KEY = 'cloudflared.tokenTunnelLabels';

/** Owns every tunnel process started by this window and the per-tunnel preferences. */
export class TunnelManager implements vscode.Disposable {
  private readonly processes: TunnelProcess[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly startedEmitter = new vscode.EventEmitter<TunnelProcess>();
  /** Fires once per process when it first reaches the running state. */
  readonly onDidStart = this.startedEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly binary: BinaryService) {}

  all(): readonly TunnelProcess[] {
    return this.processes;
  }

  active(): TunnelProcess[] {
    return this.processes.filter((p) => p.isActive);
  }

  findByTunnelId(id: string): TunnelProcess | undefined {
    return this.processes.find((p) => p.spec.tunnelId === id && p.state !== 'stopped');
  }

  findQuickByLocalUrl(localUrl: string): TunnelProcess | undefined {
    return this.processes.find((p) => p.spec.kind === 'quick' && p.spec.localUrl === localUrl && p.isActive);
  }

  async startQuick(localUrl: string): Promise<TunnelProcess> {
    const label = localUrl.replace(/^https?:\/\//, '');
    return this.launch({ kind: 'quick', label, localUrl, args: ['tunnel', ...this.baseArgs(), '--url', localUrl] });
  }

  async startNamed(tunnel: { id: string; name: string }, config: NamedTunnelConfig): Promise<TunnelProcess> {
    const args = ['tunnel', ...this.baseArgs(), 'run'];
    if (!config.useConfigFile && config.localUrl) {
      args.push('--url', config.localUrl);
    }
    args.push(tunnel.id);
    return this.launch({
      kind: 'named',
      label: tunnel.name,
      localUrl: config.useConfigFile ? undefined : config.localUrl,
      tunnelId: tunnel.id,
      tunnelName: tunnel.name,
      hostname: config.hostname,
      args,
    });
  }

  async startWithToken(token: string, label: string): Promise<TunnelProcess> {
    return this.launch({ kind: 'token', label, args: ['tunnel', ...this.baseArgs(), 'run', '--token', token] });
  }

  private baseArgs(): string[] {
    return ['--no-autoupdate', ...getSettings().extraArgs];
  }

  private async launch(spec: TunnelSpec): Promise<TunnelProcess> {
    const bin = await this.binary.require();
    const proc = new TunnelProcess(spec, bin.path);
    this.processes.push(proc);
    let announced = false;
    proc.onDidChange(() => {
      if (!announced && proc.state === 'running') {
        announced = true;
        this.startedEmitter.fire(proc);
      }
      this.emitter.fire();
    });
    proc.onDidExit(() => {
      if (proc.state === 'stopped') {
        this.remove(proc);
      }
    });
    proc.start();
    this.emitter.fire();
    return proc;
  }

  /** Resolves when the process is running or has failed. */
  waitUntilUp(proc: TunnelProcess, timeoutMs = 60_000): Promise<TunnelProcess> {
    if (proc.state !== 'starting') { return Promise.resolve(proc); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { sub.dispose(); resolve(proc); }, timeoutMs);
      const sub = proc.onDidChange(() => {
        if (proc.state !== 'starting') {
          clearTimeout(timer);
          sub.dispose();
          resolve(proc);
        }
      });
    });
  }

  async stop(proc: TunnelProcess): Promise<void> {
    await proc.stop();
    this.remove(proc);
  }

  async restart(proc: TunnelProcess): Promise<TunnelProcess> {
    await this.stop(proc);
    return this.launch(proc.spec);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes].map((p) => this.stop(p)));
  }

  remove(proc: TunnelProcess): void {
    const idx = this.processes.indexOf(proc);
    if (idx >= 0) {
      this.processes.splice(idx, 1);
      proc.dispose();
      this.emitter.fire();
    }
  }

  // ---- persisted per-tunnel preferences -------------------------------------------------

  getConfig(tunnelId: string): NamedTunnelConfig {
    const all = this.context.globalState.get<Record<string, NamedTunnelConfig>>(CONFIG_KEY) ?? {};
    return all[tunnelId] ?? {};
  }

  async setConfig(tunnelId: string, patch: NamedTunnelConfig): Promise<void> {
    const all = { ...(this.context.globalState.get<Record<string, NamedTunnelConfig>>(CONFIG_KEY) ?? {}) };
    all[tunnelId] = { ...all[tunnelId], ...patch };
    await this.context.globalState.update(CONFIG_KEY, all);
    this.emitter.fire();
  }

  async forgetConfig(tunnelId: string): Promise<void> {
    const all = { ...(this.context.globalState.get<Record<string, NamedTunnelConfig>>(CONFIG_KEY) ?? {}) };
    delete all[tunnelId];
    await this.context.globalState.update(CONFIG_KEY, all);
  }

  /** Labels of token tunnels stored in SecretStorage, so they can be re-run. */
  getTokenLabels(): string[] {
    return this.context.globalState.get<string[]>(TOKEN_LABELS_KEY) ?? [];
  }

  async saveToken(label: string, token: string): Promise<void> {
    await this.context.secrets.store(`cloudflared.token.${label}`, token);
    const labels = new Set(this.getTokenLabels());
    labels.add(label);
    await this.context.globalState.update(TOKEN_LABELS_KEY, [...labels]);
  }

  async getToken(label: string): Promise<string | undefined> {
    return this.context.secrets.get(`cloudflared.token.${label}`);
  }

  async deleteToken(label: string): Promise<void> {
    await this.context.secrets.delete(`cloudflared.token.${label}`);
    await this.context.globalState.update(TOKEN_LABELS_KEY, this.getTokenLabels().filter((l) => l !== label));
    this.emitter.fire();
  }

  dispose(): void {
    if (getSettings().stopTunnelsOnExit) {
      for (const p of this.processes) { p.dispose(); }
    }
    this.emitter.dispose();
    this.startedEmitter.dispose();
  }
}
