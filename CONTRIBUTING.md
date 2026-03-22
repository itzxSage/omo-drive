# Contributing to omo-drive

Thank you for your interest in contributing!

## Getting Started

1. **Clone the repository**
   ```bash
   git clone https://github.com/itzxSage/omo-drive.git
   cd omo-drive
   ```

2. **Install dependencies**
   ```bash
   bun install
   ```

3. **Run locally**
   ```bash
   bun run index.ts
   ```
   Visit `http://localhost:8080` in your browser.

## Development Workflow

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test test/ui.spec.ts

# Run with Playwright UI
bunx playwright test
```

### Code Style

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Run `bun test` before submitting PRs

### Submitting Changes

1. **Create a branch** for your changes
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** and test them

3. **Commit** with a clear message
   ```bash
   git commit -m "Add: brief description of changes"
   ```

4. **Push and create a PR**
   ```bash
   git push origin feature/your-feature-name
   ```

## Project Structure

```text
omo-drive/
├── config.ts               # Centralized runtime configuration
├── trust.ts                # Trust store and session lifecycle
├── product-store.ts        # SQLite persistence (dispatch, review, decisions)
├── product-api.ts          # Typed product API
├── server/
│   ├── app.ts              # App factory
│   ├── pairing.ts          # QR pairing helper
│   └── routes/             # Modular route handlers
├── public/
│   ├── index.html          # Shell entry (Live / Dispatch / Review)
│   ├── styles.css          # UI styles
│   ├── app.js              # Shell bootstrap
│   └── app/                # Modular frontend modules
├── test/                   # Bun unit tests (.test.ts) and Playwright specs (.pw.ts)
├── docs/
│   └── operator-policy.md  # Operator policy reference
└── index.ts                # Server entry point
```

## Running Playwright Specs

The default `bunx playwright test` only runs `*.spec.ts` files. To run the full `.pw.ts` browser suite:

```bash
bunx playwright test --config=playwright.pw.config.ts
```

## Notes

- **HTTPS for Live mode**: Microphone access requires HTTPS. Use Tailscale Serve (see README).
- **Model weights**: The `models/` directory contains Whisper model weights and is excluded from version control.
- **Trust required**: Protected routes (`/api/stt`, `/api/opencode/*`, `/api/screenshot`, `/api/product/*`) require a paired, trusted device. Pair via the QR code shown at server startup.
