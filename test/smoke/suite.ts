// Runs inside the extension host. Plain assertions, no test framework.
import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';

const EXT_ID = 'nachoaguirre.vscode-cloudflared';
const QUICK_URL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[smoke] ${msg}`);
}

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello from vscode-cloudflared'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<ExtensionApi>(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} not found`);
  const api = await ext.activate();
  log('activated');

  // Commands are registered
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['cloudflared.setup', 'cloudflared.exposePort', 'cloudflared.createTunnel', 'cloudflared.stopAll', 'cloudflared.statusMenu']) {
    assert.ok(commands.includes(id), `command ${id} missing`);
  }
  log('commands registered');

  // Setup status computed
  assert.equal(api.setup.status.checked, true);
  const bin = api.setup.status.binary;
  if (!bin) {
    log('cloudflared not installed on this machine; skipping tunnel test');
    return;
  }
  log(`binary ${bin.path} (${bin.version}, ${bin.source})`);
  assert.match(bin.version ?? '', /^\d{4}\.\d{1,2}\.\d+$/);

  // Quick tunnel end to end
  await withServer(async (port) => {
    const localUrl = `http://localhost:${port}`;
    const proc = await api.manager.startQuick(localUrl);
    assert.equal(proc.state, 'starting');
    assert.ok(api.manager.active().includes(proc));
    await api.manager.waitUntilUp(proc, 60_000);
    log(`state=${proc.state} url=${proc.publicUrl} error=${proc.error ?? ''}`);
    assert.equal(proc.state, 'running', `tunnel did not come up: ${proc.error}`);
    assert.match(proc.publicUrl ?? '', QUICK_URL);
    assert.equal(api.manager.findQuickByLocalUrl(localUrl), proc);

    // Give the edge a moment and try the public URL (best effort: propagation can lag).
    const reachable = await pollPublic(proc.publicUrl!, 30_000);
    log(`public URL reachable: ${reachable}`);

    await api.manager.stop(proc);
    assert.equal(proc.state, 'stopped');
    assert.ok(!api.manager.all().includes(proc), 'stopped process should be removed');
    log('stopped and removed');
  });

  // Failure path: an unknown flag (injected via settings) makes cloudflared exit immediately.
  const cfg = vscode.workspace.getConfiguration('cloudflared');
  await cfg.update('extraArgs', ['--definitely-not-a-flag'], vscode.ConfigurationTarget.Global);
  try {
    const bad = await api.manager.startQuick('http://localhost:1');
    await api.manager.waitUntilUp(bad, 20_000);
    log(`failure path state=${bad.state} error=${bad.error ?? ''}`);
    assert.equal(bad.state, 'error');
    assert.ok(bad.error && bad.error.length > 0, 'error message should be captured');
    assert.ok(api.manager.all().includes(bad), 'failed process stays listed so the user can read logs');
    await api.manager.stop(bad);
    assert.ok(!api.manager.all().includes(bad));
  } finally {
    await cfg.update('extraArgs', undefined, vscode.ConfigurationTarget.Global);
  }

  log('ALL OK');
}

async function pollPublic(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status === 200) {
        const text = await res.text();
        if (text.includes('hello from vscode-cloudflared')) { return true; }
      }
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
