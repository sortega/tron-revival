/**
 * Lobby
 * Pre-game lobby with player list and ready indicators
 */

export interface LobbyPlayer {
  name: string;
  color: string;
  isReady: boolean;
  isHost: boolean;
  isYou?: boolean;
}

export class Lobby {
  private onStartGame: () => void;
  private onDisconnect: () => void;
  private players: LobbyPlayer[] = [];
  private roomId?: string;
  private isHost = false;
  private container?: HTMLElement;

  constructor(onStartGame: () => void, onDisconnect: () => void) {
    this.onStartGame = onStartGame;
    this.onDisconnect = onDisconnect;
  }

  render(): HTMLElement {
    this.container = document.createElement('div');
    this.container.className = 'menu-screen lobby-screen';

    this.updateUI();

    return this.container;
  }

  /**
   * Update player list (called from UIManager)
   */
  updatePlayers(players: LobbyPlayer[], roomId?: string): void {
    this.players = players;
    this.roomId = roomId;
    this.isHost = players.some((p) => p.isHost && p.isYou);

    if (this.container) {
      this.updateUI();
    }
  }

  private updateUI(): void {
    if (!this.container) return;

    const playerCount = this.players.length;
    const maxPlayers = 4;

    this.container.innerHTML = `
      <div class="menu-content">
        <h1 class="menu-title">LOBBY</h1>
        <div class="lobby-info">
          <p>Players: ${playerCount}/${maxPlayers}</p>
        </div>
        <div class="player-list">
          ${this.renderPlayerSlots()}
        </div>
        ${this.roomId ? this.renderRoomInfo() : ''}
        <div class="menu-buttons">
          ${this.renderActionButtons()}
        </div>
      </div>
    `;

    // Add event listeners
    this.attachEventListeners();
  }

  private renderPlayerSlots(): string {
    const slots = [];
    const colors = ['RED', 'GREEN', 'BLUE', 'YELLOW'];

    for (let i = 0; i < 4; i++) {
      const player = this.players[i];

      if (player) {
        const labels = [];
        if (player.isYou) labels.push('You');
        if (player.isHost) labels.push('Host');
        const labelText = labels.length > 0 ? ` (${labels.join(', ')})` : '';

        slots.push(`
          <div class="player-slot filled">
            <span class="player-color" style="background-color: ${player.color}"></span>
            <span class="player-name">${colors[i]} - ${player.name}${labelText}</span>
            <span class="player-ready">${player.isReady ? '✓' : ''}</span>
          </div>
        `);
      } else {
        slots.push(`
          <div class="player-slot empty">
            <span class="player-color" style="background-color: gray"></span>
            <span class="player-name">${colors[i]} - Waiting...</span>
            <span class="player-ready"></span>
          </div>
        `);
      }
    }

    return slots.join('');
  }

  private renderRoomInfo(): string {
    const fullUrl = `${window.location.origin}${window.location.pathname}?room=${this.roomId}`;

    return `
      <div class="room-info">
        <p class="room-code-label">Room Code: <strong>${this.roomId}</strong></p>
        <div class="room-link-container">
          <input type="text" class="room-link-input" value="${fullUrl}" readonly>
          <button class="copy-button" data-action="copy-link">Copy Link</button>
        </div>
      </div>
    `;
  }

  private renderActionButtons(): string {
    if (this.isHost) {
      const canStart = this.players.length >= 2;
      return `
        <button
          class="menu-button"
          data-action="start-game"
          ${!canStart ? 'disabled' : ''}
        >
          Start Game
        </button>
        <button class="menu-button menu-button-secondary" data-action="disconnect">
          Disconnect
        </button>
      `;
    } else {
      return `
        <p class="waiting-text">Waiting for host to start...</p>
        <button class="menu-button menu-button-secondary" data-action="disconnect">
          Disconnect
        </button>
      `;
    }
  }

  private attachEventListeners(): void {
    if (!this.container) return;

    const startBtn = this.container.querySelector('[data-action="start-game"]') as HTMLButtonElement | null;
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        this.onStartGame();
      });
    }

    const disconnectBtn = this.container.querySelector('[data-action="disconnect"]') as HTMLButtonElement | null;
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', () => {
        this.onDisconnect();
      });
    }

    const copyBtn = this.container.querySelector('[data-action="copy-link"]') as HTMLButtonElement | null;
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const input = this.container?.querySelector('.room-link-input') as HTMLInputElement;
        if (input) {
          try {
            await navigator.clipboard.writeText(input.value);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => {
              copyBtn.textContent = 'Copy Link';
            }, 2000);
          } catch (err) {
            console.error('Failed to copy:', err);
            copyBtn.textContent = 'Failed';
            setTimeout(() => {
              copyBtn.textContent = 'Copy Link';
            }, 2000);
          }
        }
      });
    }
  }
}
