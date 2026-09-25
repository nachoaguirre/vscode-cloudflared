import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'node:child_process';
import { classifyLogLine, isConnectionRegistered, logMessage, parseQuickTunnelUrl } from '../cloudflared/parse';
import { getLog } from '../log';

export type TunnelKind = 'quick' | 'named' | 'token';
export type TunnelState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface TunnelSpec {
  kind: TunnelKind;
  /** Human label, e.g. "localhost:3000" or the tunnel name. */
  label: string;
  args: string[];
  /** Local origin being exposed, when known. */
  localUrl?: string;
  /** Remote tunnel id/name for named tunnels. */
  tunnelId?: string;
  tunnelName?: string;
  /** Public hostname for named tunnels, when known. */
  hostname?: string;
}

let counter = 0;

/** One running `cloudflared tunnel …` child process with its own output channel. */
export class TunnelProcess implements vscode.Disposable {
  readonly id = `tunnel-${++counter}-${Date.now()}`;
  readonly channel: vscode.OutputChannel;
  readonly startedAt = new Date();

  private _state: TunnelState = 'starting';
  private _publicUrl: string | undefined;
  private _error: string | undefined;
  private _connections = 0;
  private child: ChildProcess | undefined;
  private stdoutRest = '';
  private stderrRest = '';
  private readonly lastLines: string[] = [];
  private readonly emitter = new vscode.EventEmitter<TunnelProcess>();
  readonly onDidChange = this.emitter.event;
  private readonly exitEmitter = new vscode.EventEmitter<{ code: number | null; signal: NodeJS.Signals | null }>();
  readonly onDidExit = this.exitEmitter.event;

  constructor(readonly spec: TunnelSpec, private readonly binPath: string) {
    this.channel = vscode.window.createOutputChannel(`Cloudflared: ${spec.label}`);
    if (spec.hostname) {
      this._publicUrl = `https://${spec.hostname}`;
    }
  }

  get state(): TunnelState { return this._state; }
  get publicUrl(): string | undefined { return this._publicUrl; }
  get error(): string | undefined { return this._error; }
  get connections(): number { return this._connections; }
  get isActive(): boolean { return this._state === 'starting' || this._state === 'running'; }
  get pid(): number | undefined { return this.child?.pid; }

  start(): void {
    const log = getLog();
    const printable = this.spec.args.map((a, i, arr) => (arr[i - 1] === '--token' ? '<redacted>' : a));
    log.info(`[${this.spec.label}] starting: ${this.binPath} ${printable.join(' ')}`);
    this.channel.appendLine(`$ cloudflared ${printable.join(' ')}`);
    try {
      this.child = spawn(this.binPath, this.spec.args, {
        env: { ...process.env, NO_COLOR: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    this.child.stdout?.on('data', (d: Buffer) => { this.stdoutRest = this.consume(this.stdoutRest + d.toString()); });
    this.child.stderr?.on('data', (d: Buffer) => { this.stderrRest = this.consume(this.stderrRest + d.toString()); });
    this.child.on('error', (err) => this.fail(err.message));
    this.child.on('exit', (code, signal) => {
      this.consume(this.stdoutRest + '\n');
      this.consume(this.stderrRest + '\n');
      log.info(`[${this.spec.label}] exited code=${code} signal=${signal}`);
      this.channel.appendLine(`--- process exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}) ---`);
      if (this._state === 'stopping' || (code === 0 && this._state !== 'starting')) {
        this.setState('stopped');
      } else if (this._state !== 'error') {
        this._error = this._error ?? this.lastErrorLine() ?? vscode.l10n.t('cloudflared exited unexpectedly (code {0})', String(code));
        this.setState('error');
      }
      this.exitEmitter.fire({ code, signal });
    });
  }

  /** Processes complete lines, returns the trailing partial line. */
  private consume(buffer: string): string {
    const lines = buffer.split(/\r?\n/);
    const rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) { continue; }
      this.channel.appendLine(line);
      this.lastLines.push(line);
      if (this.lastLines.length > 50) { this.lastLines.shift(); }
      this.handleLine(line);
    }
    return rest;
  }

  private handleLine(line: string): void {
    if (this.spec.kind === 'quick' && !this._publicUrl) {
      const url = parseQuickTunnelUrl(line);
      if (url) {
        this._publicUrl = url;
        this.setState('running');
        return;
      }
    }
    if (isConnectionRegistered(line)) {
      this._connections++;
      if (this._state === 'starting') { this.setState('running'); } else { this.emitter.fire(this); }
      return;
    }
    if (/Unregistered tunnel connection|Connection terminated/.test(line) && this._connections > 0) {
      this._connections--;
      this.emitter.fire(this);
      return;
    }
    const level = classifyLogLine(line);
    if (level === 'error' && this._state === 'starting') {
      // Fatal errors during startup: keep the first one as the headline.
      this._error = this._error ?? logMessage(line);
    }
  }

  private lastErrorLine(): string | undefined {
    const line = [...this.lastLines].reverse().find((l) => classifyLogLine(l) === 'error');
    return line ? logMessage(line) : undefined;
  }

  private fail(message: string): void {
    this._error = message;
    this.channel.appendLine(`!!! ${message}`);
    getLog().error(`[${this.spec.label}] ${message}`);
    this.setState('error');
  }

  private setState(state: TunnelState): void {
    if (this._state === state) { return; }
    this._state = state;
    this.emitter.fire(this);
  }

  async stop(): Promise<void> {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
      if (this.isActive) { this.setState('stopped'); }
      return;
    }
    this.setState('stopping');
    const child = this.child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        getLog().warn(`[${this.spec.label}] did not exit after SIGTERM, killing`);
        child.kill('SIGKILL');
      }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }

  showLogs(): void {
    this.channel.show(true);
  }

  dispose(): void {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
    }
    this.channel.dispose();
    this.emitter.dispose();
    this.exitEmitter.dispose();
  }
}
