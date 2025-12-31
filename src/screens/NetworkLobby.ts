// Network lobby screen

import type { Screen, ScreenManager, LobbyOptions } from './ScreenManager';
import { LobbyConnection } from '../network/LobbyConnection';
import { GameConnection } from '../network/GameConnection';
import type { LobbyState, SlotIndex, GameMode } from '../types/lobby';
import { getSlotColor, canStartGame, getFilledSlotCount, findFirstOpenSlot } from '../types/lobby';
import type { GameConfig, GamePlayer, Spectator } from '../types/game';
import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';

function generateNickname(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '',
    style: 'capital',
    length: 2,
  });
}

export class NetworkLobby implements Screen {
  private container: HTMLElement;
  private screenManager: ScreenManager;
  private options: LobbyOptions;
  private connection: LobbyConnection;
  private lobbyState: LobbyState | null = null;
  private myNickname: string = '';
  private connectionTimeoutId: number | null = null;

  constructor(container: HTMLElement, screenManager: ScreenManager, options: LobbyOptions) {
    this.container = container;
    this.screenManager = screenManager;
    this.options = options;
    this.connection = new LobbyConnection(options.mode === 'host');
  }

  render(): void {
    this.myNickname = localStorage.getItem('teratron-nickname') || generateNickname();

    this.container.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        min-height: 100vh;
        padding: 1rem;
      ">
        <h1 style="
          color: #0ff;
          text-shadow: 0 0 10px #0ff;
          margin-bottom: 1rem;
          text-align: center;
        ">LOBBY</h1>

        <div id="connectionStatus" style="
          text-align: center;
          color: #ff0;
          margin-bottom: 1rem;
        ">Connecting...</div>

        <div id="lobbyContent" style="
          display: none;
          flex: 1;
          display: grid;
          grid-template-columns: 250px 350px 300px;
          gap: 1rem;
          max-width: 1200px;
          margin: 0 auto;
          width: 100%;
        ">
          <!-- Left Panel: Settings/Info -->
          <div id="settingsPanel" style="
            background: #111;
            padding: 1rem;
            border-radius: 4px;
            border: 1px solid #333;
          "></div>

          <!-- Center Panel: Player Slots -->
          <div id="playersPanel" style="
            background: #111;
            padding: 1rem;
            border-radius: 4px;
            border: 1px solid #333;
          "></div>

          <!-- Right Panel: Chat -->
          <div id="chatPanel" style="
            background: #111;
            padding: 1rem;
            border-radius: 4px;
            border: 1px solid #333;
            display: flex;
            flex-direction: column;
          "></div>
        </div>
      </div>
    `;

    this.setupConnection();
  }

  private setupConnection(): void {
    this.connection.setCallbacks({
      onStatusChange: (status) => {
        console.log('[NetworkLobby] Status changed:', status);
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) {
          if (status === 'connecting') {
            statusEl.textContent = 'Connecting...';
            statusEl.style.color = '#ff0';
          } else if (status === 'connected') {
            if (this.options.mode === 'host') {
              statusEl.textContent = 'Room created - Waiting for players...';
              statusEl.style.color = '#0f0';
              document.getElementById('lobbyContent')!.style.display = 'grid';
            } else {
              // Guest: show lobby content immediately with connecting UI
              statusEl.textContent = 'Connecting...';
              statusEl.style.color = '#ff0';
              document.getElementById('lobbyContent')!.style.display = 'grid';
              this.renderConnectingUI();
            }
          } else {
            statusEl.textContent = 'Disconnected';
            statusEl.style.color = '#f44';
          }
        }
      },
      onLobbyStateUpdate: (state) => {
        console.log('[NetworkLobby] Received lobby state:', state);
        const isFirstState = this.lobbyState === null;
        this.lobbyState = state;
        // Show lobby content now that we have state
        const content = document.getElementById('lobbyContent');
        if (content) content.style.display = 'grid';
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) {
          statusEl.textContent = 'Connected';
          statusEl.style.color = '#0f0';
        }
        // Guest announces themselves when first receiving state
        if (isFirstState && this.options.mode === 'guest') {
          // Clear the connection timeout since we received data
          if (this.connectionTimeoutId !== null) {
            clearTimeout(this.connectionTimeoutId);
            this.connectionTimeoutId = null;
          }
          this.connection.announce(this.myNickname);
          // Auto-join the first open slot
          this.autoJoinFirstSlot();
        }
        this.updateUI();
      },
      onJoinAccepted: (_peerId, slotIndex) => {
        console.log('[NetworkLobby] Joined as slot', slotIndex);
      },
      onJoinRejected: (reason) => {
        alert(`Could not join: ${reason}`);
        this.screenManager.showMainMenu();
      },
      onGameStart: (_countdown) => {
        // Transition to game
        if (this.lobbyState) {
          const { gameConfig, gameConnection } = this.createGameSession();
          this.screenManager.showGame(gameConfig, gameConnection);
        }
      },
      onHostDisconnected: () => {
        alert('Host disconnected');
        this.screenManager.showMainMenu();
      },
      onError: (error) => {
        console.error('[NetworkLobby] Error:', error);
        alert(`Connection error: ${error}`);
      },
    });

    if (this.options.mode === 'host') {
      const roomId = this.connection.createRoom(this.myNickname);
      console.log('[NetworkLobby] Created room:', roomId);
      // Host announces itself and joins first slot
      this.connection.announce(this.myNickname);
      this.autoJoinFirstSlot();
    } else if (this.options.roomId) {
      this.connection.joinRoom(this.options.roomId, this.myNickname);
      // Guest will announce after receiving lobby state

      // Set timeout - if no lobby data arrives in 20 seconds, go back to menu
      this.connectionTimeoutId = window.setTimeout(() => {
        if (this.lobbyState === null) {
          console.log('[NetworkLobby] Connection timeout - no lobby data received');
          this.connection.disconnect();
          this.screenManager.showMainMenu();
        }
      }, 20000);
    }
  }

  private updateUI(): void {
    if (!this.lobbyState) return;

    this.renderSettingsPanel();
    this.renderPlayersPanel();
    this.renderChatPanel();
  }

  private renderSettingsPanel(): void {
    const panel = document.getElementById('settingsPanel');
    if (!panel || !this.lobbyState) return;

    const isHost = this.connection.isHostMode();
    const roomId = this.lobbyState.roomId;
    const link = `${window.location.origin}${window.location.pathname}?room=${roomId}`;

    if (isHost) {
      panel.innerHTML = `
        <h3 style="color: #0ff; margin-bottom: 1rem;">Settings</h3>

        <div style="margin-bottom: 1rem;">
          <label style="color: #888; display: block; margin-bottom: 0.5rem;">Game Mode:</label>
          <div style="display: flex; gap: 0.5rem;">
            <button id="ffaBtn" style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              cursor: pointer;
              background: ${this.lobbyState.gameMode === 'ffa' ? '#030' : '#111'};
              color: ${this.lobbyState.gameMode === 'ffa' ? '#0f0' : '#666'};
              border: 1px solid ${this.lobbyState.gameMode === 'ffa' ? '#0f0' : '#333'};
            ">FFA</button>
            <button id="teamBtn" style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              cursor: pointer;
              background: ${this.lobbyState.gameMode === 'team' ? '#030' : '#111'};
              color: ${this.lobbyState.gameMode === 'team' ? '#0f0' : '#666'};
              border: 1px solid ${this.lobbyState.gameMode === 'team' ? '#0f0' : '#333'};
            ">TEAMS</button>
          </div>
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="color: #888; display: block; margin-bottom: 0.5rem;">Your Nickname:</label>
          <div style="display: flex; gap: 0.5rem;">
            <input id="nicknameInput" type="text" value="${this.myNickname}" style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              background: #000;
              color: #0ff;
              border: 1px solid #0ff;
              box-sizing: border-box;
            " />
            <button id="randomNicknameBtn" title="Generate random nickname" style="
              padding: 0.5rem;
              font-family: monospace;
              cursor: pointer;
              background: #002;
              color: #08f;
              border: 1px solid #08f;
              font-size: 1rem;
            ">🎲</button>
          </div>
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="color: #888; display: block; margin-bottom: 0.5rem;">Room Code:</label>
          <div style="
            background: #000;
            padding: 0.5rem;
            border: 1px solid #333;
            color: #0f0;
            font-family: monospace;
            word-break: break-all;
            text-align: center;
            letter-spacing: 0.1em;
          ">${roomId}</div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
            <button id="copyCodeBtn" style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              cursor: pointer;
              background: #002;
              color: #08f;
              border: 1px solid #08f;
            ">📋 CODE</button>
            <button id="copyLinkBtn" style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              cursor: pointer;
              background: #002;
              color: #08f;
              border: 1px solid #08f;
            ">🔗 LINK</button>
          </div>
        </div>

        <button id="startGameBtn" style="
          width: 100%;
          padding: 1rem;
          font-size: 1.1rem;
          font-family: monospace;
          cursor: ${canStartGame(this.lobbyState) ? 'pointer' : 'not-allowed'};
          background: ${canStartGame(this.lobbyState) ? '#030' : '#111'};
          color: ${canStartGame(this.lobbyState) ? '#0f0' : '#666'};
          border: 2px solid ${canStartGame(this.lobbyState) ? '#0f0' : '#333'};
          margin-bottom: 0.5rem;
        " ${canStartGame(this.lobbyState) ? '' : 'disabled'}>
          START GAME
          ${this.lobbyState.gameMode === 'team' && getFilledSlotCount(this.lobbyState) < 4 ? '<br><span style="font-size: 0.7rem;">(needs 4 players)</span>' : ''}
        </button>

        <button id="disconnectBtn" style="
          width: 100%;
          padding: 0.5rem;
          font-family: monospace;
          cursor: pointer;
          background: #200;
          color: #f44;
          border: 1px solid #f44;
        ">DISCONNECT</button>
      `;

      // Event listeners
      document.getElementById('ffaBtn')?.addEventListener('click', () => {
        this.connection.setGameMode('ffa');
      });

      document.getElementById('teamBtn')?.addEventListener('click', () => {
        this.connection.setGameMode('team');
      });

      document.getElementById('nicknameInput')?.addEventListener('change', (e) => {
        const newNickname = (e.target as HTMLInputElement).value.trim();
        if (newNickname) {
          this.myNickname = newNickname;
          localStorage.setItem('teratron-nickname', newNickname);
          this.connection.sendNicknameChange(newNickname);
        }
      });

      document.getElementById('randomNicknameBtn')?.addEventListener('click', () => {
        const newNickname = generateNickname();
        this.myNickname = newNickname;
        localStorage.setItem('teratron-nickname', newNickname);
        this.connection.sendNicknameChange(newNickname);
        const input = document.getElementById('nicknameInput') as HTMLInputElement;
        if (input) input.value = newNickname;
      });

      document.getElementById('copyCodeBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(roomId).then(() => {
          const btn = document.getElementById('copyCodeBtn');
          if (btn) {
            btn.textContent = '✓ COPIED';
            setTimeout(() => { btn.textContent = '📋 CODE'; }, 2000);
          }
        });
      });

      document.getElementById('copyLinkBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(link).then(() => {
          const btn = document.getElementById('copyLinkBtn');
          if (btn) {
            btn.textContent = '✓ COPIED';
            setTimeout(() => { btn.textContent = '🔗 LINK'; }, 2000);
          }
        });
      });

      document.getElementById('startGameBtn')?.addEventListener('click', () => {
        if (canStartGame(this.lobbyState!)) {
          this.connection.startGame();
        }
      });

      document.getElementById('disconnectBtn')?.addEventListener('click', () => {
        this.connection.disconnect();
        this.screenManager.showMainMenu();
      });

    } else {
      // Guest view
      panel.innerHTML = `
        <h3 style="color: #0ff; margin-bottom: 1rem;">Info</h3>

        <div style="margin-bottom: 1rem;">
          <label style="color: #888; display: block; margin-bottom: 0.5rem;">Game Mode:</label>
          <div style="display: flex; gap: 0.5rem;">
            <button disabled style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              cursor: not-allowed;
              background: ${this.lobbyState.gameMode === 'ffa' ? '#020' : '#111'};
              color: ${this.lobbyState.gameMode === 'ffa' ? '#0a0' : '#444'};
              border: 1px solid ${this.lobbyState.gameMode === 'ffa' ? '#0a0' : '#333'};
            ">FFA</button>
            <button disabled style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              cursor: not-allowed;
              background: ${this.lobbyState.gameMode === 'team' ? '#020' : '#111'};
              color: ${this.lobbyState.gameMode === 'team' ? '#0a0' : '#444'};
              border: 1px solid ${this.lobbyState.gameMode === 'team' ? '#0a0' : '#333'};
            ">TEAMS</button>
          </div>
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="color: #888; display: block; margin-bottom: 0.5rem;">Your Nickname:</label>
          <div style="display: flex; gap: 0.5rem;">
            <input id="nicknameInput" type="text" value="${this.myNickname}" style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              background: #000;
              color: #0ff;
              border: 1px solid #0ff;
              box-sizing: border-box;
            " />
            <button id="randomNicknameBtn" title="Generate random nickname" style="
              padding: 0.5rem;
              font-family: monospace;
              cursor: pointer;
              background: #002;
              color: #08f;
              border: 1px solid #08f;
              font-size: 1rem;
            ">🎲</button>
          </div>
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="color: #888; display: block; margin-bottom: 0.5rem;">Room Code:</label>
          <div style="
            background: #000;
            padding: 0.5rem;
            border: 1px solid #333;
            color: #0f0;
            font-family: monospace;
            word-break: break-all;
            text-align: center;
            letter-spacing: 0.1em;
          ">${roomId}</div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
            <button id="copyCodeBtn" style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              cursor: pointer;
              background: #002;
              color: #08f;
              border: 1px solid #08f;
            ">📋 CODE</button>
            <button id="copyLinkBtn" style="
              flex: 1;
              padding: 0.5rem;
              font-family: monospace;
              cursor: pointer;
              background: #002;
              color: #08f;
              border: 1px solid #08f;
            ">🔗 LINK</button>
          </div>
        </div>

        <div style="
          background: #110;
          padding: 1rem;
          border: 1px solid #440;
          border-radius: 4px;
          color: #ff0;
          text-align: center;
          margin-bottom: 1rem;
        ">
          Waiting for host to start...
        </div>

        <button id="disconnectBtn" style="
          width: 100%;
          padding: 0.5rem;
          font-family: monospace;
          cursor: pointer;
          background: #200;
          color: #f44;
          border: 1px solid #f44;
        ">DISCONNECT</button>
      `;

      document.getElementById('nicknameInput')?.addEventListener('change', (e) => {
        const newNickname = (e.target as HTMLInputElement).value.trim();
        if (newNickname) {
          this.myNickname = newNickname;
          localStorage.setItem('teratron-nickname', newNickname);
          this.connection.sendNicknameChange(newNickname);
        }
      });

      document.getElementById('randomNicknameBtn')?.addEventListener('click', () => {
        const newNickname = generateNickname();
        this.myNickname = newNickname;
        localStorage.setItem('teratron-nickname', newNickname);
        this.connection.sendNicknameChange(newNickname);
        const input = document.getElementById('nicknameInput') as HTMLInputElement;
        if (input) input.value = newNickname;
      });

      document.getElementById('copyCodeBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(roomId).then(() => {
          const btn = document.getElementById('copyCodeBtn');
          if (btn) {
            btn.textContent = '✓ COPIED';
            setTimeout(() => { btn.textContent = '📋 CODE'; }, 2000);
          }
        });
      });

      document.getElementById('copyLinkBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(link).then(() => {
          const btn = document.getElementById('copyLinkBtn');
          if (btn) {
            btn.textContent = '✓ COPIED';
            setTimeout(() => { btn.textContent = '🔗 LINK'; }, 2000);
          }
        });
      });

      document.getElementById('disconnectBtn')?.addEventListener('click', () => {
        this.connection.disconnect();
        this.screenManager.showMainMenu();
      });
    }
  }

  private renderPlayersPanel(): void {
    const panel = document.getElementById('playersPanel');
    if (!panel || !this.lobbyState) return;

    const isHost = this.connection.isHostMode();
    const mySlotIndex = this.connection.getMySlotIndex();
    const mode = this.lobbyState.gameMode;

    let slotsHtml = '';

    if (mode === 'team') {
      // Team mode: group by teams
      slotsHtml = `
        <div style="margin-bottom: 1rem;">
          <h4 style="color: ${getSlotColor('team', 0)}; margin-bottom: 0.5rem;">TEAM PURPLE</h4>
          ${this.renderSlot(0, mode, mySlotIndex, isHost)}
          ${this.renderSlot(2, mode, mySlotIndex, isHost)}
        </div>
        <hr style="border-color: #333; margin: 1rem 0;" />
        <div>
          <h4 style="color: ${getSlotColor('team', 1)}; margin-bottom: 0.5rem;">TEAM BROWN</h4>
          ${this.renderSlot(1, mode, mySlotIndex, isHost)}
          ${this.renderSlot(3, mode, mySlotIndex, isHost)}
        </div>
      `;
    } else {
      // FFA mode: simple list
      slotsHtml = `
        ${this.renderSlot(0, mode, mySlotIndex, isHost)}
        ${this.renderSlot(1, mode, mySlotIndex, isHost)}
        ${this.renderSlot(2, mode, mySlotIndex, isHost)}
        ${this.renderSlot(3, mode, mySlotIndex, isHost)}
      `;
    }

    // Render unassigned peers (spectators)
    const hostPeerId = this.lobbyState.hostPeerId;
    const unassignedHtml = this.lobbyState.spectators.map(peer => {
      const isPeerHost = peer.peerId === hostPeerId;
      return `
        <div style="
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.75rem;
          margin-bottom: 0.5rem;
          background: #0a0a0a;
          border: 1px solid #333;
          border-radius: 4px;
        ">
          <div style="flex: 1;">
            <div style="color: #888;">${peer.nickname}${isPeerHost ? ' 🛠️' : ''}</div>
          </div>
        </div>
      `;
    }).join('');

    panel.innerHTML = `
      <h3 style="color: #0ff; margin-bottom: 1rem;">Players</h3>
      ${slotsHtml}
      ${this.lobbyState.spectators.length > 0 ? `
        <h3 style="color: #666; margin-top: 1.5rem; margin-bottom: 1rem;">Spectators</h3>
        ${unassignedHtml}
      ` : ''}
    `;

    // Add click handlers for slot joins and leaves
    for (let i = 0; i < 4; i++) {
      // Join button
      document.getElementById(`joinSlot${i}`)?.addEventListener('click', () => {
        const mySlotIndex = this.connection.getMySlotIndex();
        if (mySlotIndex === null) {
          // Not in any slot yet - join this slot
          this.connection.joinSlot(i as SlotIndex, this.myNickname);
        } else {
          // Already in a slot - change to this slot
          this.connection.changeSlot(i as SlotIndex);
        }
      });
      // Leave button
      document.getElementById(`leaveSlot${i}`)?.addEventListener('click', () => {
        this.connection.leaveSlot();
      });
    }
  }

  private renderSlot(index: SlotIndex, mode: GameMode, mySlotIndex: SlotIndex | null, _isHost: boolean): string {
    const slot = this.lobbyState!.slots[index];
    const color = getSlotColor(mode, index);
    const isOccupied = slot.peerId !== null;
    const isMe = slot.slotIndex === mySlotIndex;

    let statusText: string;
    let actionBtn = '';

    if (isOccupied) {
      statusText = slot.nickname || 'Player';
      if (isMe) statusText += ' (You)';
      if (slot.isHost) statusText += ' 🛠️';
      // Show leave button if this is my slot
      if (isMe) {
        actionBtn = `<button id="leaveSlot${index}" style="
          padding: 0.25rem 0.5rem;
          font-size: 0.8rem;
          font-family: monospace;
          cursor: pointer;
          background: #200;
          color: #f44;
          border: 1px solid #f44;
        ">LEAVE</button>`;
      }
    } else {
      statusText = 'Open';
      // Show join button for empty slots (if not this slot)
      if (mySlotIndex !== index) {
        actionBtn = `<button id="joinSlot${index}" style="
          padding: 0.25rem 0.5rem;
          font-size: 0.8rem;
          font-family: monospace;
          cursor: pointer;
          background: #002;
          color: #08f;
          border: 1px solid #08f;
        ">JOIN</button>`;
      }
    }

    return `
      <div style="
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem;
        margin-bottom: 0.5rem;
        background: ${isMe ? '#112' : '#0a0a0a'};
        border: 1px solid ${isMe ? '#08f' : '#333'};
        border-radius: 4px;
      ">
        <div style="
          width: 20px;
          height: 20px;
          background: ${color};
          border-radius: 50%;
          box-shadow: ${isOccupied ? `0 0 8px ${color}` : 'none'};
        "></div>
        <div style="flex: 1;">
          <div style="color: ${isOccupied ? '#fff' : '#666'};">${statusText}</div>
        </div>
        ${actionBtn}
      </div>
    `;
  }

  private renderChatPanel(): void {
    const panel = document.getElementById('chatPanel');
    if (!panel || !this.lobbyState) return;

    const mode = this.lobbyState.gameMode;
    const messages = this.lobbyState.chatMessages;

    let messagesHtml = messages.map(msg => {
      // Use white for non-players (null slot), otherwise use slot color
      const color = msg.senderSlotIndex !== null ? getSlotColor(mode, msg.senderSlotIndex) : '#fff';
      return `
        <div style="margin-bottom: 0.5rem;">
          <span style="color: ${color};">${msg.senderNickname}:</span>
          <span style="color: #fff;"> ${msg.text}</span>
        </div>
      `;
    }).join('');

    if (messages.length === 0) {
      messagesHtml = '<div style="color: #666; font-style: italic;">No messages yet...</div>';
    }

    panel.innerHTML = `
      <h3 style="color: #0ff; margin-bottom: 0.5rem;">Chat</h3>
      <div id="chatMessages" style="
        flex: 1;
        overflow-y: auto;
        background: #000;
        padding: 0.5rem;
        border: 1px solid #333;
        border-radius: 4px;
        margin-bottom: 0.5rem;
        min-height: 200px;
        max-height: 400px;
      ">${messagesHtml}</div>
      <div style="display: flex; gap: 0.5rem;">
        <input id="chatInput" type="text" placeholder="Type a message..." style="
          flex: 1;
          padding: 0.5rem;
          font-family: monospace;
          background: #000;
          color: #fff;
          border: 1px solid #333;
        " />
        <button id="chatSendBtn" style="
          padding: 0.5rem 1rem;
          font-family: monospace;
          cursor: pointer;
          background: #020;
          color: #0f0;
          border: 1px solid #0f0;
        ">SEND</button>
      </div>
    `;

    // Scroll to bottom
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Event listeners
    const chatInput = document.getElementById('chatInput') as HTMLInputElement;
    const sendChat = () => {
      const text = chatInput.value.trim();
      if (text) {
        this.connection.sendChat(text);
        chatInput.value = '';
      }
    };

    document.getElementById('chatSendBtn')?.addEventListener('click', sendChat);
    chatInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendChat();
    });
  }

  private createGameSession(): { gameConfig: GameConfig; gameConnection: GameConnection } {
    const lobbyState = this.lobbyState!;
    const myPeerId = this.connection.getMyPeerId();

    // Build players from filled slots
    const players: GamePlayer[] = lobbyState.slots
      .filter(slot => slot.peerId !== null)
      .map(slot => ({
        slotIndex: slot.slotIndex,
        nickname: slot.nickname,
        color: getSlotColor(lobbyState.gameMode, slot.slotIndex),
        isLocal: slot.peerId === myPeerId,
      }));

    // Build spectators from unassigned peers
    const spectators: Spectator[] = lobbyState.spectators.map(peer => ({
      nickname: peer.nickname,
    }));

    // Build peer-to-slot mapping for GameConnection
    const slotByPeerId = new Map<string, SlotIndex>();
    for (const slot of lobbyState.slots) {
      if (slot.peerId !== null) {
        slotByPeerId.set(slot.peerId, slot.slotIndex);
      }
    }

    const gameConfig: GameConfig = {
      players,
      spectators,
      isHost: this.connection.isHostMode(),
      gameMode: lobbyState.gameMode,
    };

    const gameConnection = new GameConnection(
      this.connection,
      slotByPeerId,
      this.connection.getMySlotIndex()
    );

    return { gameConfig, gameConnection };
  }

  private autoJoinFirstSlot(): void {
    if (!this.lobbyState) return;
    const openSlot = findFirstOpenSlot(this.lobbyState);
    if (openSlot !== null) {
      this.connection.joinSlot(openSlot, this.myNickname);
    }
  }

  // Render UI while waiting for lobby data (guest only)
  private renderConnectingUI(): void {
    const roomId = this.options.roomId || '';
    const link = `${window.location.origin}${window.location.pathname}?room=${roomId}`;

    // Settings panel - show room code and disconnect button
    const settingsPanel = document.getElementById('settingsPanel');
    if (settingsPanel) {
      settingsPanel.innerHTML = `
        <h3 style="color: #0ff; margin-bottom: 1rem;">Info</h3>

        <div style="margin-bottom: 1rem;">
          <label style="color: #888; display: block; margin-bottom: 0.5rem;">Game Mode:</label>
          <div style="display: flex; gap: 0.5rem;">
            <button disabled style="flex: 1; padding: 0.5rem; font-family: monospace; cursor: not-allowed; background: #111; color: #444; border: 1px solid #333;">FFA</button>
            <button disabled style="flex: 1; padding: 0.5rem; font-family: monospace; cursor: not-allowed; background: #111; color: #444; border: 1px solid #333;">TEAMS</button>
          </div>
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="color: #888; display: block; margin-bottom: 0.5rem;">Your Nickname:</label>
          <div style="display: flex; gap: 0.5rem;">
            <input id="nicknameInput" type="text" value="${this.myNickname}" disabled style="flex: 1; padding: 0.5rem; font-family: monospace; background: #000; color: #666; border: 1px solid #333; box-sizing: border-box;" />
            <button disabled style="padding: 0.5rem; font-family: monospace; cursor: not-allowed; background: #111; color: #444; border: 1px solid #333; font-size: 1rem;">🎲</button>
          </div>
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="color: #888; display: block; margin-bottom: 0.5rem;">Room Code:</label>
          <div style="background: #000; padding: 0.5rem; border: 1px solid #333; color: #0f0; font-family: monospace; text-align: center; letter-spacing: 0.1em;">${roomId}</div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
            <button id="copyCodeBtn" style="flex: 1; padding: 0.5rem; font-family: monospace; cursor: pointer; background: #002; color: #08f; border: 1px solid #08f;">📋 CODE</button>
            <button id="copyLinkBtn" style="flex: 1; padding: 0.5rem; font-family: monospace; cursor: pointer; background: #002; color: #08f; border: 1px solid #08f;">🔗 LINK</button>
          </div>
        </div>

        <div style="background: #110; padding: 1rem; border: 1px solid #440; border-radius: 4px; color: #ff0; text-align: center; margin-bottom: 1rem;">
          Connecting to room...
        </div>

        <button id="disconnectBtn" style="width: 100%; padding: 0.5rem; font-family: monospace; cursor: pointer; background: #200; color: #f44; border: 1px solid #f44;">DISCONNECT</button>
      `;

      document.getElementById('copyCodeBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(roomId).then(() => {
          const btn = document.getElementById('copyCodeBtn');
          if (btn) { btn.textContent = '✓ COPIED'; setTimeout(() => { btn.textContent = '📋 CODE'; }, 2000); }
        });
      });

      document.getElementById('copyLinkBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(link).then(() => {
          const btn = document.getElementById('copyLinkBtn');
          if (btn) { btn.textContent = '✓ COPIED'; setTimeout(() => { btn.textContent = '🔗 LINK'; }, 2000); }
        });
      });

      document.getElementById('disconnectBtn')?.addEventListener('click', () => {
        this.connection.disconnect();
        this.screenManager.showMainMenu();
      });
    }

    // Players panel - show empty slots
    const playersPanel = document.getElementById('playersPanel');
    if (playersPanel) {
      playersPanel.innerHTML = `
        <h3 style="color: #0ff; margin-bottom: 1rem;">Players</h3>
        <div style="color: #666; text-align: center; padding: 2rem;">
          Waiting for lobby data...
        </div>
      `;
    }

    // Chat panel - show empty
    const chatPanel = document.getElementById('chatPanel');
    if (chatPanel) {
      chatPanel.innerHTML = `
        <h3 style="color: #0ff; margin-bottom: 0.5rem;">Chat</h3>
        <div style="flex: 1; overflow-y: auto; background: #000; padding: 0.5rem; border: 1px solid #333; border-radius: 4px; margin-bottom: 0.5rem; min-height: 200px;">
          <div style="color: #666; font-style: italic;">Connecting...</div>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          <input disabled type="text" placeholder="Type a message..." style="flex: 1; padding: 0.5rem; font-family: monospace; background: #000; color: #666; border: 1px solid #333;" />
          <button disabled style="padding: 0.5rem 1rem; font-family: monospace; cursor: not-allowed; background: #111; color: #444; border: 1px solid #333;">SEND</button>
        </div>
      `;
    }
  }

  cleanup(): void {
    // Clear connection timeout if pending
    if (this.connectionTimeoutId !== null) {
      clearTimeout(this.connectionTimeoutId);
      this.connectionTimeoutId = null;
    }
    // Don't disconnect here - the connection is passed to the game screen
    // Disconnection happens via the Disconnect button or when leaving the game
  }
}
