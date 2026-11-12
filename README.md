# Teratron Revival

A modern web revival of **Teratron**, a multiplayer Tron-style game originally written for MS-DOS. Built with pure P2P networking for zero server costs.

## 🎮 About

Teratron is a fast-paced multiplayer game where 2-4 players control vehicles that leave colored trails. Avoid colliding with trails while using power-ups and weapons to eliminate opponents. Last player standing wins!

## 🏗️ Architecture

- **Pure P2P Multiplayer**
- **TypeScript** - Type-safe client-side code
- **Canvas 2D** - Pixel-perfect retro graphics

See [design/architecture.md](./design/architecture.md) for complete technical details.

## 🚀 Quick Start

### Prerequisites (macOS)

```bash
# Install system dependencies
brew bundle

# Set up local HTTPS certificates (one-time)
mkcert -install
mkdir -p .certs && cd .certs && mkcert localhost 127.0.0.1 ::1
```

### Development

```bash
npm install          # Install dependencies
npm run dev          # Start development server (https://localhost:3000/tron-revival/)
npm run build        # Type-check and build for production
npm run preview      # Preview production build

npm test             # Unit, bot and netcode tests (headless, ~1 min)
npm run test:e2e     # Two headless Chromes playing a network game (needs Chrome + internet)
npm run sim          # Bot statistics per level (for tuning the AI)

npm run sprites      # Rebuild sprite sheet (after changing sprites-source/)
npm run deploy       # Deploy to GitHub Pages
```

The HTTPS certificates are optional: without `.certs/` the dev server uses plain HTTP
(fine on localhost; phones on the LAN need HTTPS for WebRTC).

### Multiplayer across networks (TURN)

Direct peer-to-peer connections fail for roughly 10–15 % of player pairs (mobile data,
strict firewalls). To cover them, configure a TURN relay at build time — copy
`.env.example` to `.env.local` and see [design/networking.md](./design/networking.md).
The lobby warns when no TURN server is configured.

Debug switches (URL parameters): `?lag=120&jitter=40` adds artificial latency,
`?relay=1` forces all traffic through TURN. Press `F` in game for the debug overlay.

## 🌐 Deployment

### Deploy to GitHub Pages

```bash
npm run deploy
```

This builds the project and publishes to the `gh-pages` branch. The game will be available at:
`https://<username>.github.io/tron-revival/`

### First-time setup

After the first deploy, enable GitHub Pages in repository settings:
1. Go to Settings → Pages
2. Set Source to "Deploy from a branch"
3. Select `gh-pages` branch and `/ (root)` folder

## 📁 Project Structure

```
tron-revival/
├── src/
├── public/
│   └── assets/     # Graphics, sounds, fonts
├── design/         # Design documentation
└── old-tron/       # Original game reference
```

## 📚 Documentation

- [CLAUDE.md](./CLAUDE.md) - Development methodology
- [design/architecture.md](./design/architecture.md) - Technical architecture
- [design/networking.md](./design/networking.md) - Multiplayer: connectivity, lobby, netcode
- [design/local-and-ai.md](./design/local-and-ai.md) - Local play, sessions and AI players
- [design/level-hazards.md](./design/level-hazards.md) - Level hazards (automatic doors)
- [TODO.md](./TODO.md) - Backlog
- [design/old-tron-design.md](./design/old-tron-design.md) - Original game mechanics


## 📜 License

ISC

## 🎨 Original Game

Created by Sebastian Ortega in 2001 for MS-DOS using Div2.
