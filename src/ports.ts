import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ListeningPort, parseLsof, parseNetstat, parseSs } from './cloudflared/parse';

const execFileP = promisify(execFile);

/** Ports that are almost never what the user wants to expose. */
const NOISE_PROCESSES = new Set(['rapportd', 'ControlCenter', 'sharingd', 'AirPlayXPCHelper', 'Dropbox', 'Spotify', 'figma_agent']);

async function run(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (err) {
    // lsof exits 1 when nothing matches; still may have stdout.
    const e = err as { stdout?: string };
    return e.stdout ?? '';
  }
}

export async function detectListeningPorts(): Promise<ListeningPort[]> {
  let ports: ListeningPort[] = [];
  if (process.platform === 'win32') {
    ports = parseNetstat(await run('netstat', ['-ano', '-p', 'tcp']));
  } else if (process.platform === 'linux') {
    const ss = await run('ss', ['-ltnpH']);
    ports = ss.trim() ? parseSs(ss) : parseLsof(await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn']));
  } else {
    ports = parseLsof(await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn']));
  }
  return ports.filter((p) => !(p.process && NOISE_PROCESSES.has(p.process)));
}

/** Common dev-server ports float to the top of the picker. */
const PREFERRED = [3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000, 1313, 1234, 4000, 6006, 8025];

export function rankPorts(ports: ListeningPort[]): ListeningPort[] {
  const score = (p: ListeningPort): number => {
    const idx = PREFERRED.indexOf(p.port);
    if (idx >= 0) { return idx; }
    if (p.port >= 1024 && p.port < 10000) { return 100 + p.port / 100000; }
    if (p.port >= 10000 && p.port < 49152) { return 200 + p.port / 100000; }
    return 300 + p.port / 100000;
  };
  return [...ports].sort((a, b) => score(a) - score(b));
}
