# Cloudflare Tunnel for VS Code

Expose local ports and manage [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) without leaving VS Code.

The extension assumes nothing about your machine. If `cloudflared` is missing it installs it for you, if you are not signed in it walks you through the browser login, and every step of getting a tunnel running is a click away.

## What you can do

- **Expose a local port in one command.** Pick one of the ports the extension detects listening on your machine (or type any port, `host:port` or URL) and get a public `https://*.trycloudflare.com` address copied to your clipboard. No Cloudflare account needed.
- **Run named tunnels on your own domain.** A three-step wizard creates the tunnel, routes a hostname to it with a CNAME record and starts it. The local origin is remembered per tunnel so next time it is a single click.
- **Run tunnels created in the Zero Trust dashboard.** Paste the connector token once; it is kept in your OS keychain.
- **See everything in one place.** A Tunnels view in the Activity Bar lists quick tunnels, the named tunnels on your account (including those connected from other machines), and token tunnels. Start, stop, restart, copy the URL, open it in the browser or read the logs from there.
- **Status bar at a glance.** How many tunnels are up, a spinner while Cloudflare assigns a URL, a warning when one fails. Click it for a quick menu.
- **Guided onboarding.** A setup checklist, a Getting Started walkthrough and welcome content in the view tell you what the next step is.

## Getting started

1. Install the extension.
2. Open the **Cloudflare Tunnel** view in the Activity Bar (cloud icon) or run **Cloudflared: Get Started / Check Setup** from the Command Palette.
3. Follow the checklist:
   - **Install cloudflared.** Choose *Download automatically* (the official release for your OS and CPU goes into the extension's storage folder, no admin rights), a package manager such as Homebrew or winget, or point to a binary you already have.
   - **Expose a local port.** Try it right away, it works without an account.
   - **Sign in to Cloudflare** (optional). Only needed for tunnels on a domain you manage in Cloudflare. Your browser opens the dashboard, you pick the zone, and the certificate lands in `~/.cloudflared/cert.pem`.
   - **Create a named tunnel.** Name, hostname, local service. Done.

## Commands

| Command | What it does |
| --- | --- |
| Cloudflared: Get Started / Check Setup | Checklist with the current state of each setup step |
| Cloudflared: Install or Update cloudflared | Download, package manager or pick an existing binary |
| Cloudflared: Sign in to Cloudflare | Browser login (`cloudflared tunnel login`) |
| Cloudflared: Expose Local Port (Quick Tunnel) | Temporary public URL for a local port |
| Cloudflared: Create Named Tunnel… | `tunnel create` + `tunnel route dns` + `tunnel run` |
| Cloudflared: Start Named Tunnel | Start one of the tunnels on your account |
| Cloudflared: Run Tunnel with Token… | Start a dashboard-managed tunnel |
| Cloudflared: Set Local Service URL… | Change where a named tunnel forwards to, or switch to your `config.yml` ingress rules |
| Cloudflared: Route Hostname (DNS)… | Point another hostname at a tunnel |
| Cloudflared: Stop / Restart / Stop All | Lifecycle of tunnels started in this window |
| Cloudflared: Copy Public URL / Open in Browser | For the selected tunnel |
| Cloudflared: Show Logs | Per-tunnel output channel |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cloudflared.binaryPath` | `""` | Absolute path to `cloudflared`. Empty means auto-detect: this setting, the extension's own download, `PATH`, then common install locations (Homebrew, winget, scoop, apt). |
| `cloudflared.copyUrlOnStart` | `true` | Copy the public URL to the clipboard when a tunnel comes up. |
| `cloudflared.openBrowserOnStart` | `false` | Open the public URL in the browser when a tunnel comes up. |
| `cloudflared.extraArgs` | `[]` | Extra flags for every `cloudflared tunnel` process, e.g. `["--protocol", "http2"]`. |
| `cloudflared.showStatusBar` | `true` | Show the status bar item. |
| `cloudflared.stopTunnelsOnExit` | `true` | Stop tunnels started here when the window closes. |

## How it works

The extension only ever runs the `cloudflared` binary. Quick tunnels are `cloudflared tunnel --url <origin>`; named tunnels are `cloudflared tunnel run --url <origin> <id>` (or plain `tunnel run <id>` when you choose to use your own `config.yml`); token tunnels are `tunnel run --token`. Nothing is sent anywhere except to Cloudflare through `cloudflared` itself.

Per-tunnel preferences (local origin, hostname) are stored in VS Code global state. Tokens go to VS Code's SecretStorage, which is your OS keychain.

## Requirements

- VS Code 1.96 or newer.
- macOS (Intel or Apple Silicon), Linux (x64, arm64, arm) or Windows (x64). On other platforms you can still point the extension to a binary you built yourself.

## Development

```bash
pnpm install
pnpm watch        # rebuild on change
# press F5 in VS Code to launch the Extension Development Host
pnpm test         # unit tests for the parsers
pnpm package      # builds the .vsix
```

## License

MIT
