import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { getLog, errorMessage } from '../log';
import { getSettings, setBinaryPath } from '../settings';
import { parseVersion } from './parse';
import {
  binaryName,
  candidateBinaryPaths,
  DOCS,
  packageManagerOptions,
  PackageManagerOption,
  releaseAsset,
  releaseDownloadUrl,
} from '../platform';

const execFileP = promisify(execFile);
const l10n = vscode.l10n;

export type BinarySource = 'setting' | 'managed' | 'path';

export interface BinaryInfo {
  path: string;
  version?: string;
  source: BinarySource;
}

/** Finds, validates and installs the cloudflared binary. */
export class BinaryService {
  private cached: BinaryInfo | undefined;
  private locating: Promise<BinaryInfo | undefined> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Where the extension stores the binary it downloads itself. */
  managedPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'bin', binaryName());
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /** Returns the cached binary, or undefined when none is installed. */
  current(): BinaryInfo | undefined {
    return this.cached;
  }

  async locate(force = false): Promise<BinaryInfo | undefined> {
    if (force) { this.invalidate(); }
    if (this.cached) { return this.cached; }
    if (!this.locating) {
      this.locating = this.doLocate().finally(() => { this.locating = undefined; });
    }
    return this.locating;
  }

  /** Like locate(), but throws a friendly error when the binary is missing. */
  async require(): Promise<BinaryInfo> {
    const info = await this.locate();
    if (!info) {
      throw new Error(l10n.t('cloudflared is not installed. Run "Cloudflared: Install or Update cloudflared" first.'));
    }
    return info;
  }

  private async doLocate(): Promise<BinaryInfo | undefined> {
    const log = getLog();
    const settings = getSettings();
    const candidates: Array<{ path: string; source: BinarySource }> = [];
    if (settings.binaryPath) {
      candidates.push({ path: settings.binaryPath, source: 'setting' });
    }
    candidates.push({ path: this.managedPath(), source: 'managed' });
    for (const p of candidateBinaryPaths()) {
      candidates.push({ path: p, source: 'path' });
    }
    for (const c of candidates) {
      if (!(await isExecutable(c.path))) { continue; }
      const version = await this.probeVersion(c.path);
      if (version === null) {
        log.warn(`Found ${c.path} but it did not answer to --version; skipping`);
        continue;
      }
      log.info(`Using cloudflared ${version ?? '(unknown version)'} at ${c.path} (${c.source})`);
      this.cached = { path: c.path, version, source: c.source };
      return this.cached;
    }
    log.info('cloudflared not found in settings, extension storage, PATH or known locations');
    return undefined;
  }

  /** undefined = ran but version not parsed; null = failed to run. */
  private async probeVersion(bin: string): Promise<string | undefined | null> {
    try {
      const { stdout, stderr } = await execFileP(bin, ['--version'], { timeout: 10_000, windowsHide: true });
      return parseVersion(stdout + stderr);
    } catch (err) {
      getLog().debug(`--version failed for ${bin}: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Guided install flow. Resolves to the binary when it ends up installed. */
  async install(): Promise<BinaryInfo | undefined> {
    const existing = await this.locate();
    const asset = releaseAsset();
    const pms = await this.availablePackageManagers();

    type Choice = vscode.QuickPickItem & { action: 'download' | 'pm' | 'pick' | 'docs'; pm?: PackageManagerOption };
    const items: Choice[] = [];
    if (asset) {
      items.push({
        label: l10n.t('$(cloud-download) Download automatically'),
        description: l10n.t('Recommended'),
        detail: l10n.t('Fetches the official {0} release for {1}/{2} into the extension storage. No admin rights needed.', 'cloudflared', process.platform, process.arch),
        action: 'download',
      });
    }
    for (const pm of pms) {
      items.push({
        label: l10n.t('$(terminal) Install with {0}', pm.label),
        detail: pm.command,
        action: 'pm',
        pm,
      });
    }
    items.push({
      label: l10n.t('$(folder-opened) I already have it, choose the file…'),
      detail: existing ? l10n.t('Currently using {0}', existing.path) : undefined,
      action: 'pick',
    });
    items.push({ label: l10n.t('$(book) Open installation docs'), action: 'docs' });

    const picked = await vscode.window.showQuickPick(items, {
      title: existing
        ? l10n.t('cloudflared {0} is installed. Update or replace it?', existing.version ?? '')
        : l10n.t('Install cloudflared'),
      placeHolder: l10n.t('How do you want to install cloudflared?'),
      ignoreFocusOut: true,
    });
    if (!picked) { return existing; }

    switch (picked.action) {
      case 'download':
        return this.downloadFlow(asset!);
      case 'pm':
        return this.terminalFlow(picked.pm!);
      case 'pick':
        return this.pickExistingFlow();
      case 'docs':
        await vscode.env.openExternal(vscode.Uri.parse(DOCS.downloads));
        return existing;
    }
  }

  private async availablePackageManagers(): Promise<PackageManagerOption[]> {
    const out: PackageManagerOption[] = [];
    for (const pm of packageManagerOptions()) {
      if (await isOnPath(pm.tool)) { out.push(pm); }
    }
    return out;
  }

  private async downloadFlow(asset: NonNullable<ReturnType<typeof releaseAsset>>): Promise<BinaryInfo | undefined> {
    const log = getLog();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: l10n.t('Downloading cloudflared'), cancellable: true },
        async (progress, token) => {
          const url = releaseDownloadUrl(asset);
          const binDir = path.dirname(this.managedPath());
          await fsp.mkdir(binDir, { recursive: true });
          const tmp = path.join(binDir, `download-${Date.now()}.tmp`);
          log.info(`Downloading ${url}`);
          progress.report({ message: asset.name });
          await downloadToFile(url, tmp, progress, token);
          if (token.isCancellationRequested) {
            await fsp.rm(tmp, { force: true });
            return;
          }
          progress.report({ message: l10n.t('Installing…') });
          const target = this.managedPath();
          await fsp.rm(target, { force: true });
          if (asset.kind === 'tgz') {
            await execFileP('tar', ['-xzf', tmp, '-C', binDir], { timeout: 60_000 });
            await fsp.rm(tmp, { force: true });
            // tarball contains a single "cloudflared" file
            if (!fs.existsSync(target)) {
              throw new Error(l10n.t('The archive did not contain a cloudflared binary.'));
            }
          } else {
            await fsp.rename(tmp, target);
          }
          if (process.platform !== 'win32') {
            await fsp.chmod(target, 0o755);
          }
          log.info(`Installed to ${target}`);
        },
      );
    } catch (err) {
      log.error(`Download failed: ${errorMessage(err)}`);
      const choice = await vscode.window.showErrorMessage(
        l10n.t('Could not download cloudflared: {0}', errorMessage(err)),
        l10n.t('Try again'),
        l10n.t('Open docs'),
      );
      if (choice === l10n.t('Try again')) { return this.downloadFlow(asset); }
      if (choice === l10n.t('Open docs')) { await vscode.env.openExternal(vscode.Uri.parse(DOCS.downloads)); }
      return undefined;
    }
    // Prefer the managed copy from now on, even if another one exists on PATH.
    const settings = getSettings();
    if (settings.binaryPath && settings.binaryPath !== this.managedPath()) {
      await setBinaryPath('');
    }
    return this.finish();
  }

  private async terminalFlow(pm: PackageManagerOption): Promise<BinaryInfo | undefined> {
    const terminal = vscode.window.createTerminal({ name: 'cloudflared install' });
    terminal.show();
    terminal.sendText(pm.command, true);
    const found = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: l10n.t('Waiting for {0} to finish installing cloudflared…', pm.label),
        cancellable: true,
      },
      async (_progress, token) => {
        const deadline = Date.now() + 10 * 60_000;
        while (!token.isCancellationRequested && Date.now() < deadline) {
          const info = await this.locate(true);
          if (info) { return info; }
          await delay(2000);
        }
        return undefined;
      },
    );
    if (!found) {
      const retry = await vscode.window.showWarningMessage(
        l10n.t('cloudflared was not detected yet. If the install finished, check again; otherwise pick the binary manually.'),
        l10n.t('Check again'),
        l10n.t('Choose file…'),
      );
      if (retry === l10n.t('Check again')) { return this.finish(); }
      if (retry === l10n.t('Choose file…')) { return this.pickExistingFlow(); }
      return undefined;
    }
    return this.finish();
  }

  private async pickExistingFlow(): Promise<BinaryInfo | undefined> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: l10n.t('Select the cloudflared binary'),
      openLabel: l10n.t('Use this binary'),
    });
    const file = uris?.[0]?.fsPath;
    if (!file) { return undefined; }
    const version = await this.probeVersion(file);
    if (version === null) {
      await vscode.window.showErrorMessage(l10n.t('{0} does not look like a working cloudflared binary.', file));
      return undefined;
    }
    await setBinaryPath(file);
    return this.finish();
  }

  private async finish(): Promise<BinaryInfo | undefined> {
    const info = await this.locate(true);
    if (info) {
      void vscode.window.showInformationMessage(l10n.t('cloudflared {0} is ready.', info.version ?? ''));
    } else {
      void vscode.window.showErrorMessage(l10n.t('cloudflared is still not detected. Check the Cloudflared output for details.'));
    }
    return info;
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) { return false; }
    if (process.platform !== 'win32') {
      await fsp.access(file, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

async function isOnPath(tool: string): Promise<boolean> {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(sep).filter(Boolean);
  if (process.platform === 'darwin') { dirs.push('/opt/homebrew/bin', '/usr/local/bin'); }
  if (process.platform === 'linux') { dirs.push('/home/linuxbrew/.linuxbrew/bin'); }
  for (const dir of dirs) {
    for (const ext of exts) {
      if (await isExecutable(path.join(dir, tool + ext))) { return true; }
    }
  }
  return false;
}

async function downloadToFile(
  url: string,
  dest: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<void> {
  const controller = new AbortController();
  const sub = token.onCancellationRequested(() => controller.abort());
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    let lastPct = 0;
    const counter = new (await import('node:stream')).Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct > lastPct) {
            progress.report({ increment: pct - lastPct, message: `${pct}%` });
            lastPct = pct;
          }
        }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, fs.createWriteStream(dest));
  } finally {
    sub.dispose();
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
