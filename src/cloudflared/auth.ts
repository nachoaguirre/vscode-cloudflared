import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { getLog, errorMessage } from '../log';
import { certPath, DOCS } from '../platform';
import { BinaryService } from './binary';
import { isLoginSuccess, parseLoginUrl } from './parse';

const l10n = vscode.l10n;

/** Handles the browser-based `cloudflared tunnel login` flow. */
export class AuthService {
  constructor(private readonly binary: BinaryService) {}

  certPath(): string {
    return certPath();
  }

  async isLoggedIn(): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.certPath());
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  /** Returns true when a certificate is present when the flow ends. */
  async login(): Promise<boolean> {
    const bin = await this.binary.require();
    const log = getLog();
    const cert = this.certPath();
    let backup: string | undefined;

    if (await this.isLoggedIn()) {
      const choice = await vscode.window.showInformationMessage(
        l10n.t('You are already signed in (certificate at {0}). Sign in again to switch account or authorize another domain?', cert),
        { modal: true },
        l10n.t('Sign in again'),
      );
      if (choice !== l10n.t('Sign in again')) { return true; }
      backup = `${cert}.bak-${Date.now()}`;
      await fsp.rename(cert, backup);
      log.info(`Moved existing certificate to ${backup}`);
    }

    const ok = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: l10n.t('Sign in to Cloudflare in your browser'),
        cancellable: true,
      },
      (progress, token) =>
        new Promise<boolean>((resolve) => {
          const child = spawn(bin.path, ['tunnel', 'login'], { env: { ...process.env, NO_COLOR: '1' }, windowsHide: true });
          let buffer = '';
          let urlShown = false;
          let done = false;

          const finish = (value: boolean) => {
            if (done) { return; }
            done = true;
            resolve(value);
          };

          const onData = (chunk: Buffer) => {
            const text = chunk.toString();
            buffer += text;
            log.info(text.trimEnd());
            const url = parseLoginUrl(buffer);
            if (url && !urlShown) {
              urlShown = true;
              progress.report({ message: l10n.t('Pick the domain to authorize, then come back here.') });
              void vscode.window
                .showInformationMessage(
                  l10n.t('A Cloudflare sign-in page should have opened in your browser. If it did not, open it manually.'),
                  l10n.t('Open sign-in page'),
                  l10n.t('Copy URL'),
                )
                .then(async (choice) => {
                  if (choice === l10n.t('Open sign-in page')) { await vscode.env.openExternal(vscode.Uri.parse(url)); }
                  if (choice === l10n.t('Copy URL')) { await vscode.env.clipboard.writeText(url); }
                });
            }
            if (isLoginSuccess(buffer)) {
              progress.report({ message: l10n.t('Certificate received.') });
            }
          };
          child.stdout.on('data', onData);
          child.stderr.on('data', onData);
          child.on('error', (err) => {
            log.error(`login spawn error: ${errorMessage(err)}`);
            finish(false);
          });
          child.on('exit', async (code) => {
            log.info(`tunnel login exited with ${code}`);
            finish(await this.isLoggedIn());
          });
          token.onCancellationRequested(() => {
            child.kill();
            finish(false);
          });
        }),
    );

    if (ok) {
      if (backup) { await fsp.rm(backup, { force: true }); }
      void vscode.window.showInformationMessage(l10n.t('Signed in to Cloudflare. You can now create named tunnels.'));
      return true;
    }

    if (backup) {
      await fsp.rename(backup, cert).catch(() => undefined);
      log.info('Restored previous certificate');
    }
    const choice = await vscode.window.showWarningMessage(
      l10n.t('Sign-in did not complete. You need a Cloudflare account with at least one domain on it to use named tunnels.'),
      l10n.t('Try again'),
      l10n.t('Create a free account'),
    );
    if (choice === l10n.t('Try again')) { return this.login(); }
    if (choice === l10n.t('Create a free account')) { await vscode.env.openExternal(vscode.Uri.parse(DOCS.signup)); }
    return this.isLoggedIn();
  }
}
