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

```
omo-drive/
├── public/           # Frontend UI
│   ├── app.js        # Main application logic
│   ├── index.html    # Entry HTML
│   └── styles.css    # UI styles
├── test/             # Test files
├── index.ts          # Server entry point
├── pair.ts           # QR pairing scaffold (experimental)
└── CLAUDE.md         # Project conventions
```

## Notes

- **Voice requirements**: Microphone access requires HTTPS. Use Tailscale Serve (see README) for local HTTPS.
- **Large files**: The `models/` directory contains ML model weights and is excluded from version control.
