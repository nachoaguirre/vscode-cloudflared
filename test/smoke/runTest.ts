// Launches a real VS Code with the extension loaded and runs suite.ts inside it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // When launched from a VS Code terminal this is set and would make Electron start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = path.resolve(__dirname, '../../..');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflared-ext-test-'));
  // Prefer the VS Code already installed on this machine; newer builds name the binary "Code", older ones "Electron".
  const localCandidates = process.platform === 'darwin'
    ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
    : [];
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE || localCandidates.find((p) => fs.existsSync(p));
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--user-data-dir', userDataDir, '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { CLOUDFLARED_EXT_TEST: '1' },
    });
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
