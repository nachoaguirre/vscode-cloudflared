// Parsers for cloudflared output. Pure functions, unit-tested under test/.

export function parseVersion(output: string): string | undefined {
  const m = /cloudflared version (\d{4}\.\d{1,2}\.\d+)/.exec(output);
  return m?.[1];
}

export const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseQuickTunnelUrl(text: string): string | undefined {
  const m = QUICK_TUNNEL_URL_RE.exec(text);
  return m?.[0].toLowerCase();
}

export function parseLoginUrl(text: string): string | undefined {
  const m = /https:\/\/dash\.cloudflare\.com\/argotunnel\S*/.exec(text);
  return m?.[0];
}

export function isConnectionRegistered(line: string): boolean {
  return /Registered tunnel connection/.test(line);
}

export function isLoginSuccess(text: string): boolean {
  return /successfully logged in/i.test(text);
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** cloudflared log lines look like: 2026-09-25T04:00:14Z INF message key=value */
export function classifyLogLine(line: string): LogLevel {
  const m = /^\S+\s+(DBG|INF|WRN|ERR|FTL)\s/.exec(line);
  switch (m?.[1]) {
    case 'DBG': return 'debug';
    case 'WRN': return 'warn';
    case 'ERR':
    case 'FTL': return 'error';
    default: return 'info';
  }
}

/** Strips the timestamp and level so the message reads well in notifications. */
export function logMessage(line: string): string {
  return line.replace(/^\S+\s+(DBG|INF|WRN|ERR|FTL)\s+/, '').trim();
}

export interface RemoteTunnel {
  id: string;
  name: string;
  createdAt?: string;
  /** Number of active connections reported by the edge. */
  connections: number;
  /** Distinct Cloudflare colos with an open connection. */
  colos: string[];
}

interface RawTunnel {
  id?: string;
  name?: string;
  created_at?: string;
  deleted_at?: string;
  connections?: Array<{ colo_name?: string; is_pending_reconnect?: boolean }>;
}

export function parseTunnelList(json: string): RemoteTunnel[] {
  const trimmed = json.trim();
  if (!trimmed || trimmed === 'null') {
    return [];
  }
  const raw = JSON.parse(trimmed) as RawTunnel[] | null;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((t) => t && typeof t.id === 'string' && !isDeleted(t.deleted_at))
    .map((t) => {
      const conns = (t.connections ?? []).filter((c) => !c.is_pending_reconnect);
      return {
        id: t.id as string,
        name: t.name ?? t.id as string,
        createdAt: t.created_at,
        connections: conns.length,
        colos: [...new Set(conns.map((c) => c.colo_name).filter((c): c is string => !!c))],
      };
    });
}

function isDeleted(deletedAt?: string): boolean {
  return !!deletedAt && !deletedAt.startsWith('0001-01-01');
}

/** `cloudflared tunnel create` prints: Created tunnel NAME with id UUID */
export function parseCreatedTunnelId(output: string): string | undefined {
  const m = /with id ([0-9a-f-]{36})/i.exec(output);
  return m?.[1];
}

export interface ListeningPort {
  port: number;
  address?: string;
  process?: string;
  pid?: number;
}

/** Parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (one field per line). */
export function parseLsof(output: string): ListeningPort[] {
  const result: ListeningPort[] = [];
  let pid: number | undefined;
  let proc: string | undefined;
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    if (!line) { continue; }
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
      proc = undefined;
    } else if (tag === 'c') {
      proc = value;
    } else if (tag === 'n') {
      const m = /:(\d+)$/.exec(value);
      if (m) {
        result.push({ port: Number(m[1]), address: value.slice(0, value.length - m[0].length) || undefined, process: proc, pid });
      }
    }
  }
  return dedupePorts(result);
}

/** Parses `ss -ltnpH` on Linux. */
export function parseSs(output: string): ListeningPort[] {
  const result: ListeningPort[] = [];
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) { continue; }
    const local = cols[3];
    const m = /:(\d+)$/.exec(local);
    if (!m) { continue; }
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    result.push({ port: Number(m[1]), address: local.slice(0, -m[0].length), process: users?.[1], pid: users ? Number(users[2]) : undefined });
  }
  return dedupePorts(result);
}

/** Parses `netstat -ano -p tcp` on Windows. */
export function parseNetstat(output: string): ListeningPort[] {
  const result: ListeningPort[] = [];
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0].toUpperCase() !== 'TCP') { continue; }
    if (!/LISTEN/i.test(cols[3])) { continue; }
    const m = /:(\d+)$/.exec(cols[1]);
    if (!m) { continue; }
    result.push({ port: Number(m[1]), address: cols[1].slice(0, -m[0].length), pid: Number(cols[4]) || undefined });
  }
  return dedupePorts(result);
}

export function dedupePorts(ports: ListeningPort[]): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const p of ports) {
    if (!Number.isFinite(p.port) || p.port <= 0) { continue; }
    const existing = byPort.get(p.port);
    if (!existing) {
      byPort.set(p.port, p);
    } else if (!existing.process && p.process) {
      byPort.set(p.port, { ...existing, process: p.process, pid: p.pid });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/**
 * Accepts "3000", "localhost:3000", "127.0.0.1:8080", "myapp.test",
 * "https://myapp.test" and returns a URL cloudflared understands.
 */
export function normalizeLocalUrl(input: string): string | undefined {
  const value = input.trim();
  if (!value) { return undefined; }
  if (/^\d{1,5}$/.test(value)) {
    const port = Number(value);
    return port > 0 && port <= 65535 ? `http://localhost:${port}` : undefined;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:', 'tcp:', 'ssh:', 'rdp:', 'unix:', 'smb:'].includes(url.protocol)) {
      return undefined;
    }
    if (!url.hostname) { return undefined; }
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export function isValidHostname(value: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value.trim());
}

export function isValidTunnelName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,62}$/.test(value.trim());
}
