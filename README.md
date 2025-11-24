# Teratron Revival

A modern web revival of **Teratron**, a multiplayer Tron-style game originally written for MS-DOS. Built with pure P2P networking for zero server costs.

## 🎮 About

Teratron is a fast-paced multiplayer game where 2-4 players control vehicles that leave colored trails. Avoid colliding with trails while using power-ups and weapons to eliminate opponents. Last player standing wins!

## 🏗️ Architecture

- **Pure P2P Multiplayer** - WebRTC via PeerJS (no custom servers!)
- **TypeScript** - Type-safe client-side code
- **Canvas 2D** - Pixel-perfect retro graphics
- **Zero Infrastructure Cost** - $0/month to run

See [design/architecture.md](./design/architecture.md) for complete technical details.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## 📁 Project Structure

```
tron-revival/
├── src/
│   ├── game/       # Core game logic
│   ├── render/     # Canvas rendering
│   ├── network/    # P2P connections (PeerJS)
│   ├── ui/         # Menus and HUD
│   ├── types/      # TypeScript types
│   └── main.ts     # Entry point
├── public/
│   └── assets/     # Graphics, sounds, fonts
├── design/         # Design documentation
└── old-tron/       # Original game reference
```

## 📋 Development Phases

### ✅ Phase 0: Foundation (Complete)
- [x] Design documentation
- [x] Architecture decisions
- [x] Project setup
- [x] Dependencies installed

### 🔨 Phase 1: Core Mechanics (In Progress)
- [ ] Basic game loop
- [ ] Player movement and trails
- [ ] Collision detection
- [ ] Single-player demo

### 📡 Phase 2: Multiplayer
- [ ] PeerJS integration
- [ ] Host/guest architecture
- [ ] Shareable room links
- [ ] 2-player online demo

### 🎯 Phase 3: Complete Features
- [ ] All items and weapons
- [ ] All maps and hazards
- [ ] 4-player support
- [ ] Team mode

### ✨ Phase 4: Polish
- [ ] Performance optimization
- [ ] Browser compatibility
- [ ] UX improvements
- [ ] Deployment

## 🎯 Key Features

From the original game:
- 2-4 player free-for-all or 2v2 team mode
- 7 automatic power-ups (shield, crossing, speed, swap, etc.)
- 7 weapons (shots, rifle, machine gun, missile, shotgun, etc.)
- 8 maps with unique hazards
- Portal system
- Pixel-perfect collision

## 📚 Documentation

- [CLAUDE.md](./CLAUDE.md) - Development methodology
- [design/architecture.md](./design/architecture.md) - Technical architecture
- [design/old-tron-design.md](./design/old-tron-design.md) - Original game mechanics

## 🛠️ Tech Stack

- **Language**: TypeScript
- **Build Tool**: Vite
- **Networking**: PeerJS (WebRTC)
- **Rendering**: Canvas 2D API
- **Package Manager**: npm

## 📜 License

ISC

## 🎨 Original Game

Created by Sebastian Ortega in 2001 for MS-DOS using Div2.
