## Step 1 · Install cloudflared

`cloudflared` is Cloudflare's lightweight connector. It runs on your machine and opens an outbound, encrypted connection to Cloudflare's network, so nothing on your router or firewall needs to change.

The extension can set it up in three ways:

- **Download automatically** (recommended): the extension fetches the official release for your OS and architecture and keeps it in its own storage folder. No admin rights needed.
- **Use a package manager**: Homebrew on macOS, winget on Windows, apt/dnf on Linux. The command runs in the integrated terminal.
- **Point to an existing binary**: if you already have it somewhere, pick the file.

Once detected, the version appears in the Tunnels view and in the status bar.
