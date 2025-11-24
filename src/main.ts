/**
 * Teratron - Main Entry Point
 */

import { Game } from './game/Game';
import { UIManager } from './ui/UIManager';
import { HostManager } from './network/HostManager';
import { GuestManager } from './network/GuestManager';
import { GAME_WIDTH, GAME_HEIGHT, PLAYER_COLORS } from './constants';
import type { LobbyPlayer } from './ui/Lobby';

console.log('🎮 Teratron Revival - Phase 2 Demo (Networking)');
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

// Network state
let hostManager: HostManager | null = null;
let guestManager: GuestManager | null = null;
let isHost = false;
let currentRoomId: string | null = null;

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
 * Create network room
 */
async function createRoom(): Promise<void> {
  console.log('🌐 Creating room...');

  try {
    // Create host manager
    hostManager = new HostManager();
    isHost = true;

    // Create room
    currentRoomId = await hostManager.createRoom();
    console.log(`✅ Room created: ${currentRoomId}`);

    // Setup host callbacks
    hostManager.onGuestJoined((playerInfo) => {
      console.log(`👋 Guest joined: ${playerInfo.name}`);
      updateLobbyFromNetwork();
    });

    hostManager.onGuestLeft((playerId) => {
      console.log(`👋 Guest left: ${playerId}`);
      updateLobbyFromNetwork();
    });

    // Show lobby with host as only player
    updateLobbyFromNetwork();
  } catch (error) {
    console.error('Failed to create room:', error);
    alert('Failed to create room. Please try again.');
    initializeMenus();
  }
}

/**
 * Join network room
 */
async function joinRoom(roomId: string): Promise<void> {
  console.log(`🌐 Joining room: ${roomId}...`);

  try {
    // Create guest manager
    guestManager = new GuestManager();
    isHost = false;
    currentRoomId = roomId;

    // Setup guest callbacks
    guestManager.onWelcome((_playerId, playerNum, _roomInfo) => {
      console.log(`✅ Welcomed as Player ${playerNum}`);
      updateLobbyFromNetwork();
    });

    guestManager.onPlayerJoined((player) => {
      console.log(`👋 Player joined: ${player.name}`);
      updateLobbyFromNetwork();
    });

    guestManager.onPlayerLeft((playerId) => {
      console.log(`👋 Player left: ${playerId}`);
      updateLobbyFromNetwork();
    });

    guestManager.onDisconnected(() => {
      console.log('🔌 Disconnected from host');
      alert('Disconnected from host');
      cleanupNetwork();
      initializeMenus();
    });

    guestManager.onError((code, message) => {
      console.error(`Error: ${code} - ${message}`);
      alert(`Error: ${message}`);
      cleanupNetwork();
      initializeMenus();
    });

    // Join the room
    const playerName = `Guest-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    console.log(`Attempting to join room ${roomId} as ${playerName}...`);
    await guestManager.joinRoom(roomId, playerName);
  } catch (error) {
    console.error('Failed to join room - Full error:', error);
    console.error('Error type:', typeof error);
    console.error('Error message:', error instanceof Error ? error.message : String(error));

    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    alert(`Failed to join room: ${errorMsg}\n\nPlease check:\n- Room code is correct\n- Host is still connected\n- Both browsers have WebRTC enabled`);

    cleanupNetwork();
    initializeMenus();
  }
}

/**
 * Update lobby from network state
 */
function updateLobbyFromNetwork(): void {
  if (!uiManager) return;

  const players: LobbyPlayer[] = [];

  if (isHost && hostManager) {
    // Host player (always first)
    players.push({
      name: 'Host (You)',
      color: `rgb(${PLAYER_COLORS.RED.r}, ${PLAYER_COLORS.RED.g}, ${PLAYER_COLORS.RED.b})`,
      isReady: true,
      isHost: true,
      isYou: true,
    });

    // Add guests
    const guests = hostManager.getGuestPlayerInfo();
    for (const guest of guests) {
      players.push({
        name: guest.name,
        color: `rgb(${guest.color.r}, ${guest.color.g}, ${guest.color.b})`,
        isReady: guest.isReady,
        isHost: false,
        isYou: false,
      });
    }
  } else if (guestManager) {
    const roomInfo = guestManager.getRoomInfo();
    const localPlayerId = guestManager.getLocalPlayerId();

    if (roomInfo) {
      // Add host
      players.push({
        name: 'Host',
        color: `rgb(${PLAYER_COLORS.RED.r}, ${PLAYER_COLORS.RED.g}, ${PLAYER_COLORS.RED.b})`,
        isReady: true,
        isHost: true,
        isYou: false,
      });

      // Add all guests (including self)
      for (const player of roomInfo.players) {
        players.push({
          name: player.id === localPlayerId ? `${player.name} (You)` : player.name,
          color: `rgb(${player.color.r}, ${player.color.g}, ${player.color.b})`,
          isReady: player.isReady,
          isHost: false,
          isYou: player.id === localPlayerId,
        });
      }
    }
  }

  uiManager.updateLobby(players, currentRoomId || undefined);
}

/**
 * Start network game (host only)
 */
function startNetworkGame(): void {
  if (!isHost) {
    console.log('Only host can start the game');
    return;
  }

  console.log('🌐 Starting network game...');
  // For Phase 2, just start a local game
  // Phase 3 will add full network synchronization
  startLocalGame(2);
}

/**
 * Cleanup network connections
 */
function cleanupNetwork(): void {
  if (hostManager) {
    hostManager.destroy();
    hostManager = null;
  }
  if (guestManager) {
    guestManager.destroy();
    guestManager = null;
  }
  isHost = false;
  currentRoomId = null;
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

  // Cleanup network
  cleanupNetwork();

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
