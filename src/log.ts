import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function getLog(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Cloudflared', { log: true });
  }
  return channel;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) { return err.message; }
  return String(err);
}
