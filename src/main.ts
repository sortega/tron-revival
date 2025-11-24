/**
 * Teratron - Main Entry Point
 */

import { Game } from './game/Game';
import { GAME_WIDTH, GAME_HEIGHT } from './constants';

console.log('🎮 Teratron Revival - Phase 1 Demo');
console.log(`Canvas size: ${GAME_WIDTH}x${GAME_HEIGHT}`);

// Get the app container
const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App container not found');
}

// Clear container and set up game UI
app.innerHTML = '';
app.style.display = 'flex';
app.style.flexDirection = 'column';
app.style.alignItems = 'center';
app.style.justifyContent = 'center';
app.style.gap = '20px';

// Add title
const title = document.createElement('h1');
title.textContent = 'TERATRON';
title.style.fontSize = '2rem';
title.style.color = '#0f0';
title.style.marginBottom = '10px';
app.appendChild(title);

// Add controls info
const controls = document.createElement('div');
controls.style.textAlign = 'center';
controls.style.color = '#888';
controls.style.fontSize = '0.9rem';
controls.innerHTML = `
  <p><strong>Player 1 (Red):</strong> Z = Left, X = Right, L-Ctrl = Fire</p>
  <p><strong>Player 2 (Green):</strong> Arrow Left, Arrow Right, R-Option = Fire</p>
`;
app.appendChild(controls);

// Create game container
const gameContainer = document.createElement('div');
app.appendChild(gameContainer);

// Initialize and start game
let game: Game | null = null;

function startGame() {
  if (game) {
    game.stop();
  }

  // Clear the game container to remove old canvas
  gameContainer.innerHTML = '';

  game = new Game(gameContainer, 2); // 2-player demo
  game.start();
}

// Handle restart (only during post-round overlay)
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && game?.getRoundState() === 'waiting_for_ready') {
    console.log('🔄 Restarting game...');
    startGame();
  }
});

// Start the game!
startGame();

console.log('✅ Game initialized! Use controls to play.');
