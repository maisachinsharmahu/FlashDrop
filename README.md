# FlashDrop LAN

Private phone-to-Mac file transfer over the same Wi‑Fi. The Mac hosts a local Next.js receiver; the phone scans a QR and sends files from its browser.

## Run

```bash
npm install
npm run build
npm start
```

Open `http://localhost:43110` on the Mac. Scan the QR with the phone while both devices are on the same Wi‑Fi.

Files are saved to `~/Downloads/FlashDrop`. Override with `FLASHDROP_DESTINATION=/path/to/folder` and the port with `PORT=43110`.

## Transfer behavior

- 8 MiB chunks, three concurrent upload lanes
- ChaCha20-Poly1305 encryption per chunk using the QR session key (works on local HTTP without a certificate)
- Automatic retry with exponential backoff
- Resume after a connection drop while the browser still holds the selected file
- Collision-safe filenames and partial-file staging before atomic completion

The site is intentionally LAN-only and rejects public source addresses. HTTP on a local network cannot authenticate the page itself against an active man-in-the-middle; the encrypted chunk protocol protects content from passive network capture. Use a trusted private Wi‑Fi network.
