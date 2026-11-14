// Network lobby screen: seats, settings, chat, and the hand-over to the game.
// The room logic lives in RoomConnection; see design/networking.md.

import qrcode from 'qrcode-generator';
import type { Screen, ScreenManager, LobbyOptions } from './ScreenManager';
import { RoomConnection, generateRoomCode } from '../network/RoomConnection';
import type { PeerDiagnostics, RoomStatus } from '../network/RoomConnection';
import { DEBUG_LAG, LaggedTransport } from '../network/LaggedTransport';
import type { LobbyState, SlotIndex, GameMode } from '../types/lobby';
import { getSlotColor, canStartGame, getFilledSlotCount } from '../types/lobby';
import type { BotDifficulty } from '../types/game';
import { LEVELS } from '../types/game';
import type { GameSession } from '../game/session/GameSession';
import { createHostSession } from '../game/session/WorkerHostSession';
import { GuestSession } from '../game/session/GuestSession';
import { escapeHtml } from '../util/html';
import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';

const NICKNAME_KEY = 'teratron-nickname';
const DIAGNOSTICS_INTERVAL_MS = 2000;

function generateNickname(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '',
    style: 'capital',
    length: 2,
  });
}

// Shared inline styles
const BTN = 'padding: 0.5rem; font-family: monospace; cursor: pointer;';
const FIELD = 'padding: 0.5rem; font-family: monospace; background: #000; border: 1px solid #0ff; color: #0ff; box-sizing: border-box;';
const LABEL = 'color: #888; display: block; margin-bottom: 0.5rem;';

function toggleStyle(active: boolean, enabled: boolean): string {
  const on = enabled ? ['#030', '#0f0'] : ['#020', '#0a0'];
  const off = enabled ? ['#111', '#666'] : ['#111', '#444'];
  const [bg, fg] = active ? on : off;
  return `flex: 1; ${BTN} cursor: ${enabled ? 'pointer' : 'not-allowed'}; background: ${bg}; color: ${fg}; border: 1px solid ${active ? fg : '#333'};`;
}

export class NetworkLobby implements Screen {
  private container: HTMLElement;
  private screenManager: ScreenManager;
  private room: RoomConnection;
  private readonly ownsNewRoom: boolean;
  private lobbyState: LobbyState | null = null;
  private myNickname: string;
  private notice: string | null = null;
  private diagnostics = new Map<string, PeerDiagnostics>();
  private diagnosticsTimer: number | null = null;
  private handedOver = false;   // The room now belongs to the game screen

  constructor(container: HTMLElement, screenManager: ScreenManager, options: LobbyOptions) {
    this.container = container;
    this.screenManager = screenManager;
    this.myNickname = localStorage.getItem(NICKNAME_KEY) || generateNickname();

    if ('room' in options) {
      // Coming back from a game: keep using the same room
      this.room = options.room;
      this.ownsNewRoom = false;
    } else {
      const create = options.mode === 'host';
      const code = options.mode === 'host' ? generateRoomCode() : options.roomId;
      this.room = new RoomConnection(code, { create, nickname: this.myNickname });
      this.ownsNewRoom = true;
    }
  }

  render(): void {
    this.container.innerHTML = `
      <style>
        .lobby-container { display: flex; flex-direction: column; min-height: 100vh; padding: 1rem; }
        .lobby-title { color: #0ff; text-shadow: 0 0 10px #0ff; margin-bottom: 1rem; text-align: center; font-size: 2rem; }
        .lobby-status { text-align: center; color: #ff0; margin-bottom: 0.5rem; }
        .lobby-notice { text-align: center; color: #fa0; margin-bottom: 0.5rem; font-size: 0.85rem; min-height: 1.2em; }
        .lobby-grid {
          flex: 1; display: grid; grid-template-columns: 250px 350px 300px; gap: 1rem;
          max-width: 1200px; margin: 0 auto; width: 100%;
        }
        .lobby-panel { background: #111; padding: 1rem; border-radius: 4px; border: 1px solid #333; }
        .lobby-panel-chat { display: flex; flex-direction: column; }
        .lobby-qr svg { display: block; width: 100%; height: auto; }
        /* Tablet: 2 columns, chat below */
        @media (max-width: 950px) {
          .lobby-grid { grid-template-columns: 1fr 1fr; grid-template-rows: auto auto; }
          .lobby-panel-chat { grid-column: 1 / -1; }
        }
        /* Mobile: single column */
        @media (max-width: 600px) {
          .lobby-container { padding: 0.5rem; }
          .lobby-title { font-size: 1.5rem; margin-bottom: 0.5rem; }
          .lobby-grid { grid-template-columns: 1fr; gap: 0.75rem; }
          .lobby-panel { padding: 0.75rem; }
          .lobby-panel-chat { grid-column: auto; max-height: 300px; }
          .lobby-panel button { min-height: 44px; font-size: 0.9rem; }
          .lobby-panel input { min-height: 44px; font-size: 16px; /* Prevents iOS zoom */ }
          .lobby-panel h3 { font-size: 1rem; }
          .lobby-panel label { font-size: 0.8rem; }
        }
      </style>
      <div class="lobby-container">
        <h1 class="lobby-title">LOBBY</h1>
        <div id="connectionStatus" class="lobby-status"></div>
        <div id="lobbyNotice" class="lobby-notice"></div>
        <div class="lobby-grid">
          <div id="settingsPanel" class="lobby-panel"></div>
          <div id="playersPanel" class="lobby-panel"></div>
          <div id="chatPanel" class="lobby-panel lobby-panel-chat"></div>
        </div>
      </div>
    `;

    this.room.setCallbacks({
      onStatus: () => this.renderStatus(),
      onLobbyUpdate: (state) => {
        this.lobbyState = state;
        this.updateUI();
      },
      onPhase: (phase, { resume }) => {
        if (phase === 'game') this.enterGame(resume);
      },
      onHostPresence: () => this.renderStatus(),
      onNotice: (text) => {
        this.notice = text;
        this.renderStatus();
      },
      onClosed: (reason) => this.screenManager.showMainMenu(reason),
    });

    this.lobbyState = this.room.getLobbyState();
    this.updateUI();
    this.diagnosticsTimer = window.setInterval(() => void this.refreshDiagnostics(), DIAGNOSTICS_INTERVAL_MS);

    if (this.ownsNewRoom) {
      void this.room.connect();
    } else if (this.room.getPhase() === 'game') {
      // The game restarted while we were on our way back here
      this.enterGame(true);
    }
  }

  // === Rendering ===

  private updateUI(): void {
    this.renderStatus();
    this.renderSettingsPanel();
    this.renderPlayersPanel();
    this.renderChatPanel();
  }

  private renderStatus(): void {
    const statusEl = document.getElementById('connectionStatus');
    const noticeEl = document.getElementById('lobbyNotice');
    if (!statusEl || !noticeEl) return;

    const status: RoomStatus = this.room.getStatus();
    let text: string;
    let color = '#ff0';
    if (status === 'connecting') {
      text = 'Connecting...';
    } else if (status === 'searching') {
      text = 'Looking for the room... (can take a few seconds)';
    } else if (status === 'closed') {
      text = 'Disconnected';
      color = '#f44';
    } else if (!this.room.isHost() && !this.room.isHostPresent()) {
      text = 'Host disconnected — waiting for it to come back...';
      color = '#fa0';
    } else if (this.room.isHost() && this.lobbyState && getFilledSlotCount(this.lobbyState) < 2) {
      text = 'Room created — share the code or add an AI player';
      color = '#0f0';
    } else {
      text = 'Connected';
      color = '#0f0';
    }
    statusEl.textContent = text;
    statusEl.style.color = color;

    const hints: string[] = [];
    if (this.notice) hints.push(this.notice);
    if (status === 'ready' && !this.room.hasTurn()) {
      hints.push('No TURN relay configured: players on mobile data or strict networks may be unable to connect.');
    }
    noticeEl.textContent = hints.join(' ');
  }

  private renderSettingsPanel(): void {
    const panel = document.getElementById('settingsPanel');
    if (!panel) return;

    const state = this.lobbyState;
    const isHost = this.room.isHost();
    const editable = isHost && state !== null;
    const roomId = this.room.code;
    const link = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
    const gameMode = state?.gameMode ?? 'ffa';
    const levelMode = state?.levelMode ?? 'cycle';
    const canStart = state !== null && canStartGame(state);

    const levelOptions = editable
      ? `<option value="cycle" ${levelMode === 'cycle' ? 'selected' : ''}>Cycle All</option>
         ${LEVELS.map(l => `<option value="${l.id}" ${levelMode === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}`
      : `<option>${state ? escapeHtml(levelMode === 'cycle' ? 'Cycle All' : LEVELS.find(l => l.id === levelMode)?.name ?? levelMode) : 'Loading...'}</option>`;

    let action: string;
    if (!state) {
      action = `<div style="background: #110; padding: 1rem; border: 1px solid #440; border-radius: 4px; color: #ff0; text-align: center; margin-bottom: 0.5rem;">Connecting to room...</div>`;
    } else if (isHost) {
      action = `
        <button id="startGameBtn" ${canStart ? '' : 'disabled'} style="
          width: 100%; padding: 1rem; font-size: 1.1rem; font-family: monospace; margin-bottom: 0.5rem;
          cursor: ${canStart ? 'pointer' : 'not-allowed'};
          background: ${canStart ? '#030' : '#111'}; color: ${canStart ? '#0f0' : '#666'};
          border: 2px solid ${canStart ? '#0f0' : '#333'};">
          START GAME
          ${canStart ? '' : `<br><span style="font-size: 0.7rem;">(${gameMode === 'team' ? 'needs 4 players' : 'needs 2 players'})</span>`}
        </button>`;
    } else {
      action = `<div style="background: #110; padding: 1rem; border: 1px solid #440; border-radius: 4px; color: #ff0; text-align: center; margin-bottom: 0.5rem;">Waiting for host to start...</div>`;
    }

    const nicknameFocused = document.activeElement?.id === 'nicknameInput';
    const nicknameDraft = (document.getElementById('nicknameInput') as HTMLInputElement | null)?.value;

    panel.innerHTML = `
      <h3 style="color: #0ff; margin-bottom: 1rem;">${isHost ? 'Settings' : 'Info'}</h3>

      <div style="margin-bottom: 1rem;">
        <label style="${LABEL}">Game Mode:</label>
        <div style="display: flex; gap: 0.5rem;">
          <button id="ffaBtn" ${editable ? '' : 'disabled'} style="${toggleStyle(gameMode === 'ffa', editable)}">FFA</button>
          <button id="teamBtn" ${editable ? '' : 'disabled'} style="${toggleStyle(gameMode === 'team', editable)}">TEAMS</button>
        </div>
      </div>

      <div style="margin-bottom: 1rem;">
        <label style="${LABEL}">Level:</label>
        <select id="levelSelect" ${editable ? '' : 'disabled'} style="width: 100%; ${FIELD}
          ${editable ? 'cursor: pointer;' : 'color: #666; border-color: #333; cursor: not-allowed;'}">${levelOptions}</select>
      </div>

      <div style="margin-bottom: 1rem;">
        <label style="${LABEL}">Your Nickname:</label>
        <div style="display: flex; gap: 0.5rem;">
          <input id="nicknameInput" type="text" maxlength="24" value="${escapeHtml(nicknameFocused && nicknameDraft !== undefined ? nicknameDraft : this.myNickname)}" style="flex: 1; min-width: 0; ${FIELD}" />
          <button id="randomNicknameBtn" title="Generate random nickname" style="${BTN} background: #002; color: #08f; border: 1px solid #08f; font-size: 1rem;">🎲</button>
        </div>
      </div>

      <div style="margin-bottom: 1rem;">
        <label style="${LABEL}">Room Code:</label>
        <div id="roomCode" style="background: #000; padding: 0.5rem; border: 1px solid #333; color: #0f0; font-family: monospace;
          word-break: break-all; text-align: center; letter-spacing: 0.1em;">${escapeHtml(roomId)}</div>
        <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
          <button id="copyCodeBtn" style="flex: 1; ${BTN} background: #002; color: #08f; border: 1px solid #08f;">📋 CODE</button>
          <button id="copyLinkBtn" style="flex: 1; ${BTN} background: #002; color: #08f; border: 1px solid #08f;">🔗 LINK</button>
        </div>
        <div class="lobby-qr" title="Scan to join" style="background: #fff; padding: 6px; margin: 0.5rem auto 0; width: 150px; border-radius: 4px;">${this.qrSvg(link)}</div>
        <div style="color: #666; font-size: 0.7rem; text-align: center; margin-top: 0.25rem;">Scan to join from a phone</div>
      </div>

      ${action}

      <button id="disconnectBtn" style="width: 100%; ${BTN} background: #200; color: #f44; border: 1px solid #f44;">LEAVE ROOM</button>
    `;

    if (nicknameFocused) (document.getElementById('nicknameInput') as HTMLInputElement | null)?.focus();

    document.getElementById('ffaBtn')?.addEventListener('click', () => this.room.setGameMode('ffa'));
    document.getElementById('teamBtn')?.addEventListener('click', () => this.room.setGameMode('team'));
    document.getElementById('levelSelect')?.addEventListener('change', (e) => {
      this.room.setLevelMode((e.target as HTMLSelectElement).value);
    });
    document.getElementById('nicknameInput')?.addEventListener('change', (e) => {
      const nickname = (e.target as HTMLInputElement).value.trim();
      if (nickname) this.setNickname(nickname);
    });
    document.getElementById('randomNicknameBtn')?.addEventListener('click', () => {
      const nickname = generateNickname();
      this.setNickname(nickname);
      const input = document.getElementById('nicknameInput') as HTMLInputElement | null;
      if (input) input.value = nickname;
    });
    this.setupCopyButton('copyCodeBtn', roomId, '📋 CODE');
    this.setupCopyButton('copyLinkBtn', link, '🔗 LINK');
    document.getElementById('startGameBtn')?.addEventListener('click', () => this.room.startGame());
    document.getElementById('disconnectBtn')?.addEventListener('click', () => {
      this.room.leave();
      this.screenManager.showMainMenu();
    });
  }

  private setNickname(nickname: string): void {
    this.myNickname = nickname;
    localStorage.setItem(NICKNAME_KEY, nickname);
    this.room.setNickname(nickname);
  }

  private qrSvg(text: string): string {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch {
      return '';
    }
  }

  private setupCopyButton(id: string, text: string, label: string): void {
    document.getElementById(id)?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(text).then(() => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.textContent = '✓ COPIED';
        setTimeout(() => {
          const current = document.getElementById(id);
          if (current) current.textContent = label;
        }, 2000);
      });
    });
  }

  private renderPlayersPanel(): void {
    const panel = document.getElementById('playersPanel');
    if (!panel) return;

    const state = this.lobbyState;
    if (!state) {
      panel.innerHTML = `
        <h3 style="color: #0ff; margin-bottom: 1rem;">Players</h3>
        <div style="color: #666; text-align: center; padding: 2rem;">Waiting for lobby data...</div>
      `;
      return;
    }

    const isHost = this.room.isHost();
    const mySlotIndex = this.room.getMySlotIndex();
    const mode = state.gameMode;
    const slot = (i: SlotIndex) => this.renderSlot(i, mode, mySlotIndex, isHost);

    const slotsHtml = mode === 'team'
      ? `<div style="margin-bottom: 1rem;">
           <h4 style="color: ${getSlotColor('team', 0)}; margin-bottom: 0.5rem;">TEAM PURPLE</h4>
           ${slot(0)}${slot(2)}
         </div>
         <hr style="border-color: #333; margin: 1rem 0;" />
         <div>
           <h4 style="color: ${getSlotColor('team', 1)}; margin-bottom: 0.5rem;">TEAM BROWN</h4>
           ${slot(1)}${slot(3)}
         </div>`
      : `${slot(0)}${slot(1)}${slot(2)}${slot(3)}`;

    const selfId = this.room.getSelfId();
    const spectatorsHtml = state.spectators.map(peer => `
      <div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; margin-bottom: 0.5rem;
        background: #0a0a0a; border: 1px solid #333; border-radius: 4px;">
        <div style="flex: 1; color: #888;">${escapeHtml(peer.nickname)}${peer.peerId === selfId ? ' (You)' : ''}${peer.peerId === state.hostPeerId ? ' 🛠️' : ''}</div>
        ${this.linkBadge(peer.peerId)}
      </div>
    `).join('');

    panel.innerHTML = `
      <h3 style="color: #0ff; margin-bottom: 1rem;">Players</h3>
      ${slotsHtml}
      ${state.spectators.length > 0 ? `
        <h3 style="color: #666; margin-top: 1.5rem; margin-bottom: 1rem;">Spectators</h3>
        ${spectatorsHtml}
      ` : ''}
    `;

    for (const i of [0, 1, 2, 3] as SlotIndex[]) {
      document.getElementById(`joinSlot${i}`)?.addEventListener('click', () => this.room.joinSlot(i));
      document.getElementById(`leaveSlot${i}`)?.addEventListener('click', () => this.room.leaveSlot());
      // Bots (host only)
      document.getElementById(`addBot${i}`)?.addEventListener('click', () => this.room.addBot(i, 'normal'));
      document.getElementById(`removeBot${i}`)?.addEventListener('click', () => this.room.removeBot(i));
      document.getElementById(`botLevel${i}`)?.addEventListener('change', (e) => {
        this.room.setBotDifficulty(i, (e.target as HTMLSelectElement).value as BotDifficulty);
      });
    }
  }

  // Latency and path (direct / relayed) of our connection to a player
  private linkBadge(peerId: string | null): string {
    const info = peerId ? this.diagnostics.get(peerId) : undefined;
    if (!info) return '';
    const rtt = info.rttMs !== null ? `${info.rttMs}ms` : '';
    const path = info.path === 'relay' ? 'relay' : info.path === 'direct' ? 'direct' : '';
    const color = info.path === 'relay' ? '#fa0' : '#5a5';
    return `<span class="link-badge" title="Connection to this player" style="color: ${color}; font-size: 0.7rem; white-space: nowrap;">${[rtt, path].filter(Boolean).join(' · ')}</span>`;
  }

  private async refreshDiagnostics(): Promise<void> {
    const list = await this.room.getDiagnostics();
    const next = new Map(list.map(d => [d.userId, d]));
    const changed = next.size !== this.diagnostics.size ||
      [...next].some(([id, d]) => {
        const old = this.diagnostics.get(id);
        return !old || old.path !== d.path || old.rttMs !== d.rttMs;
      });
    this.diagnostics = next;
    // Avoid re-rendering while the user is using a control in the panel
    if (changed && !document.getElementById('playersPanel')?.contains(document.activeElement)) {
      this.renderPlayersPanel();
    }
  }

  private renderSlot(index: SlotIndex, mode: GameMode, mySlotIndex: SlotIndex | null, isHost: boolean): string {
    const slot = this.lobbyState!.slots[index];
    const color = getSlotColor(mode, index);
    const isOccupied = slot.peerId !== null;
    const isMe = slot.slotIndex === mySlotIndex;
    const smallBtn = (id: string, label: string, fg: string, bg: string) => `<button id="${id}" style="
      padding: 0.25rem 0.5rem; font-size: 0.8rem; font-family: monospace; cursor: pointer;
      background: ${bg}; color: ${fg}; border: 1px solid ${fg};">${label}</button>`;

    let statusText: string;
    let actions = '';

    if (slot.ai) {
      statusText = `${escapeHtml(slot.nickname)} 🤖`;
      if (isHost) {
        const options = (['easy', 'normal', 'hard'] as const)
          .map(d => `<option value="${d}" ${slot.ai === d ? 'selected' : ''}>${d}</option>`).join('');
        actions = `<select id="botLevel${index}" style="padding: 0.2rem; font-family: monospace; font-size: 0.8rem;
          background: #000; color: #0ff; border: 1px solid #0ff;">${options}</select>
          ${smallBtn(`removeBot${index}`, '✕', '#f44', '#200')}`;
      } else {
        statusText += ` <span style="color: #666;">(${slot.ai})</span>`;
      }
    } else if (isOccupied) {
      statusText = escapeHtml(slot.nickname || 'Player');
      if (isMe) statusText += ' (You)';
      if (slot.isHost) statusText += ' 🛠️';
      actions = isMe ? smallBtn(`leaveSlot${index}`, 'LEAVE', '#f44', '#200') : this.linkBadge(slot.peerId);
    } else {
      statusText = 'Open';
      actions = smallBtn(`joinSlot${index}`, 'JOIN', '#08f', '#002');
      if (isHost) actions += smallBtn(`addBot${index}`, '+ AI', '#0c8', '#021');
    }

    return `
      <div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; margin-bottom: 0.5rem;
        background: ${isMe ? '#112' : '#0a0a0a'}; border: 1px solid ${isMe ? '#08f' : '#333'}; border-radius: 4px;">
        <div style="width: 20px; height: 20px; flex: none; background: ${color}; border-radius: 50%;
          box-shadow: ${isOccupied ? `0 0 8px ${color}` : 'none'};"></div>
        <div style="flex: 1; min-width: 0; color: ${isOccupied ? '#fff' : '#666'}; overflow: hidden; text-overflow: ellipsis;">${statusText}</div>
        ${actions}
      </div>
    `;
  }

  private renderChatPanel(): void {
    const panel = document.getElementById('chatPanel');
    if (!panel) return;

    const state = this.lobbyState;
    const mode = state?.gameMode ?? 'ffa';
    const messages = state?.chatMessages ?? [];
    const enabled = state !== null;

    // Keep what is being typed across re-renders
    const previous = document.getElementById('chatInput') as HTMLInputElement | null;
    const draft = previous?.value ?? '';
    const hadFocus = document.activeElement === previous && previous !== null;

    const messagesHtml = messages.length === 0
      ? `<div style="color: #666; font-style: italic;">${enabled ? 'No messages yet...' : 'Connecting...'}</div>`
      : messages.map(msg => {
        // White for non-players (null slot), otherwise the slot colour
        const color = msg.senderSlotIndex !== null ? getSlotColor(mode, msg.senderSlotIndex) : '#fff';
        return `<div style="margin-bottom: 0.5rem;">
          <span style="color: ${color};">${escapeHtml(msg.senderNickname)}:</span>
          <span style="color: #fff;"> ${escapeHtml(msg.text)}</span>
        </div>`;
      }).join('');

    panel.innerHTML = `
      <h3 style="color: #0ff; margin-bottom: 0.5rem;">Chat</h3>
      <div id="chatMessages" style="flex: 1; overflow-y: auto; background: #000; padding: 0.5rem; border: 1px solid #333;
        border-radius: 4px; margin-bottom: 0.5rem; min-height: 150px; max-height: 300px;">${messagesHtml}</div>
      <div style="display: flex; gap: 0.5rem;">
        <input id="chatInput" type="text" maxlength="300" placeholder="Type a message..." ${enabled ? '' : 'disabled'}
          style="flex: 1; min-width: 0; padding: 0.5rem; font-family: monospace; background: #000; color: #fff; border: 1px solid #333;" />
        <button id="chatSendBtn" ${enabled ? '' : 'disabled'} style="padding: 0.5rem 1rem; font-family: monospace; cursor: pointer;
          background: #020; color: #0f0; border: 1px solid #0f0;">SEND</button>
      </div>
    `;

    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;

    const chatInput = document.getElementById('chatInput') as HTMLInputElement;
    chatInput.value = draft;
    if (hadFocus) chatInput.focus();

    const sendChat = () => {
      const text = chatInput.value.trim();
      if (text) {
        chatInput.value = '';
        this.room.sendChat(text);
      }
    };
    document.getElementById('chatSendBtn')?.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });
  }

  // === Game hand-over ===

  // Open the game screen. `resume`: the game was already running when we arrived
  // (reload, late join), so we need a snapshot of it.
  private enterGame(resume: boolean): void {
    const config = this.room.getGameConfig();
    if (!config || this.handedOver) return;
    this.handedOver = true;

    const room = this.room;
    const screenManager = this.screenManager;
    const base = room.createTransport();
    // `?lag=<ms>` adds artificial latency, to test the netcode on one machine
    const transport = DEBUG_LAG ? new LaggedTransport(base, DEBUG_LAG) : base;

    let session: GameSession;
    if (room.isHost()) {
      const host = createHostSession(config, transport);
      room.setSnapshotProvider(() => host.makeSnapshot());
      session = host;
    } else {
      const guest = new GuestSession(transport, room.getMySlotIndex(), config.players, { awaitSnapshot: resume });
      if (resume) {
        void room.requestSnapshot().then(data => (data ? guest.loadSnapshot(data) : guest.skipSnapshot()));
      }
      session = guest;
    }

    // From here on the room reports to the game, not to this (discarded) screen
    room.setCallbacks({
      onPhase: (phase) => {
        if (phase === 'lobby') {
          room.setSnapshotProvider(null);
          screenManager.showNetworkLobby({ room });
        }
      },
      onHostPresence: (present) => {
        if (!present) console.info('[room] host disconnected; waiting for it to return');
      },
      onClosed: (reason) => screenManager.showMainMenu(reason),
    });

    screenManager.showGame(config, session, {
      onBackToLobby: room.isHost() ? () => room.setPhase('lobby') : undefined,
      onLeave: () => room.leave(),
    });
  }

  cleanup(): void {
    if (this.diagnosticsTimer !== null) {
      clearInterval(this.diagnosticsTimer);
      this.diagnosticsTimer = null;
    }
    // The room stays open when it has been handed to the game screen; leaving
    // the room happens through the LEAVE button or the game's menu button
    if (!this.handedOver && this.room.getStatus() !== 'closed') {
      this.room.setCallbacks({});
    }
  }
}
