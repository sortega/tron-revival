// Network lobby screen: seats, settings, chat, and the hand-over to the game.
// The room logic lives in RoomConnection; see design/networking.md.

import type { Screen, ScreenManager, LobbyOptions, GameRoomInfo } from './ScreenManager';
import { RoomConnection, generateRoomCode } from '../network/RoomConnection';
import type { PeerDiagnostics, RoomStatus } from '../network/RoomConnection';
import { DEBUG_LAG, LaggedTransport } from '../network/LaggedTransport';
import { MAX_WATCHERS } from '../network/roomLogic';
import type { LobbyState, SlotIndex, GameMode } from '../types/lobby';
import { getSlotColor, canStartGame, getFilledSlotCount } from '../types/lobby';
import type { BotDifficulty } from '../types/game';
import { bindLevelPicker, levelPickerHtml } from './levelPicker';
import type { GameSession } from '../game/session/GameSession';
import { createHostSession } from '../game/session/WorkerHostSession';
import { GuestSession } from '../game/session/GuestSession';
import { escapeHtml } from '../util/html';
import { qrSvg } from '../util/qr';
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
  private qrBig = false;        // The QR code was tapped to make it easier to scan
  private readonly onViewportResize = () => this.keepChatInputInView();

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
    // Layout: screens.css and design/screen-layout.md
    this.container.innerHTML = `
      <div class="ui-screen lobby-container">
        <div class="lobby-header">
          <h1 class="ui-title lobby-title">LOBBY</h1>
          <div id="connectionStatus" class="lobby-status"></div>
          <div id="lobbyNotice" class="lobby-notice"></div>
        </div>
        <div class="lobby-grid">
          <div id="settingsPanel" class="ui-panel lobby-panel lobby-side"></div>
          <div id="playersPanel" class="ui-panel lobby-panel lobby-players"></div>
          <div id="chatPanel" class="ui-panel lobby-panel lobby-panel-chat"></div>
        </div>
      </div>
    `;
    this.buildSettingsPanel();
    this.buildChatPanel();
    // The on-screen keyboard shrinks the visual viewport
    window.visualViewport?.addEventListener('resize', this.onViewportResize);

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

  // The side panel is built once: the nickname field, the room code and the QR code
  // never change, and rebuilding a text field while it is being used would close the
  // on-screen keyboard of a phone. Only the options and the start button are re-rendered.
  private buildSettingsPanel(): void {
    const panel = document.getElementById('settingsPanel');
    if (!panel) return;
    const roomId = this.room.code;
    const link = this.room.getLink();

    panel.innerHTML = `
      <div class="lobby-sec lobby-sec-settings">
        <div id="lobbyOptions"></div>
        <div class="ui-field">
          <label class="ui-label" for="nicknameInput">Your Nickname:</label>
          <div class="ui-row">
            <input id="nicknameInput" class="ui-input lobby-nickname" type="text" maxlength="24" value="${escapeHtml(this.myNickname)}"
              autocapitalize="words" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="done" />
            <button id="randomNicknameBtn" class="ui-btn ui-btn-blue lobby-dice" title="Generate random nickname">🎲</button>
          </div>
        </div>
      </div>

      <div id="roomSection" class="lobby-sec lobby-sec-room">
        <label class="ui-label">Room Code:</label>
        <div class="lobby-room">
          <div class="lobby-room-main">
            <div id="roomCode" class="lobby-code">${escapeHtml(roomId)}</div>
            <div class="ui-row">
              <button id="copyCodeBtn" class="ui-btn ui-btn-blue">📋 CODE</button>
              <button id="copyLinkBtn" class="ui-btn ui-btn-blue">🔗 LINK</button>
            </div>
          </div>
          <div class="lobby-qr-wrap">
            <button id="qrBtn" class="lobby-qr" title="Scan to join" aria-label="QR code of the room link: tap to change its size">${qrSvg(link)}</button>
            <div id="qrCaption" class="lobby-qr-caption"></div>
          </div>
        </div>
      </div>

      <div id="lobbyAction" class="lobby-sec lobby-sec-action"></div>

      <div class="lobby-sec lobby-sec-leave">
        <button id="disconnectBtn" class="ui-btn ui-btn-red ui-btn-wide">LEAVE ROOM</button>
      </div>
    `;

    const nicknameInput = document.getElementById('nicknameInput') as HTMLInputElement;
    nicknameInput.addEventListener('change', () => {
      const nickname = nicknameInput.value.trim();
      if (nickname) this.setNickname(nickname);
    });
    nicknameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nicknameInput.blur();   // "Done" on a phone keyboard
    });
    document.getElementById('randomNicknameBtn')?.addEventListener('click', () => {
      const nickname = generateNickname();
      this.setNickname(nickname);
      nicknameInput.value = nickname;
    });
    this.setupCopyButton('copyCodeBtn', roomId, '📋 CODE');
    this.setupCopyButton('copyLinkBtn', link, '🔗 LINK');
    document.getElementById('qrBtn')?.addEventListener('click', () => {
      this.qrBig = !this.qrBig;
      this.renderQrSize();
    });
    this.renderQrSize();
    document.getElementById('disconnectBtn')?.addEventListener('click', () => {
      this.room.leave();
      this.screenManager.showMainMenu();
    });
  }

  private renderQrSize(): void {
    document.getElementById('roomSection')?.classList.toggle('lobby-qr-big', this.qrBig);
    const caption = document.getElementById('qrCaption');
    if (caption) caption.innerHTML = `<span>Scan to join · </span>tap to ${this.qrBig ? 'shrink' : 'enlarge'}`;
  }

  private renderSettingsPanel(): void {
    const options = document.getElementById('lobbyOptions');
    const action = document.getElementById('lobbyAction');
    if (!options || !action) return;

    const state = this.lobbyState;
    const isHost = this.room.isHost();
    const editable = isHost && state !== null;
    const gameMode = state?.gameMode ?? 'ffa';
    const levelMode = state?.levelMode ?? 'cycle';
    const canStart = state !== null && canStartGame(state);

    options.innerHTML = `
      <h3 class="ui-heading lobby-heading">${isHost ? 'Settings' : 'Info'}</h3>

      <div class="ui-field">
        <label class="ui-label">Game Mode:</label>
        <div class="ui-row">
          <button id="ffaBtn" class="ui-toggle" aria-pressed="${gameMode === 'ffa'}" ${editable ? '' : 'disabled'}>FFA</button>
          <button id="teamBtn" class="ui-toggle" aria-pressed="${gameMode === 'team'}" ${editable ? '' : 'disabled'}>TEAMS</button>
        </div>
      </div>

      <div class="ui-field">
        <label class="ui-label">Level:</label>
        ${state ? levelPickerHtml(levelMode, editable) : '<div style="color: #666;">Loading...</div>'}
      </div>
    `;

    // On a phone the start button stays in view (screens.css: .ui-sticky)
    action.classList.toggle('ui-sticky', state !== null && isHost);
    if (!state) {
      action.innerHTML = `<div class="ui-banner">Connecting to room...</div>`;
    } else if (isHost) {
      action.innerHTML = `
        <button id="startGameBtn" class="ui-start" ${canStart ? '' : 'disabled'}>
          START GAME
          ${canStart ? '' : `<small>(${gameMode === 'team' ? 'needs 4 players' : 'needs 2 players'})</small>`}
        </button>`;
    } else {
      action.innerHTML = `<div class="ui-banner">Waiting for host to start...</div>`;
    }

    document.getElementById('ffaBtn')?.addEventListener('click', () => this.room.setGameMode('ffa'));
    document.getElementById('teamBtn')?.addEventListener('click', () => this.room.setGameMode('team'));
    bindLevelPicker(() => this.lobbyState?.levelMode ?? 'cycle', (mode) => this.room.setLevelMode(mode));
    document.getElementById('startGameBtn')?.addEventListener('click', () => this.room.startGame());
  }

  private setNickname(nickname: string): void {
    this.myNickname = nickname;
    localStorage.setItem(NICKNAME_KEY, nickname);
    this.room.setNickname(nickname);
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
        <h3 class="ui-heading">Players</h3>
        <div class="lobby-empty">Waiting for lobby data...</div>
      `;
      return;
    }

    const isHost = this.room.isHost();
    const mySlotIndex = this.room.getMySlotIndex();
    const mode = state.gameMode;
    const slot = (i: SlotIndex) => this.renderSlot(i, mode, mySlotIndex, isHost);

    const slotsHtml = mode === 'team'
      ? `<div>
           <h4 class="lobby-team-heading" style="color: ${getSlotColor('team', 0)};">TEAM PURPLE</h4>
           ${slot(0)}${slot(2)}
         </div>
         <hr class="lobby-team-rule" />
         <div>
           <h4 class="lobby-team-heading" style="color: ${getSlotColor('team', 1)};">TEAM BROWN</h4>
           ${slot(1)}${slot(3)}
         </div>`
      : `${slot(0)}${slot(1)}${slot(2)}${slot(3)}`;

    const selfId = this.room.getSelfId();
    const spectatorsHtml = state.spectators.map(peer => `
      <div class="ui-seat lobby-spectator">
        <div class="ui-seat-name">👁 ${escapeHtml(peer.nickname)}${peer.peerId === selfId ? ' (You)' : ''}${peer.peerId === state.hostPeerId ? ' 🛠️' : ''}${peer.queued ? ' <span title="Asked to play" class="lobby-wants">· wants to play</span>' : ''}</div>
        ${this.linkBadge(peer.peerId)}
      </div>
    `).join('');

    panel.innerHTML = `
      <h3 class="ui-heading">Players</h3>
      ${slotsHtml}
      ${state.spectators.length > 0 ? `
        <h3 id="spectatorsHeading" class="ui-heading lobby-heading-sub">Spectators (${state.spectators.length}/${MAX_WATCHERS})</h3>
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

  // Latency and path (direct / relayed) of our connection to a player. The element is
  // there (empty) before anything is known, so that new figures can be written into it
  // without rebuilding the buttons around it.
  private linkBadge(peerId: string | null): string {
    if (!peerId || peerId === this.room.getSelfId()) return '';
    const info = this.diagnostics.get(peerId);
    return `<span class="link-badge${info?.path === 'relay' ? ' link-badge-relay' : ''}" data-peer="${escapeHtml(peerId)}" title="Connection to this player">${this.linkText(info)}</span>`;
  }

  private linkText(info: PeerDiagnostics | undefined): string {
    if (!info) return '';
    const rtt = info.rttMs !== null ? `${info.rttMs}ms` : '';
    const path = info.path === 'relay' ? 'relay' : info.path === 'direct' ? 'direct' : '';
    return [rtt, path].filter(Boolean).join(' · ');
  }

  private async refreshDiagnostics(): Promise<void> {
    const list = await this.room.getDiagnostics();
    this.diagnostics = new Map(list.map(d => [d.userId, d]));
    // In place: a button that is rebuilt while a finger is on it loses the tap
    for (const badge of document.querySelectorAll<HTMLElement>('#playersPanel .link-badge')) {
      const info = this.diagnostics.get(badge.dataset.peer ?? '');
      const text = this.linkText(info);
      if (badge.textContent !== text) badge.textContent = text;
      badge.classList.toggle('link-badge-relay', info?.path === 'relay');
    }
  }

  private renderSlot(index: SlotIndex, mode: GameMode, mySlotIndex: SlotIndex | null, isHost: boolean): string {
    const slot = this.lobbyState!.slots[index];
    const color = getSlotColor(mode, index);
    const isOccupied = slot.peerId !== null;
    const isMe = slot.slotIndex === mySlotIndex;
    const smallBtn = (id: string, label: string, kind: string) =>
      `<button id="${id}" class="ui-btn ui-btn-sm ui-btn-${kind}">${label}</button>`;

    let statusText: string;
    let actions = '';

    if (slot.ai) {
      statusText = `${escapeHtml(slot.nickname)} 🤖`;
      if (isHost) {
        const options = (['easy', 'normal', 'hard'] as const)
          .map(d => `<option value="${d}" ${slot.ai === d ? 'selected' : ''}>${d}</option>`).join('');
        actions = `<select id="botLevel${index}" class="ui-select lobby-bot-level" aria-label="Bot level">${options}</select>
          ${smallBtn(`removeBot${index}`, '✕', 'red')}`;
      } else {
        statusText += ` <span class="lobby-seat-ai-level">(${slot.ai})</span>`;
      }
    } else if (isOccupied) {
      statusText = escapeHtml(slot.nickname || 'Player');
      if (isMe) statusText += ' (You)';
      if (slot.isHost) statusText += ' 🛠️';
      actions = isMe ? smallBtn(`leaveSlot${index}`, 'LEAVE', 'red') : this.linkBadge(slot.peerId);
    } else {
      statusText = 'Open';
      actions = smallBtn(`joinSlot${index}`, 'JOIN', 'blue');
      if (isHost) actions += smallBtn(`addBot${index}`, '+ AI', 'teal');
    }

    return `
      <div class="ui-seat${isMe ? ' ui-seat-mine' : ''}${isOccupied ? '' : ' lobby-seat-open'}">
        <div class="ui-seat-dot" style="background: ${color}; box-shadow: ${isOccupied ? `0 0 8px ${color}` : 'none'};"></div>
        <div class="ui-seat-name">${statusText}</div>
        ${actions}
      </div>
    `;
  }

  // The chat panel is built once, so that the text field (and with it the on-screen
  // keyboard of a phone) survives the arrival of messages; renderChatPanel fills it in.
  private buildChatPanel(): void {
    const panel = document.getElementById('chatPanel');
    if (!panel) return;

    panel.innerHTML = `
      <h3 class="ui-heading">Chat</h3>
      <div id="chatMessages" class="lobby-chat-messages"></div>
      <div class="ui-row">
        <input id="chatInput" class="lobby-chat-input" type="text" maxlength="300" placeholder="Type a message..."
          autocomplete="off" enterkeyhint="send" aria-label="Chat message" />
        <button id="chatSendBtn" class="ui-btn ui-btn-green lobby-chat-send">SEND</button>
      </div>
    `;

    const chatInput = document.getElementById('chatInput') as HTMLInputElement;
    const sendChat = () => {
      const text = chatInput.value.trim();
      if (text) {
        chatInput.value = '';
        this.room.sendChat(text);
      }
    };
    document.getElementById('chatSendBtn')?.addEventListener('click', () => {
      sendChat();
      chatInput.focus();   // Keeps the on-screen keyboard open for the next message
    });
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });
    chatInput.addEventListener('focus', () => window.setTimeout(() => this.keepChatInputInView(), 300));
  }

  private renderChatPanel(): void {
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput') as HTMLInputElement | null;
    const sendBtn = document.getElementById('chatSendBtn') as HTMLButtonElement | null;
    if (!chatMessages || !chatInput || !sendBtn) return;

    const state = this.lobbyState;
    const mode = state?.gameMode ?? 'ffa';
    const messages = state?.chatMessages ?? [];
    const enabled = state !== null;

    chatMessages.innerHTML = messages.length === 0
      ? `<div class="lobby-chat-empty">${enabled ? 'No messages yet...' : 'Connecting...'}</div>`
      : messages.map(msg => {
        // White for non-players (null slot), otherwise the slot colour
        const color = msg.senderSlotIndex !== null ? getSlotColor(mode, msg.senderSlotIndex) : '#fff';
        return `<div><span style="color: ${color};">${escapeHtml(msg.senderNickname)}:</span> ${escapeHtml(msg.text)}</div>`;
      }).join('');
    chatMessages.scrollTop = chatMessages.scrollHeight;
    chatInput.disabled = !enabled;
    sendBtn.disabled = !enabled;
  }

  // Phones: when the on-screen keyboard opens or changes size, keep the chat field in
  // the part of the page that is still visible.
  private keepChatInputInView(): void {
    const chatInput = document.getElementById('chatInput');
    if (!chatInput || document.activeElement !== chatInput) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const rect = chatInput.getBoundingClientRect();
    const overshoot = rect.bottom + 8 - viewport.height - viewport.offsetTop;
    if (overshoot > 0) window.scrollBy(0, overshoot);
    else if (rect.top < viewport.offsetTop) window.scrollBy(0, rect.top - viewport.offsetTop - 8);
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
      // Seats change hands at round starts (design/spectators.md): the room plans the
      // next round, the session applies it and the room follows
      const host = createHostSession(config, transport, { onRosterApplied: (players) => room.setActiveRoster([...players]) });
      room.setActiveRoster(config.players);
      room.setNextPlayersListener((players) => host.setNextPlayers(players));
      room.setSnapshotProvider(() => host.makeSnapshot());
      session = host;
    } else {
      const guest = new GuestSession(transport, room.getMySlotIndex(), config.players, {
        awaitSnapshot: resume, selfId: room.getSelfId() ?? undefined,
      });
      if (resume) {
        void room.requestSnapshot().then(data => (data ? guest.loadSnapshot(data) : guest.skipSnapshot()));
      }
      session = guest;
    }

    // What the game screen shows about the room: how to join, who watches, and the
    // buttons to ask for a seat or give it up
    const roomInfo: GameRoomInfo = {
      code: room.code,
      link: room.getLink(),
      audience: () => room.getAudience(),
      onChange: null,
      askToPlay: () => room.askToPlay(),
      cancelAsk: () => room.cancelAsk(),
      stepDown: () => room.stepDown(),
      stayIn: () => room.stayIn(),
    };

    // From here on the room reports to the game, not to this (discarded) screen
    room.setCallbacks({
      onLobbyUpdate: () => roomInfo.onChange?.(),
      onPhase: (phase) => {
        if (phase === 'lobby') {
          room.setSnapshotProvider(null);
          room.setNextPlayersListener(null);
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
      room: roomInfo,
    });
  }

  cleanup(): void {
    if (this.diagnosticsTimer !== null) {
      clearInterval(this.diagnosticsTimer);
      this.diagnosticsTimer = null;
    }
    window.visualViewport?.removeEventListener('resize', this.onViewportResize);
    // The room stays open when it has been handed to the game screen; leaving
    // the room happens through the LEAVE button or the game's menu button
    if (!this.handedOver && this.room.getStatus() !== 'closed') {
      this.room.setCallbacks({});
    }
  }
}
