import * as vscode from 'vscode';
import { AuthService } from './cloudflared/auth';
import { BinaryService } from './cloudflared/binary';
import { CloudflaredCli } from './cloudflared/cli';
import { registerCommands } from './commands';
import { getLog } from './log';
import { SetupService } from './onboarding/setup';
import { TunnelManager } from './tunnels/manager';
import { StatusBar } from './ui/statusBar';
import { TunnelTreeProvider } from './ui/tree';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = getLog();
  context.subscriptions.push(log);
  log.info(`Activating vscode-cloudflared ${context.extension.packageJSON.version} on ${process.platform}/${process.arch}`);

  const binary = new BinaryService(context);
  const cli = new CloudflaredCli(binary);
  const auth = new AuthService(binary);
  const setup = new SetupService(binary, auth);
  const manager = new TunnelManager(context, binary);
  const tree = new TunnelTreeProvider(setup, manager, cli);
  const statusBar = new StatusBar(setup, manager);

  const view = vscode.window.createTreeView('cloudflared.tunnels', { treeDataProvider: tree, showCollapseAll: false });
  context.subscriptions.push(setup, manager, tree, statusBar, view);

  registerCommands(context, { binary, cli, auth, setup, manager, tree });

  context.subscriptions.push(
    manager.onDidChange(() => {
      void vscode.commands.executeCommand('setContext', 'cloudflared.hasRunningTunnels', manager.active().length > 0);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cloudflared.binaryPath')) {
        void setup.refresh(true);
      }
    }),
    view.onDidChangeVisibility((e) => {
      if (e.visible) { void setup.refresh(); }
    }),
  );

  await setup.refresh();
  void setup.maybeShowFirstRunHint(context);
}

export function deactivate(): void {
  // Disposables registered in activate() take care of stopping tunnels.
}
