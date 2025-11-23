/**
 * Teratron - Main Entry Point
 */

import { GAME_WIDTH, GAME_HEIGHT } from './constants';

console.log('🎮 Teratron Revival');
console.log(`Canvas size: ${GAME_WIDTH}x${GAME_HEIGHT}`);

// Get the app container
const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App container not found');
}

// Create welcome screen
app.innerHTML = `
  <div style="text-align: center;">
    <h1 style="font-size: 3rem; margin-bottom: 2rem; color: #0f0;">
      TERATRON
    </h1>
    <p style="font-size: 1.2rem; margin-bottom: 1rem;">
      A modern revival of the classic multiplayer Tron game
    </p>
    <p style="font-size: 1rem; color: #888;">
      Phase 1: Core Mechanics (Coming Soon)
    </p>
    <div style="margin-top: 3rem;">
      <p style="font-size: 0.9rem; color: #666;">
        Press F12 to open console for development info
      </p>
    </div>
  </div>
`;

console.log('Project structure initialized successfully!');
console.log('Ready for Phase 1 implementation');
