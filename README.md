# omo-drive

Voice-driven remote interface for OpenCode with tap-to-toggle recording, light-mode UI, and error handling.

## Features

- **Tap-to-toggle recording** — Press once to start recording, press again to stop
- **Light-mode UI** — Clean, ChatGPT-inspired design
- **Error toasts** — Clear feedback on errors
- **Session management** — Multiple sessions with easy switching
- **Model switching** — Support for multiple AI providers
- **QR pairing** — Quick device pairing (experimental)

## Quick Start

```bash
# Install dependencies
bun install

# Run the server
bun run index.ts

# Visit in browser
open http://localhost:8080
```

## Voice Requirements

**Microphone access requires HTTPS.** The browser will not grant microphone permissions over HTTP.

### Tailscale HTTPS (Recommended)

Expose `omo-drive` to your tailnet via HTTPS:

1. **Enable HTTPS Certificates** in the [Tailscale Admin Console](https://login.tailscale.com/admin/settings/dns)
2. **Run Tailscale Serve**:
   ```bash
   /Applications/Tailscale.app/Contents/MacOS/Tailscale serve 8080
   ```
3. Access via your Tailscale device name (e.g., `https://your-device.tailnet.ts.net/`)

## Project Structure

```
omo-drive/
├── public/           # Frontend UI
│   ├── app.js        # Main application logic
│   ├── index.html    # Entry HTML
│   └── styles.css    # UI styles
├── test/             # Test files
├── index.ts          # Server entry point
└── pair.ts           # QR pairing scaffold (experimental)
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and development workflow.

## License

MIT — see [LICENSE](LICENSE)
