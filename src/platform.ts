// Pure helpers about the host platform. No dependency on the vscode module so
// they can be unit-tested with plain node.
import * as os from 'node:os';
import * as path from 'node:path';

export type ReleaseAssetKind = 'tgz' | 'binary' | 'exe';

export interface ReleaseAsset {
  /** File name as published on GitHub releases. */
  name: string;
  kind: ReleaseAssetKind;
}

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Directory where cloudflared keeps cert.pem and tunnel credentials. */
export function cloudflaredDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDir(env), '.cloudflared');
}

/** Path of the origin certificate written by `cloudflared tunnel login`. */
export function certPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TUNNEL_ORIGIN_CERT || env.CLOUDFLARED_ORIGIN_CERT || path.join(cloudflaredDir(env), 'cert.pem');
}

/** Path of the credentials file created by `cloudflared tunnel create`. */
export function credentialsPath(tunnelId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cloudflaredDir(env), `${tunnelId}.json`);
}

export function binaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/** Directories to inspect besides PATH. Covers brew, winget, scoop, apt, manual installs. */
export function knownBinaryDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homeDir(env);
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return [
      path.join(pf86, 'cloudflared'),
      path.join(pf, 'cloudflared'),
      path.join(local, 'Microsoft', 'WinGet', 'Links'),
      path.join(home, 'scoop', 'shims'),
      path.join(env['ChocolateyInstall'] || 'C:\\ProgramData\\chocolatey', 'bin'),
    ];
  }
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/cloudflared/bin',
    '/usr/local/bin',
    '/usr/local/opt/cloudflared/bin',
    '/usr/bin',
    '/bin',
    '/snap/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.cloudflared', 'bin'),
  ];
  if (platform === 'linux') {
    dirs.push('/home/linuxbrew/.linuxbrew/bin');
  }
  return dirs;
}

/** Candidate absolute paths for the binary, PATH entries first. */
export function candidateBinaryPaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const sep = platform === 'win32' ? ';' : ':';
  const pathDirs = (env.PATH || env.Path || '').split(sep).filter(Boolean);
  const name = binaryName(platform);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...pathDirs, ...knownBinaryDirs(platform, env)]) {
    const full = path.join(dir, name);
    if (!seen.has(full)) {
      seen.add(full);
      out.push(full);
    }
  }
  return out;
}

/** GitHub release asset matching this machine, or undefined when unsupported. */
export function releaseAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ReleaseAsset | undefined {
  if (platform === 'darwin') {
    if (arch === 'arm64') { return { name: 'cloudflared-darwin-arm64.tgz', kind: 'tgz' }; }
    if (arch === 'x64') { return { name: 'cloudflared-darwin-amd64.tgz', kind: 'tgz' }; }
    return undefined;
  }
  if (platform === 'linux') {
    const map: Record<string, string> = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' };
    const a = map[arch];
    return a ? { name: `cloudflared-linux-${a}`, kind: 'binary' } : undefined;
  }
  if (platform === 'win32') {
    const map: Record<string, string> = { x64: 'amd64', ia32: '386' };
    const a = map[arch];
    return a ? { name: `cloudflared-windows-${a}.exe`, kind: 'exe' } : undefined;
  }
  return undefined;
}

export function releaseDownloadUrl(asset: ReleaseAsset): string {
  return RELEASE_BASE + asset.name;
}

export interface PackageManagerOption {
  id: 'brew' | 'winget' | 'apt' | 'dnf';
  /** Executable to look for on PATH to decide whether to offer it. */
  tool: string;
  label: string;
  command: string;
}

export function packageManagerOptions(platform: NodeJS.Platform = process.platform): PackageManagerOption[] {
  switch (platform) {
    case 'darwin':
      return [{ id: 'brew', tool: 'brew', label: 'Homebrew', command: 'brew install cloudflared' }];
    case 'win32':
      return [{ id: 'winget', tool: 'winget', label: 'winget', command: 'winget install --id Cloudflare.cloudflared' }];
    case 'linux':
      return [
        { id: 'brew', tool: 'brew', label: 'Homebrew', command: 'brew install cloudflared' },
        {
          id: 'apt',
          tool: 'apt-get',
          label: 'apt (Debian/Ubuntu)',
          command: 'curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list && sudo apt-get update && sudo apt-get install -y cloudflared',
        },
        {
          id: 'dnf',
          tool: 'dnf',
          label: 'dnf (Fedora/RHEL)',
          command: 'curl -fsSL https://pkg.cloudflare.com/cloudflared.repo | sudo tee /etc/yum.repos.d/cloudflared.repo && sudo dnf install -y cloudflared',
        },
      ];
    default:
      return [];
  }
}

export const DOCS = {
  downloads: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  quickTunnels: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/',
  namedTunnels: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/',
  dashboard: 'https://one.dash.cloudflare.com/',
  signup: 'https://dash.cloudflare.com/sign-up',
};
