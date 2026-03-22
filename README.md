# omo-drive

The trusted mobile bridge for OpenCode. **Live** steers the active session, **Dispatch** sends scoped work for later execution, and **Review** brings back blocked or completed work with the context needed to decide the next step.

## Features

- **Live** — Push-to-talk voice input, screenshot capture, session and model switching; controls the active OpenCode session in real time
- **Dispatch** — Queue scoped work requests for execution while away from the machine; persisted and auditable
- **Review** — Inbox for blocked and completed work; surfaces voicemail summaries, context, timelines, and decision actions
- **Trust & pairing** — Device pairing with bootstrap tokens, session lifecycle, and explicit trust states; unpaired access is blocked by default
- **Tailscale HTTPS** — Operate from a phone or tablet securely over your private tailnet

## Quick Start

```bash
# Install dependencies
bun install

# Run the server
bun run index.ts

# Visit in browser
open http://localhost:8080
```

## Pairing

omo-drive requires a trusted device before protected routes activate.

1. Open the app — the shell shows the current trust state
2. Scan the QR code shown at server startup to begin pairing
3. Complete the bootstrap token flow to become a trusted device

Device trust can be revoked at any time from the shell or via `DELETE /api/pair`.

## HTTPS Requirement for Live Mode

Microphone access in Live mode requires HTTPS. The browser will not grant microphone permissions over HTTP.

### Tailscale HTTPS (Recommended)

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve 8080
```

Then access via your Tailscale device hostname (e.g., `https://your-device.tailnet.ts.net/`).

## Project Structure

```text
omo-drive/
├── config.ts               # Centralized runtime configuration
├── trust.ts                # Trust store, session lifecycle, audit events
├── product-store.ts        # SQLite persistence for dispatch, review, decisions
├── product-api.ts          # Typed product API (dispatch, review, handoffs)
├── server/
│   ├── app.ts              # App factory
│   ├── pairing.ts          # Bootstrap token + QR pairing helper
│   └── routes/             # Modular route handlers (pair, trust, proxy, stt, screenshot, model)
├── public/
│   ├── index.html          # Shell entry point (Live / Dispatch / Review)
│   ├── styles.css          # UI styles
│   ├── app.js              # Shell bootstrap and mode routing
│   └── app/                # Modular frontend (trust-boot, dispatch-mode, review-inbox, ...)
├── test/                   # Bun unit tests and Playwright browser specs
├── docs/
│   └── operator-policy.md  # Action policy matrix and operator expectations
└── index.ts                # Server entry point
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and development workflow.

## Out of Scope

omo-drive is a bridge layer, not an auth platform. It does not implement accounts, RBAC, SSO, multi-tenant identity, or arbitrary shell access beyond what OpenCode exposes through its own session API.

## License

MIT — see [LICENSE](LICENSE)
