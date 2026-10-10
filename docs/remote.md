# Phone remote

Spatial's Windows app can host a small remote-control website on your local network. Scan a QR code with your phone to browse the library and control the desktop player from your listening position. The Windows player continues sending the original Dolby bitstream over HDMI; the phone does not play audio.

## Connect a phone

1. Open **Settings → Phone remote** in the desktop app.
2. Choose the PC's Wi-Fi or Ethernet address, then enable the remote.
3. Keep your phone on the same local network as the PC. Scan the QR code with the phone's camera and open the link in its browser.
4. If Windows Firewall asks, allow Spatial on **private networks**.

The remote opens on port **8790**. No music-server update, additional service, Docker container, account or phone app is required. Spatial must remain open on the PC. Select the HDMI output there before starting playback from the phone.

Use **New code** to pair another phone. Each QR code works once and expires after five minutes. **Copy link** is available when scanning is inconvenient. A paired browser remembers its connection for up to eight hours while the desktop remote is running. Closing the desktop app, changing the music-server connection, installing an update or turning off the remote revokes all phone sessions. Scan a new code after enabling it again.

## Controls

- Play, pause, skip, restart the current track and seek.
- Browse albums and tracks, search the collection and play an album in track order.
- Open the desktop's queue and jump to a particular queue entry.
- Toggle shuffle and repeat, including repeat of the current track.
- Save or remove favorite tracks on the connected desktop, and filter the phone's track list to those favorites.

The phone follows the desktop's current artwork and album colors. Controls and queue changes are shared with the desktop. The browser refreshes the state approximately once a second while visible, and checks it again when returning from another app. Network interruptions show a connection message and disable transport controls until Spatial can be reached again.

While the remote is enabled, a native refresh clock also keeps desktop playback status and queue progression updating in the background.

## Connection troubleshooting

If the QR link does not open, check that the chosen address belongs to the PC's active Wi-Fi or Ethernet adapter. VPNs and virtual adapters can appear in the address list. Try the other adapter, and generate a new code if the previous one expired.

Guest Wi-Fi and access-point isolation can prevent phones from reaching other devices. Use a network that allows local device connections. If Windows did not show a firewall prompt, allow inbound **TCP 8790** for Spatial on the **Private** profile, limited to the **Local subnet**. Do not forward this port on a router.

The first version supports local IPv4 addresses in the `10.x`, `172.16–31.x` and `192.168.x` ranges. If the PC's network address changes, turn the remote off, choose its new address, and enable it again.

## Pairing and privacy

The remote is off until enabled, and listens only on the selected local interface. Pairing uses a random secret in the QR URL's fragment; the browser removes it from the address bar before sending a same-origin pairing request. The secret is never a music-server access token. Successful pairing creates a separate, random, HttpOnly session cookie with SameSite=Strict. Pairing secrets and sessions are kept in desktop memory.

The service checks request origin, host and local peer addresses. It exposes a limited set of typed player commands, catalog metadata and artwork to paired browsers. It does not expose Tauri IPC, source paths, streaming URLs, audio files or server credentials. Artwork is fetched through the desktop's existing server connection and cached in memory with a size limit.

The local connection uses HTTP without TLS, so use the remote on a trusted private network. It is intended for control within that network, not access over the public internet. No remote-control data or artwork is uploaded to a third-party service.
