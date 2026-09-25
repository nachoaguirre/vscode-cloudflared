import { execFile } from 'node:child_process';
import { getLog } from '../log';
import { BinaryService } from './binary';
import { parseCreatedTunnelId, parseTunnelList, RemoteTunnel } from './parse';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class CliError extends Error {
  constructor(message: string, public readonly result: ExecResult, public readonly args: string[]) {
    super(message);
    this.name = 'CliError';
  }
}

/** One-shot cloudflared invocations (list, create, route, delete). */
export class CloudflaredCli {
  constructor(private readonly binary: BinaryService) {}

  async exec(args: string[], opts: { timeoutMs?: number; allowFailure?: boolean } = {}): Promise<ExecResult> {
    const bin = await this.binary.require();
    const log = getLog();
    log.debug(`$ ${bin.path} ${args.join(' ')}`);
    return new Promise<ExecResult>((resolve, reject) => {
      execFile(
        bin.path,
        args,
        { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } },
        (err, stdout, stderr) => {
          const code = err && typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === 'number'
            ? ((err as { code: number }).code)
            : err ? 1 : 0;
          const result: ExecResult = { stdout: String(stdout), stderr: String(stderr), code };
          if (err && !opts.allowFailure) {
            const message = summarizeFailure(result, err);
            log.error(`cloudflared ${args.join(' ')} failed (${code}): ${message}`);
            reject(new CliError(message, result, args));
            return;
          }
          resolve(result);
        },
      );
    });
  }

  async listTunnels(): Promise<RemoteTunnel[]> {
    const { stdout } = await this.exec(['tunnel', 'list', '--output', 'json'], { timeoutMs: 30_000 });
    return parseTunnelList(stdout);
  }

  async createTunnel(name: string): Promise<{ id: string | undefined; output: string }> {
    const { stdout, stderr } = await this.exec(['tunnel', 'create', name]);
    const output = stdout + stderr;
    return { id: parseCreatedTunnelId(output), output };
  }

  async routeDns(tunnel: string, hostname: string, overwrite = false): Promise<string> {
    const args = ['tunnel', 'route', 'dns'];
    if (overwrite) { args.push('--overwrite-dns'); }
    args.push(tunnel, hostname);
    const { stdout, stderr } = await this.exec(args);
    return stdout + stderr;
  }

  async deleteTunnel(nameOrId: string, force = false): Promise<void> {
    const args = ['tunnel', 'delete'];
    if (force) { args.push('-f'); }
    args.push(nameOrId);
    await this.exec(args);
  }
}

function summarizeFailure(result: ExecResult, err: Error): string {
  const text = (result.stderr || result.stdout || '').trim();
  // cloudflared prints "ERR ... error=..." style lines; keep the last meaningful line.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find((l) => /\b(ERR|error)\b/i.test(l)) ?? lines[lines.length - 1];
  return errLine ? errLine.replace(/^\S+\s+(ERR|FTL)\s+/, '') : err.message;
}
