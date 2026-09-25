## Step 2 · Expose a local port

A **quick tunnel** gives you a random `*.trycloudflare.com` HTTPS URL that forwards to a port on your machine. It works without a Cloudflare account and is perfect for demos, webhooks and sharing work in progress.

1. Run **Cloudflared: Expose Local Port**.
2. Pick one of the ports the extension detected listening on your machine, or type a port or full URL (for example `http://localhost:5173` or `https://myapp.test`).
3. The public URL is copied to your clipboard as soon as the tunnel is up.

Quick tunnels disappear when you stop them. Their URL changes each time.
