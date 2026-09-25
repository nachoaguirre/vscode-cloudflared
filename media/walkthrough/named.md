## Step 4 · Create a tunnel on your domain

The **Create Named Tunnel** wizard runs the three commands you would otherwise type by hand:

1. `cloudflared tunnel create <name>` registers the tunnel and stores its credentials.
2. `cloudflared tunnel route dns <name> <hostname>` creates a CNAME record on your zone pointing to the tunnel.
3. `cloudflared tunnel run --url <local service> <name>` starts forwarding traffic.

The local service URL is remembered per tunnel, so next time you can start it with one click from the Tunnels view. Tunnels you created elsewhere (dashboard, other machines) also appear in the list. Tunnels created in the Zero Trust dashboard can be run here with **Run Tunnel with Token**.
