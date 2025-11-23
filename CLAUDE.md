# Teratron Revival - Development Guide

## Project Overview

This project is a modern rewrite of **Teratron**, a multiplayer Tron-style game originally written in Div2 for MS-DOS. The goal is to bring the classic gameplay to the web using modern technologies while preserving the retro feel and core mechanics.

## Development Methodology

This project follows a **spec-driven development** approach:

### Process

1. **Design First** - All features and changes must be documented in `design/` before implementation
2. **Plan** - Create a detailed implementation plan
3. **Execute** - Implement the planned features
4. **Review** - Verify implementation matches the spec

### Rules

- **Never code before documenting** - If a feature isn't in `design/`, it doesn't get built
- **Update specs as you learn** - Discovery during implementation should flow back to design docs
- **Keep specs current** - Design docs are living documents, not write-once artifacts

## Repository Structure

### `design/` - Design Documentation

All design decisions, specifications, and architectural documentation live here:

- **`architecture.md`** - High-level technical decisions and system architecture
  - Links to detailed design documents as needed
  - Technology stack choices
  - System boundaries and interfaces

- **`old-tron-design.md`** - Complete documentation of the original Teratron game
  - Game mechanics
  - Controls
  - Items and weapons
  - Maps and features
  - Serves as the reference for what to recreate

- **Additional design docs** - Created as needed for specific subsystems:
  - `multiplayer.md` - Network architecture and synchronization
  - `rendering.md` - Graphics rendering approach
  - `game-state.md` - Game state management
  - etc.

### `old-tron/` - Original Game Files

Contains the original Div2 source code and assets from the MS-DOS version. This is reference material only - not executed code.

### Source Code

(Structure TBD - will be defined in `design/architecture.md`)

## Working with Claude on This Project

When requesting features or changes:

1. **Start with design** - Ask Claude to document in `design/` first
2. **Review the spec** - Read and approve the design before implementation
3. **Reference design docs** - Point to specific sections when discussing features
4. **Keep it iterative** - It's okay to revise designs as you learn

## Key Decisions

- **Language**: TypeScript
- **Style**: Retro graphics, faithful gameplay, modern UX where appropriate
- **Multiplayer**: Built-in from the start, private rooms with shareable links
- **Performance**: Must run smoothly in typical modern browsers
