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
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Rebuild sprite sheet (after adding/modifying sprites in public/assets/sprites/items/)
npm run sprites

# Deploy to GitHub Pages
npm run deploy
```

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
- [design/old-tron-design.md](./design/old-tron-design.md) - Original game mechanics


## 📜 License

ISC

## 🎨 Original Game

Created by Sebastian Ortega in 2001 for MS-DOS using Div2.
