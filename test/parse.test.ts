import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  classifyLogLine,
  isValidHostname,
  isValidTunnelName,
  logMessage,
  normalizeLocalUrl,
  parseCreatedTunnelId,
  parseLoginUrl,
  parseLsof,
  parseNetstat,
  parseQuickTunnelUrl,
  parseSs,
  parseTunnelList,
  parseVersion,
} from '../src/cloudflared/parse';
import { candidateBinaryPaths, certPath, releaseAsset, releaseDownloadUrl } from '../src/platform';

describe('parseVersion', () => {
  it('reads the semver-ish version', () => {
    assert.equal(parseVersion('cloudflared version 2026.9.3 (built 2026-09-24T15:31:10Z)'), '2026.9.3');
    assert.equal(parseVersion('garbage'), undefined);
  });
});

describe('parseQuickTunnelUrl', () => {
  it('finds the trycloudflare URL inside the ASCII box', () => {
    const line = '2026-09-25T04:00:19Z INF |  https://download-locked-guam-thompson.trycloudflare.com                                   |';
    assert.equal(parseQuickTunnelUrl(line), 'https://download-locked-guam-thompson.trycloudflare.com');
  });
  it('ignores the "Requesting new quick Tunnel on trycloudflare.com" line', () => {
    assert.equal(parseQuickTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), undefined);
  });
});

describe('parseLoginUrl', () => {
  it('extracts the dashboard URL', () => {
    const text = 'Please open the following URL and log in with your Cloudflare account:\n\nhttps://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc\n\nLeave cloudflared running';
    assert.equal(parseLoginUrl(text), 'https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc');
  });
});

describe('log lines', () => {
  it('classifies levels and strips prefixes', () => {
    assert.equal(classifyLogLine('2026-09-25T04:00:24Z ERR Connection terminated connIndex=0'), 'error');
    assert.equal(classifyLogLine('2026-09-25T04:00:24Z INF Tunnel server stopped'), 'info');
    assert.equal(classifyLogLine('plain text'), 'info');
    assert.equal(logMessage('2026-09-25T04:00:24Z ERR Connection terminated connIndex=0'), 'Connection terminated connIndex=0');
  });
});

describe('parseTunnelList', () => {
  const json = JSON.stringify([
    {
      id: '01e98432-3ad7-4972-aba4-2c2f071eb226',
      name: 'HA Server',
      created_at: '2026-09-12T06:47:50.307279Z',
      deleted_at: '0001-01-01T00:00:00Z',
      connections: [
        { colo_name: 'scl01', id: 'a', is_pending_reconnect: false },
        { colo_name: 'scl04', id: 'b', is_pending_reconnect: false },
        { colo_name: 'scl01', id: 'c', is_pending_reconnect: true },
      ],
    },
    { id: '99162d6f-dadc-4f06-9b59-819c19a08cbf', name: 'herd-symfony', deleted_at: '0001-01-01T00:00:00Z', connections: [] },
    { id: 'deleted', name: 'old', deleted_at: '2026-01-01T00:00:00Z', connections: [] },
  ]);
  it('maps tunnels, counts live connections and drops deleted ones', () => {
    const list = parseTunnelList(json);
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'HA Server');
    assert.equal(list[0].connections, 2);
    assert.deepEqual(list[0].colos, ['scl01', 'scl04']);
    assert.equal(list[1].connections, 0);
  });
  it('tolerates empty output', () => {
    assert.deepEqual(parseTunnelList(''), []);
    assert.deepEqual(parseTunnelList('null'), []);
    assert.deepEqual(parseTunnelList('[]'), []);
  });
});

describe('parseCreatedTunnelId', () => {
  it('reads the id', () => {
    assert.equal(
      parseCreatedTunnelId('Tunnel credentials written to /Users/x/.cloudflared/99162d6f-dadc-4f06-9b59-819c19a08cbf.json.\nCreated tunnel herd-symfony with id 99162d6f-dadc-4f06-9b59-819c19a08cbf'),
      '99162d6f-dadc-4f06-9b59-819c19a08cbf',
    );
  });
});

describe('port parsers', () => {
  it('parses lsof -F pcn output', () => {
    const out = 'p638\ncrapportd\nf11\nn*:56669\nf14\nn*:56669\np1400\ncHerd\nf51\nn*:2304\np2000\ncnode\nf20\nn127.0.0.1:3000\nf21\nn[::1]:3000\n';
    const ports = parseLsof(out);
    assert.deepEqual(ports.map((p) => p.port), [2304, 3000, 56669]);
    assert.equal(ports.find((p) => p.port === 3000)?.process, 'node');
    assert.equal(ports.find((p) => p.port === 3000)?.pid, 2000);
  });
  it('parses ss -ltnpH output', () => {
    const out = 'LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))\nLISTEN 0 128 [::]:22 [::]:*\n';
    const ports = parseSs(out);
    assert.deepEqual(ports.map((p) => p.port), [22, 5173]);
    assert.equal(ports[1].process, 'node');
  });
  it('parses netstat -ano output', () => {
    const out = '  Proto  Local Address          Foreign Address        State           PID\n  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       4321\n  TCP    127.0.0.1:49670        127.0.0.1:49671        ESTABLISHED     100\n';
    const ports = parseNetstat(out);
    assert.deepEqual(ports.map((p) => p.port), [8080]);
    assert.equal(ports[0].pid, 4321);
  });
});

describe('normalizeLocalUrl', () => {
  it('accepts ports, host:port and URLs', () => {
    assert.equal(normalizeLocalUrl('3000'), 'http://localhost:3000');
    assert.equal(normalizeLocalUrl(' localhost:8080 '), 'http://localhost:8080');
    assert.equal(normalizeLocalUrl('myapp.test'), 'http://myapp.test');
    assert.equal(normalizeLocalUrl('https://myapp.test/'), 'https://myapp.test');
    assert.equal(normalizeLocalUrl('https://localhost:8443'), 'https://localhost:8443');
  });
  it('rejects junk', () => {
    assert.equal(normalizeLocalUrl(''), undefined);
    assert.equal(normalizeLocalUrl('0'), undefined);
    assert.equal(normalizeLocalUrl('70000'), undefined);
    assert.equal(normalizeLocalUrl('ftp://x'), undefined);
  });
});

describe('validators', () => {
  it('hostnames', () => {
    assert.ok(isValidHostname('app.example.com'));
    assert.ok(!isValidHostname('example'));
    assert.ok(!isValidHostname('http://app.example.com'));
  });
  it('tunnel names', () => {
    assert.ok(isValidTunnelName('my-app'));
    assert.ok(isValidTunnelName('HA Server'));
    assert.ok(!isValidTunnelName(''));
    assert.ok(!isValidTunnelName('-bad'));
  });
});

describe('platform', () => {
  it('picks release assets per platform', () => {
    assert.equal(releaseAsset('darwin', 'arm64')?.name, 'cloudflared-darwin-arm64.tgz');
    assert.equal(releaseAsset('linux', 'x64')?.name, 'cloudflared-linux-amd64');
    assert.equal(releaseAsset('win32', 'x64')?.name, 'cloudflared-windows-amd64.exe');
    assert.equal(releaseAsset('freebsd', 'x64'), undefined);
    assert.ok(releaseDownloadUrl(releaseAsset('linux', 'arm64')!).endsWith('/latest/download/cloudflared-linux-arm64'));
  });
  it('honours TUNNEL_ORIGIN_CERT and falls back to ~/.cloudflared', () => {
    assert.equal(certPath({ TUNNEL_ORIGIN_CERT: '/x/cert.pem' }), '/x/cert.pem');
    assert.equal(certPath({ HOME: '/home/u' }), '/home/u/.cloudflared/cert.pem');
  });
  it('checks PATH entries before known dirs, without duplicates', () => {
    const paths = candidateBinaryPaths('darwin', { PATH: '/usr/local/bin:/opt/homebrew/bin', HOME: '/Users/u' });
    assert.equal(paths[0], '/usr/local/bin/cloudflared');
    assert.equal(paths.filter((p) => p === '/opt/homebrew/bin/cloudflared').length, 1);
    assert.ok(paths.includes('/opt/homebrew/opt/cloudflared/bin/cloudflared'));
  });
});
