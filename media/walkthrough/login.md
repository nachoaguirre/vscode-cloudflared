## Step 3 · Sign in to Cloudflare (optional)

Signing in is only required for **named tunnels**, which run on a hostname of a domain you manage in Cloudflare (for example `app.example.com`) and keep the same address forever.

When you run **Cloudflared: Sign in to Cloudflare** the extension opens the Cloudflare dashboard in your browser. Pick the zone (domain) you want to authorize and the browser sends a certificate back to `cloudflared`, which stores it at `~/.cloudflared/cert.pem`.

If you do not have a Cloudflare account yet, you can create one for free at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). To use named tunnels, your domain's DNS must be served by Cloudflare.
