import * as vscode from 'vscode';

export interface Settings {
  binaryPath: string;
  copyUrlOnStart: boolean;
  openBrowserOnStart: boolean;
  extraArgs: string[];
  showStatusBar: boolean;
  stopTunnelsOnExit: boolean;
}

export function getSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('cloudflared');
  return {
    binaryPath: (cfg.get<string>('binaryPath') ?? '').trim(),
    copyUrlOnStart: cfg.get<boolean>('copyUrlOnStart') ?? true,
    openBrowserOnStart: cfg.get<boolean>('openBrowserOnStart') ?? false,
    extraArgs: (cfg.get<string[]>('extraArgs') ?? []).filter((a) => typeof a === 'string' && a.trim()),
    showStatusBar: cfg.get<boolean>('showStatusBar') ?? true,
    stopTunnelsOnExit: cfg.get<boolean>('stopTunnelsOnExit') ?? true,
  };
}

export async function setBinaryPath(value: string): Promise<void> {
  await vscode.workspace.getConfiguration('cloudflared').update('binaryPath', value, vscode.ConfigurationTarget.Global);
}
