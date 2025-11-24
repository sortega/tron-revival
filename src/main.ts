/**
 * Teratron - Main Entry Point
 */

import { Game } from './game/Game';
import { UIManager } from './ui/UIManager';
import { GAME_WIDTH, GAME_HEIGHT } from './constants';

console.log('🎮 Teratron Revival - Phase 1 Demo');
console.log(`Canvas size: ${GAME_WIDTH}x${GAME_HEIGHT}`);

// Get the app container
const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App container not found');
}

// Clear container
app.innerHTML = '';

// Game state
let game: Game | null = null;
let gameContainer: HTMLElement | null = null;
let uiManager: UIManager | null = null;

/**
 * Start local game
 */
function startLocalGame(numPlayers: number): void {
  console.log(`🎮 Starting local game with ${numPlayers} players`);

  if (!app) return;

  // Clear app and set up game UI
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
  gameContainer = document.createElement('div');
  gameContainer.style.display = 'flex';
  gameContainer.style.justifyContent = 'center';
  gameContainer.style.alignItems = 'center';
  app.appendChild(gameContainer);

  // Stop existing game if any
  if (game) {
    game.stop();
  }

  // Initialize and start game
  game = new Game(gameContainer, numPlayers);
  game.start();

  console.log('✅ Game started! Use controls to play.');
}

/**
 * Create network room (Phase 2 - mock for now)
 */
function createRoom(): void {
  console.log('🌐 Create room - Coming in Phase 2!');
  // For Phase 1, just show lobby with mock data
  const mockRoomId = 'demo-room-' + Math.random().toString(36).substr(2, 9);

  if (uiManager) {
    uiManager.updateLobby(
      [
        {
          name: 'Player 1',
          color: 'rgb(255, 0, 0)',
          isReady: true,
          isHost: true,
          isYou: true,
        },
      ],
      mockRoomId
    );
  }
}

/**
 * Join network room (Phase 2 - mock for now)
 */
function joinRoom(roomId: string): void {
  console.log(`🌐 Join room: ${roomId} - Coming in Phase 2!`);
  // For Phase 1, just show lobby with mock data
  if (uiManager) {
    uiManager.updateLobby([
      {
        name: 'Host',
        color: 'rgb(255, 0, 0)',
        isReady: true,
        isHost: true,
      },
      {
        name: 'You',
        color: 'rgb(0, 255, 0)',
        isReady: false,
        isHost: false,
        isYou: true,
      },
    ]);
  }
}

/**
 * Start network game (Phase 2 - mock for now)
 */
function startNetworkGame(): void {
  console.log('🌐 Start network game - Coming in Phase 2!');
  // For Phase 1, just start a local 2-player game
  startLocalGame(2);
}

/**
 * Disconnect from network game
 */
function disconnect(): void {
  console.log('🔌 Disconnecting from network game');
  // Stop game if running
  if (game) {
    game.stop();
    game = null;
  }
  // Return to main menu
  initializeMenus();
}

/**
 * Initialize menu system
 */
function initializeMenus(): void {
  if (!app) return;

  // Clear app
  app.innerHTML = '';
  app.style.display = 'block';

  // Create UI manager
  uiManager = new UIManager(app, {
    onStartLocalGame: startLocalGame,
    onCreateRoom: createRoom,
    onJoinRoom: joinRoom,
    onStartGame: startNetworkGame,
    onDisconnect: disconnect,
  });

  // Show main menu
  uiManager.showScreen('main-menu');
}

// Handle ESC to exit to main menu (during post-round overlay)
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && game?.getRoundState() === 'waiting_for_ready') {
    console.log('🔙 Returning to main menu...');
    // Stop the game and return to menu
    if (game) {
      game.stop();
      game = null;
    }
    initializeMenus();
  }
});

// Initialize the menu system
initializeMenus();

console.log('✅ Menu system initialized!');
