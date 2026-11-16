# Using the app away from home (Tailscale)

The laptop stays at home and keeps running the server. The phone reaches it over
[Tailscale](https://tailscale.com): a private, encrypted network that only your own signed-in
devices can join. Nothing is exposed to the internet: no router port forwarding, no public
address, no cloud hosting. The server key and Firebase sign-in still protect every request.

What works without any connection to the laptop:

- **Recording** always works. Audio is saved on the phone in chunks and uploads automatically,
  with retries, as soon as the laptop is reachable again. Nothing is lost if you are offline.
- Events and notes you already have stay readable on the phone. Notes sync through Firebase,
  not through the laptop.

What needs the laptop to be reachable: the live transcript, uploads, AI cleanup and briefs,
translation, and exports produced on the laptop.

## One-time setup

1. **Laptop:** install Tailscale from <https://tailscale.com/download> and sign in.
   The personal plan is free.
2. **Phone:** install **Tailscale** from the Play Store and sign in with the **same account**.
3. **Phone:** keep Tailscale connected all the time. In Android Settings > Network & internet >
   VPN > Tailscale (gear icon), turn on **Always-on VPN**. Tailscale uses a direct local path
   when you are at home, so this costs little battery.
4. **Laptop:** in Docker Desktop > Settings > General, turn on **Start Docker Desktop when you
   sign in**. The server container already restarts by itself (`restart: unless-stopped`),
   so after a reboot and Windows sign-in the server comes back with no action.
5. **Laptop power:** plugged in, set sleep to **Never** (Settings > System > Power). Keep the
   lid open, or set "When I close the lid" to **Do nothing** when plugged in (Control Panel >
   Power Options > Choose what closing the lid does). A sleeping laptop cannot answer.
6. **Check:** double-click `server\remote-check.bat`. It only reads and checks; it changes
   nothing and never shows the server key. It shows:
   - whether Tailscale is connected and your phone is in the tailnet;
   - whether the server answers on the Tailscale address;
   - whether Docker auto-start, restart and sleep settings are right;
   - the address to use, with a QR code.
7. **Phone, in the app:** Settings > Connect laptop. Scan the QR (or type the
   `http://100.x.y.z:8000` address), then tap **Test connection**, enter the server key, and tap
   **Verify sign-in** and **Save connection**. Use this one Tailscale address everywhere:
   it also works at home.
8. **Real test:** turn Wi-Fi off on the phone (mobile data only), open the app and tap
   **Test connection**. "Laptop · connected" means remote access works.

The Tailscale address (`100.x.y.z`) stays the same for this laptop. The MagicDNS name
(`laptop-name.tailnet-name.ts.net`) also works and is accepted by the app.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Test connection fails outside, works at home on the LAN address | You are still using the LAN address (`192.168.x.x`). Switch to the Tailscale address. |
| Fails everywhere on the Tailscale address | Tailscale is off on the phone or laptop, or they are signed in to different accounts. Run `remote-check.bat`. |
| `remote-check` passes but the phone still cannot connect | Windows Firewall is blocking inbound traffic on the Tailscale adapter. Allow TCP 8000 for the Tailscale interface only (Windows Security > Firewall > Advanced settings > Inbound rule, scope: Tailscale's `100.64.0.0/10`). Do not open it for Public networks. |
| Worked yesterday, not today | The laptop slept, rebooted without signing in, or Docker Desktop was closed. Check its power and sign-in, then run `remote-check.bat`. |
| Live transcript stalls on weak mobile data | Recording continues and uploads catch up automatically; the full transcript appears when the chunks arrive. |

## Why not other options

- **Router port forwarding** exposes the server to the whole internet. The project's security
  rules forbid it.
- **Cloudflare Tunnel** gives the server a public web address. Everyone on the internet can
  reach its sign-in door, and it needs a domain. Tailscale keeps the server private to your
  own devices.
- **Cloud hosting** is excluded by design: audio and transcripts stay on your laptop.
