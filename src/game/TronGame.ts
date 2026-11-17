// TronGame - Game screen: layout, input, rendering, sound.
// All game logic lives behind the GameSession it is given.

import type { GameScreenOptions, Screen, ScreenManager } from '../screens/ScreenManager';
import type { GameConfig, TronGameStateData, TronInput, SoundEvent, RoundPhase } from '../types/game';
import type { SlotIndex } from '../types/lobby';
import { LEVELS } from '../types/game';
import { SPEED_UP_FACTOR, TICK_RATE } from './constants';
import { CANVAS_ASPECT, TronRenderer } from './TronRenderer';
import { InputManager, isTouchDevice, isIOS } from './input/InputManager';
import { CONTROL_SCHEMES } from './input/controlSchemes';
import type { InputBinding } from './input/InputManager';
import { getSoundManager, type SoundName } from './SoundManager';
import { Ticker } from './Ticker';
import type { GameSession } from './session/GameSession';
import { HOST_SILENCE_MS } from './session/GameSession';
import { escapeHtml } from '../util/html';
import { perfCounter, perfDump, perfEnable, perfEnd, perfSince, perfStart } from './perf';
import type { PerfSummary } from './perf';
import { TerritoryOverlay } from './ai/TerritoryOverlay';
import type { TronGameState } from './TronGameState';
import { qrSvg } from '../util/qr';

export class TronGame implements Screen {
  private container: HTMLElement;
  private screenManager: ScreenManager;
  private config: GameConfig;
  private session: GameSession;
  private options: GameScreenOptions;

  private renderer: TronRenderer | null = null;
  private input: InputManager | null = null;
  private ticker: Ticker | null = null;

  // Steps-per-second tracking for the debug display
  private stepTimes: number[] = [];
  private currentFps: number = TICK_RATE;
  private lastFpsUpdate: number = 0;
  private showFps: boolean = localStorage.getItem('showFps') === 'true';
  private fpsKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  // `?perf=1`: on-screen readout of the phase timers, for devices without a console
  private perfHud: HTMLElement | null = null;
  private perfHudTimer: ReturnType<typeof setInterval> | null = null;

  // Speeding up when only bots are left (design/local-and-ai.md): while action is held,
  // from a press that began during the offer
  private actionWasPressed = false;
  private speedingUp = false;
  private watcherHolds = false;   // Space or the arena, for a user without a player here
  private readonly watcherRelease = (e: Event): void => {
    if (e.type !== 'keyup' || (e as KeyboardEvent).code === 'Space') this.watcherHolds = false;
  };

  // Double-tap detection for mobile FPS toggle
  private lastTapTime: number = 0;
  // Phone layout: the player the on-screen controls drive, and the handler that measures
  // the margins beside the canvas
  private touchSlot: SlotIndex | null = null;
  private mobileLayoutHandler: (() => void) | null = null;

  // `?botdebug=...`: the bots' territory map over the arena
  private botDebug: TerritoryOverlay | null = TerritoryOverlay.fromUrl(location.search);

  // Track loaded level to detect changes
  private loadedLevelIndex: number = -1;
  private levelLoading: boolean = false;

  // Something that is drawn changed since the last display frame. The simulation ticks
  // 70 times a second; on a 90 or 120 Hz screen the frames in between would redraw the
  // very same picture.
  private dirty = true;

  // Track previous round phase to detect transitions and stop sound loops
  private previousPhase: RoundPhase | null = null;

  // Network games: last rendered state of the join badge / spectator bar (design/spectators.md)
  private roomUiKey = '';
  private roomUiPhase: RoundPhase | null = null;
  private showJoinQr = false;   // The QR code is shown only while asked for (a click on the room code)
  private readonly resizeRoomUi = (): void => this.updateRoomUi(true);
  // One listener for the buttons of the join badge and the seat bar, which are
  // re-rendered as the audience changes
  private readonly handleRoomClick = (e: MouseEvent): void => {
    const room = this.options.room;
    const id = (e.target as HTMLElement | null)?.closest('[data-room-action]')?.getAttribute('data-room-action');
    if (!room || !id) return;
    if (id === 'ask') room.askToPlay();
    else if (id === 'cancel') room.cancelAsk();
    else if (id === 'watch') room.stepDown();
    else if (id === 'stay') room.stayIn();
    else if (id === 'qr') {
      this.showJoinQr = !this.showJoinQr;
    }
    this.updateRoomUi(true);
  };

  constructor(
    container: HTMLElement,
    screenManager: ScreenManager,
    config: GameConfig,
    session: GameSession,
    options: GameScreenOptions = {}
  ) {
    this.options = options;
    this.container = container;
    this.screenManager = screenManager;
    this.config = config;
    this.session = session;
  }

  private localBindings(): InputBinding[] {
    const bindings: InputBinding[] = [];
    for (const player of this.config.players) {
      if (player.control.type === 'local') {
        bindings.push({ slot: player.slotIndex, scheme: player.control.scheme });
      }
    }
    return bindings;
  }

  // Direction of a player that can be steered right now (for heading-based touch modes)
  private steerableHeading(slot: SlotIndex): number | null {
    const view = this.session.getViewState();
    if (!view || view.round.phase !== 'playing') return null;
    const player = view.round.players.find(p => p.slotIndex === slot);
    return player?.alive ? player.direction : null;
  }

  // One line per local human describing their keys
  private controlsHint(): string {
    const humans = this.config.players.filter(p => p.control.type === 'local');
    if (humans.length === 0) return '<div>Spectating</div>';
    return humans.map(p => {
      const scheme = p.control.type === 'local' ? CONTROL_SCHEMES[p.control.scheme] : null;
      const name = humans.length > 1 ? `<span style="color: ${p.color};">${escapeHtml(p.nickname)}</span>: ` : '';
      return `<div>${name}${scheme?.label ?? ''}</div>`;
    }).join('');
  }

  render(): void {
    const isTouch = isTouchDevice();

    if (isTouch) {
      this.renderMobileLayout();
    } else {
      this.renderDesktopLayout();
    }

    this.setupInput();

    // Seats can change hands when a round starts (design/spectators.md)
    this.session.onRoster = (players) => {
      this.config = { ...this.config, players };
      this.renderer?.setPlayers(players);
      this.setupInput();
      this.updateRoomUi(true);
    };
    const room = this.options.room;
    if (room) {
      room.onChange = () => this.updateRoomUi();
      window.addEventListener('resize', this.resizeRoomUi);
      this.container.addEventListener('click', this.handleRoomClick);
      this.updateRoomUi(true);
    }

    this.session.onFrame = (frame) => this.applyFrameEvents(frame);
    this.session.onSnapshot = (arena, smoothLines) => this.renderer?.paintArena(arena, smoothLines);
    this.session.onEnded = (reason) => {
      this.screenManager.showMainMenu(reason);
    };

    document.getElementById('backBtn')?.addEventListener('click', () => {
      this.options.onLeave?.();
      this.screenManager.showMainMenu();
    });
    document.getElementById('lobbyBtn')?.addEventListener('click', () => {
      this.options.onBackToLobby?.();
    });

    // Mute button
    document.getElementById('muteBtn')?.addEventListener('click', () => {
      const sound = getSoundManager();
      const isMuted = sound.toggleMute();
      const btn = document.getElementById('muteBtn');
      if (btn) {
        // Update button text based on device
        if (isTouchDevice()) {
          btn.textContent = isMuted ? '🔇' : '🔊';
        } else {
          btn.textContent = isMuted ? '🔇 MUTED' : '🔊 SOUND';
        }
      }
    });

    // Fullscreen button (mobile only)
    document.getElementById('fullscreenBtn')?.addEventListener('click', () => {
      // On iOS, show instructions popup instead
      if (isIOS()) {
        const popup = document.getElementById('iosPopup');
        if (popup) popup.style.display = 'flex';
        return;
      }

      const elem = document.documentElement;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = document as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = elem as any;

      // Check if already in fullscreen
      const isFullscreen = doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement;

      if (isFullscreen) {
        // Exit fullscreen
        if (doc.exitFullscreen) {
          doc.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          doc.webkitExitFullscreen();
        } else if (doc.mozCancelFullScreen) {
          doc.mozCancelFullScreen();
        }
      } else {
        // Enter fullscreen
        if (el.requestFullscreen) {
          el.requestFullscreen();
        } else if (el.webkitRequestFullscreen) {
          el.webkitRequestFullscreen();
        } else if (el.mozRequestFullScreen) {
          el.mozRequestFullScreen();
        }
      }
    });

    // iOS popup close button
    document.getElementById('iosPopupClose')?.addEventListener('click', () => {
      const popup = document.getElementById('iosPopup');
      if (popup) popup.style.display = 'none';
    });

    // Close iOS popup when clicking outside
    document.getElementById('iosPopup')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        (e.currentTarget as HTMLElement).style.display = 'none';
      }
    });

    // FPS toggle with 'f' key
    this.fpsKeyHandler = (e: KeyboardEvent) => {
      if (e.code === 'KeyF') {
        this.showFps = !this.showFps;
        this.dirty = true;
        localStorage.setItem('showFps', this.showFps ? 'true' : 'false');
      }
      if (e.code === 'Space') this.watcherHolds = true;
    };
    document.addEventListener('keydown', this.fpsKeyHandler);
    document.getElementById('gameCanvas')?.addEventListener('pointerdown', () => { this.watcherHolds = true; });
    for (const type of ['keyup', 'pointerup', 'pointercancel', 'blur']) window.addEventListener(type, this.watcherRelease);

    // Double-tap on game canvas to toggle FPS on mobile
    if (isTouch) {
      const gameCanvas = document.getElementById('gameCanvas');
      gameCanvas?.addEventListener('touchend', (e) => {
        const now = Date.now();
        if (now - this.lastTapTime < 300) {
          this.showFps = !this.showFps;
          this.dirty = true;
          localStorage.setItem('showFps', this.showFps ? 'true' : 'false');
          e.preventDefault();
        }
        this.lastTapTime = now;
      });
    }

    // `?perf=1`: record phase timings for the benchmark harness
    // (design/research/performance.md)
    const perf = new URLSearchParams(location.search).has('perf');
    if (perf) {
      if (this.renderer) this.renderer.checkCanvasReadback = true;
      perfEnable();
      this.showPerfHud();
    }

    // Debug / end-to-end test hook
    const game = this;   // eslint-disable-line @typescript-eslint/no-this-alias
    (window as unknown as { __teratron?: unknown }).__teratron = {
      get config() { return game.config; },
      view: () => this.session.getViewState(),
      stats: () => this.session.getNetworkStats(),
      /** True if the simulation runs in a Web Worker */
      inWorker: () => (this.session as { inWorker?: boolean }).inWorker === true,
      ...(perf && { perf: perfDump, session: this.session }),
      audience: () => this.options.room?.audience() ?? null,
    };

    this.ticker = new Ticker(
      () => this.step(),
      () => this.draw(),
      { runInBackground: this.session.runsInBackground, timeScale: () => this.session.timeScale ?? 1 }
    );
    this.ticker.start();
  }

  // (Re)bind keyboard and touch input to the players played on this machine, and
  // show or hide the on-screen controls accordingly
  private setupInput(): void {
    this.input?.cleanup();
    const bindings = this.localBindings();
    this.input = new InputManager(bindings);

    const steerZone = document.getElementById('steerZone');
    const actionZone = document.getElementById('actionZone');
    const modeButton = document.getElementById('touchModeBtn');
    const playing = bindings.length > 0;
    for (const el of [steerZone, actionZone, modeButton]) {
      if (el) el.style.display = playing ? '' : 'none';
    }
    if (steerZone && !playing) steerZone.innerHTML = '';

    // Touch controls drive the first local human
    const actionButton = document.getElementById('actionButton');
    this.touchSlot = null;
    if (isTouchDevice() && bindings[0] && steerZone && actionButton) {
      const slot = bindings[0].slot;
      this.touchSlot = slot;
      this.input.initTouchControls(slot, steerZone, actionButton, modeButton, () => this.steerableHeading(slot));
    }

    const hint = document.getElementById('controlsHint');
    if (hint) hint.innerHTML = this.controlsHint();
  }

  // Network games: the join badge (room code, QR, spectator count) and what this user
  // can do about their seat. Cheap to call: the DOM is touched only on changes.
  private updateRoomUi(force = false): void {
    const room = this.options.room;
    if (!room) return;
    const audience = room.audience();
    this.renderer?.setAudience(audience);

    const playing = this.localBindings().length > 0;
    // The room can be one round ahead of the game: the game decides who plays now
    const me = playing ? (audience.me === 'leaving' ? 'leaving' : 'playing')
      : audience.me === 'waiting' ? 'waiting'
        : audience.me === 'joining' || audience.me === 'playing' ? 'joining' : 'watching';
    const phase = this.session.getViewState()?.round.phase;
    const key = JSON.stringify([audience.spectators, me, audience.queuePosition, this.showJoinQr, phase === 'waiting_ready', window.innerWidth, window.innerHeight]);
    if (key === this.roomUiKey && !force) return;
    this.roomUiKey = key;

    const touch = isTouchDevice();
    const button = (action: string, label: string, color: string): string => `<button data-room-action="${action}" style="
      padding: ${touch ? '6px 8px' : '0.4rem 0.8rem'}; font-family: monospace; font-size: ${touch ? '0.7rem' : '0.9rem'};
      cursor: pointer; background: rgba(0, 0, 0, 0.6); color: ${color}; border: 1px solid ${color}; border-radius: 4px;">${label}</button>`;

    // --- What this user can do about their seat ---
    let seat = '';
    const betweenRounds = this.session.getViewState()?.round.phase === 'waiting_ready';
    if (me === 'playing' && betweenRounds) {
      // On the round summary: the moment to stop
      seat = button('watch', '👁 WATCH THE NEXT ROUND', '#8cf');
    } else if (me === 'watching') {
      seat = `<span id="spectatorLabel" style="color: #8cf;">👁 SPECTATING</span> ${button('ask', 'PLAY NEXT ROUND', '#0f0')}`;
    } else if (me === 'joining') {
      seat = `<span id="spectatorLabel" style="color: #0c8;">You play from the next round</span> ${button('cancel', 'CANCEL', '#fa0')}`;
    } else if (me === 'waiting') {
      const position = audience.queuePosition > 0 ? ` (#${audience.queuePosition} in the queue)` : '';
      seat = `<span id="spectatorLabel" style="color: #888;">Waiting for a free seat${position}</span> ${button('cancel', 'CANCEL', '#fa0')}`;
    } else if (me === 'leaving') {
      seat = `<span id="spectatorLabel" style="color: #c84;">You watch from the next round</span> ${button('stay', 'UNDO', '#fa0')}`;
    }
    const seatBar = document.getElementById('seatBar');
    if (seatBar) {
      seatBar.innerHTML = seat;
      seatBar.style.display = seat ? '' : 'none';
    }
    const watchBtn = document.getElementById('watchBtn');
    if (watchBtn) watchBtn.style.display = me === 'playing' ? '' : 'none';

    // --- How to join ---
    const count = `<span id="watchCount" title="Spectators">👁 ${audience.spectators}</span>`;
    const badge = document.getElementById('joinBadge');
    if (!badge) return;
    // Where to type the code: the address of the game without the room parameter
    const site = room.link.replace(/^https?:\/\//, '').replace(/\?.*$/, '').replace(/\/$/, '');
    const qrBox = (size: string): string => `<div style="background: #fff; padding: 6px; border-radius: 3px; margin-bottom: 4px;
      width: ${size}; box-sizing: border-box;">${qrSvg(room.link)}</div>`;
    if (!touch) {
      // Desktop: the code in the header; a click on it opens the QR in a pop-over
      // (it covers the top of the arena while it is open)
      badge.innerHTML = `
        <button data-room-action="qr" title="Show a QR code to join this room" style="
          padding: 0.4rem 0.7rem; font-family: monospace; cursor: pointer; background: #010; color: #0f0;
          border: 1px solid #063; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <span style="color: #888;">JOIN</span> <span id="joinCode">${escapeHtml(room.code)}</span> · ${count}
        </button>
        ${this.showJoinQr ? `<div id="joinQrPop" style="position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
          z-index: 50; margin-top: 6px; background: #111; border: 1px solid #063; padding: 8px; border-radius: 4px; width: 176px;
          font-family: monospace; font-size: 0.7rem; color: #888; word-break: break-all;">
          ${qrBox('100%')}
          <span id="joinSite">${escapeHtml(site)}</span></div>` : ''}`;
    } else {
      // Phone: the code in the right-hand margin beside the 4:3 canvas when there is one,
      // otherwise on one small line among the top buttons. A tap on it opens the QR
      const margin = Math.max(0, (window.innerWidth - (window.innerHeight * 4) / 3) / 2);
      const inMargin = margin >= 70;
      const pop = this.showJoinQr ? `<div id="joinQrPop" data-room-action="qr" style="position: fixed; left: 50%; top: 50%;
        transform: translate(-50%, -50%); z-index: 150; background: #111; border: 1px solid #063; padding: 10px; border-radius: 6px;
        width: min(60vh, 220px); font-family: monospace; font-size: 0.7rem; color: #888; text-align: center; word-break: break-all;">
        ${qrBox('100%')}
        <div style="color: #0f0;">${escapeHtml(room.code)}</div>
        <span id="joinSite">${escapeHtml(site)}</span></div>` : '';
      if (inMargin) {
        badge.style.cssText = `position: absolute; right: 5px; top: 44px; width: ${Math.floor(margin - 10)}px; z-index: 105;
          text-align: center; font-family: monospace; font-size: 0.65rem; color: #0f0;`;
        badge.innerHTML = `
          <div data-room-action="qr" style="border: 1px solid #063; border-radius: 4px; padding: 4px 2px; background: rgba(0, 16, 0, 0.6);">
            <div id="joinCode" style="word-break: break-word;">${escapeHtml(room.code)}</div>
            <div style="color: #8cf; margin-top: 2px;">${count}</div>
          </div>${pop}`;
      } else {
        badge.style.cssText = `position: absolute; left: 50%; top: 8px; transform: translateX(-50%); z-index: 105;
          font-family: monospace; font-size: 0.65rem; color: #0f0; white-space: nowrap;`;
        badge.innerHTML = `<div data-room-action="qr" style="background: rgba(0, 0, 0, 0.5); padding: 2px 6px; border-radius: 3px;">
          <span id="joinCode">${escapeHtml(room.code)}</span> · ${count}</div>${pop}`;
      }
      if (seatBar) {
        // Spectators have no controls: their bar takes the left margin (or the corner)
        seatBar.style.width = margin >= 70 ? `${Math.floor(margin - 10)}px` : 'auto';
      }
    }
  }

  private renderDesktopLayout(): void {
    const soundManager = getSoundManager();
    this.container.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 1rem;
        min-height: 100vh;
      ">
        <div style="
          display: flex;
          justify-content: space-between;
          align-items: center;
          width: 800px;
          max-width: 100%;
          margin-bottom: 1rem;
        ">
          <h2 style="color: #0ff; margin: 0; text-shadow: 0 0 10px #0ff;">TERATRON</h2>
          ${this.options.room ? '<div id="joinBadge" style="position: relative; flex: 1; min-width: 0; margin: 0 1rem; text-align: center;"></div>' : ''}
          <div style="display: flex; gap: 0.5rem;">
            ${this.options.room ? `<button id="watchBtn" data-room-action="watch" title="Stop playing and watch from the next round" style="
              padding: 0.5rem 1rem;
              font-family: monospace;
              cursor: pointer;
              background: #012;
              color: #8cf;
              border: 1px solid #8cf;
              display: none;
            ">👁 WATCH</button>` : ''}
            <button id="muteBtn" style="
              padding: 0.5rem 1rem;
              font-family: monospace;
              cursor: pointer;
              background: #002;
              color: #0ff;
              border: 1px solid #0ff;
            ">${soundManager.isMuted() ? '🔇 MUTED' : '🔊 SOUND'}</button>
            ${this.options.onBackToLobby ? `<button id="lobbyBtn" title="Send everyone back to the lobby" style="
              padding: 0.5rem 1rem;
              font-family: monospace;
              cursor: pointer;
              background: #220;
              color: #fc4;
              border: 1px solid #fc4;
            ">LOBBY</button>` : ''}
            <button id="backBtn" style="
              padding: 0.5rem 1rem;
              font-family: monospace;
              cursor: pointer;
              background: #200;
              color: #f44;
              border: 1px solid #f44;
            ">BACK TO MENU</button>
          </div>
        </div>

        <div id="gameCanvas" style="
          display: flex;
          justify-content: center;
        "></div>

        <div id="seatBar" style="display: none; margin-top: 0.75rem; font-family: monospace; text-align: center;"></div>
        <div id="controlsHint" style="
          color: #888;
          margin-top: 0.75rem;
          text-align: center;
        ">
          ${this.controlsHint()}
        </div>
      </div>
    `;

    // Initialize renderer (desktop mode)
    const canvasContainer = document.getElementById('gameCanvas')!;
    this.renderer = new TronRenderer(canvasContainer, this.config.players, false);
  }

  private renderMobileLayout(): void {
    const soundManager = getSoundManager();
    // Force landscape orientation hint
    this.container.innerHTML = `
      <style>
        .mobile-game-container {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          height: 100dvh; /* Dynamic viewport height for mobile */
          display: flex;
          align-items: center;
          justify-content: center;
          background: #000;
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
          overflow: hidden;
        }
        .mobile-game-layout {
          position: relative;
          width: 100%;
          height: 100%;
        }
        .control-zone {
          position: absolute;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10;
        }
        .control-zone-right {
          right: 6px;
          bottom: 8px;
        }
        .steer-zone {
          position: absolute;
          left: 0;
          top: 44px;
          bottom: 0;
          width: 50%;
          z-index: 10;
          touch-action: none;
        }
        .steer-hint {
          position: absolute;
          left: 12px;
          bottom: 8px;
          color: rgba(0, 255, 255, 0.45);
          font-family: monospace;
          font-size: 0.65rem;
          pointer-events: none;
        }
        .steer-pads {
          position: absolute;
          left: 6px;
          bottom: 8px;
          display: flex;
          gap: 6px;
          pointer-events: none;
        }
        /* The on-screen controls live in the margin beside the canvas (--side, measured by
           layoutMobile) and shrink with it down to a minimum; only then do they overlap
           the arena. See design/touch-controls.md */
        .steer-pad, .action-button {
          width: clamp(52px, calc((var(--side) - 18px) / 2), 84px);
          height: 84px;
          border-radius: 14px;
          background: rgba(0, 255, 255, 0.12);
          border: 2px solid rgba(0, 255, 255, 0.4);
          color: rgba(0, 255, 255, 0.8);
          font-size: 1.8rem;
          display: flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
        }
        .steer-pad.active, .action-button.active {
          background: rgba(0, 255, 255, 0.4);
          border-color: #0ff;
        }
        .steer-stick {
          position: absolute;
          border-radius: 50%;
          background: rgba(0, 255, 255, 0.1);
          border: 2px solid rgba(0, 255, 255, 0.4);
          pointer-events: none;
        }
        .steer-knob {
          position: absolute;
          left: calc(50% - 18px);
          top: calc(50% - 18px);
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: rgba(0, 255, 255, 0.5);
        }
        .joystick-zone {
          position: absolute;
          left: 5px;
          bottom: 5px;
          width: clamp(72px, calc(var(--side) - 10px), 100px);
          aspect-ratio: 1;
          background: rgba(0, 255, 255, 0.12);
          border-radius: 50%;
          border: 2px solid rgba(0, 255, 255, 0.4);
        }
        .touch-mode-button {
          position: absolute;
          top: 42px;
          left: 5px;
          height: 32px;
          padding: 0 8px;
          font-family: monospace;
          font-size: 0.7rem;
          background: rgba(0, 32, 32, 0.7);
          color: #0ff;
          border: 1px solid #0ff;
          border-radius: 4px;
          z-index: 100;
          cursor: pointer;
        }
        /* (the rest of its looks are the steering pads') */
        .action-button {
          width: clamp(60px, calc(var(--side) - 12px), 84px);
          font-family: monospace;
          font-size: 0.7rem;
          font-weight: bold;
          line-height: 1.2;
          text-align: center;
          transition: opacity 0.15s;
        }
        .action-button.idle {
          opacity: 0.35;
        }
        .canvas-container {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .canvas-container canvas {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
        }
        .back-button-mobile {
          position: absolute;
          top: 5px;
          left: 5px;
          padding: 6px 10px;
          font-family: monospace;
          font-size: 0.7rem;
          background: rgba(32, 0, 0, 0.7);
          color: #f44;
          border: 1px solid #f44;
          border-radius: 4px;
          z-index: 100;
          cursor: pointer;
        }
        .top-button {
          position: absolute;
          top: 5px;
          padding: 6px;
          width: 32px;
          height: 32px;
          font-family: monospace;
          font-size: 1rem;
          line-height: 1;
          background: rgba(0, 32, 32, 0.7);
          color: #0ff;
          border: 1px solid #0ff;
          border-radius: 4px;
          z-index: 100;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .fullscreen-button {
          right: 5px;
        }
        .mute-button {
          right: 42px;
        }
        .ios-popup {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.85);
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .ios-popup-content {
          background: #111;
          border: 2px solid #0ff;
          border-radius: 12px;
          padding: 1.5rem;
          max-width: 300px;
          text-align: left;
          position: relative;
          color: #fff;
          font-family: monospace;
        }
        .ios-popup-content h3 {
          color: #0ff;
          margin: 0 0 1rem 0;
          text-align: center;
        }
        .ios-popup-content p {
          margin: 0.5rem 0;
        }
        .ios-popup-content ol {
          margin: 1rem 0;
          padding-left: 1.5rem;
        }
        .ios-popup-content li {
          margin: 0.5rem 0;
        }
        .ios-popup-close {
          position: absolute;
          top: 8px;
          right: 8px;
          background: none;
          border: none;
          color: #888;
          font-size: 1.2rem;
          cursor: pointer;
          padding: 4px 8px;
        }
        /* Portrait orientation warning */
        @media (orientation: portrait) {
          .rotate-hint {
            display: flex !important;
          }
          .mobile-game-layout {
            display: none !important;
          }
        }
        @media (orientation: landscape) {
          .rotate-hint {
            display: none !important;
          }
        }
        .rotate-hint {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: #000;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          color: #0ff;
          font-family: monospace;
          text-align: center;
          padding: 2rem;
          z-index: 200;
        }
        .rotate-icon {
          font-size: 4rem;
          margin-bottom: 1rem;
          animation: rotate-phone 2s ease-in-out infinite;
        }
        @keyframes rotate-phone {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(90deg); }
        }
      </style>

      <div class="mobile-game-container">
        <!-- Rotate hint for portrait mode -->
        <div class="rotate-hint">
          <div class="rotate-icon">📱</div>
          <div style="font-size: 1.2rem; margin-bottom: 0.5rem;">Rotate your device</div>
          <div style="color: #888;">Play in landscape mode</div>
        </div>

        <!-- Game layout -->
        <div class="mobile-game-layout">
          <!-- Top buttons -->
          <button id="backBtn" class="back-button-mobile">✕</button>
          ${this.options.onBackToLobby ? '<button id="lobbyBtn" class="back-button-mobile" style="left: 42px; color: #fc4; border-color: #fc4;" title="Back to lobby">⌂</button>' : ''}
          <button id="touchModeBtn" class="touch-mode-button" title="Steering mode"></button>
          <button id="muteBtn" class="top-button mute-button">${soundManager.isMuted() ? '🔇' : '🔊'}</button>
          ${this.options.room ? `<button id="watchBtn" data-room-action="watch" class="top-button" style="right: 79px; display: none;" title="Watch from the next round">👁</button>
          <div id="joinBadge"></div>
          <div id="seatBar" style="display: none; position: absolute; left: 5px; top: 80px; z-index: 20; font-family: monospace;
            font-size: 0.7rem; line-height: 1.6; background: rgba(0, 0, 0, 0.5); padding: 4px; border-radius: 4px; box-sizing: border-box;"></div>` : ''}
          <button id="fullscreenBtn" class="top-button fullscreen-button">⛶</button>

          <!-- iOS home screen popup -->
          <div id="iosPopup" class="ios-popup" style="display: none;">
            <div class="ios-popup-content">
              <button id="iosPopupClose" class="ios-popup-close">✕</button>
              <h3>Add to Home Screen</h3>
              <p>For fullscreen experience on iOS:</p>
              <ol>
                <li>Tap the <strong>Share</strong> button <span style="font-size: 1.2em;">⬆️</span></li>
                <li>Scroll down and tap <strong>"Add to Home Screen"</strong></li>
                <li>Tap <strong>Add</strong></li>
              </ol>
              <p style="color: #888; font-size: 0.8em;">Then open from your home screen</p>
            </div>
          </div>
          <!-- Full-screen Canvas -->
          <div id="gameCanvas" class="canvas-container"></div>

          <!-- Overlaid controls -->
          <!-- Left half: steering (built by TouchControls for the selected mode) -->
          <div id="steerZone" class="steer-zone"></div>

          <!-- Right: Action button -->
          <div id="actionZone" class="control-zone control-zone-right">
            <div id="actionButton" class="action-button">ACTION</div>
          </div>
        </div>
      </div>
    `;

    // Initialize renderer (mobile fullscreen mode)
    const canvasContainer = document.getElementById('gameCanvas')!;
    this.renderer = new TronRenderer(canvasContainer, this.config.players, true);

    // What is left of the screen on each side of the canvas: the room for the controls
    const layout = this.container.querySelector<HTMLElement>('.mobile-game-layout')!;
    this.mobileLayoutHandler = () => {
      const side = Math.max(0, (layout.clientWidth - layout.clientHeight * CANVAS_ASPECT) / 2);
      layout.style.setProperty('--side', `${side.toFixed(1)}px`);
    };
    this.mobileLayoutHandler();
    window.addEventListener('resize', this.mobileLayoutHandler);
  }

  // The on-screen action button says what a press does now (design/touch-controls.md)
  private showTouchAction(view: NonNullable<ReturnType<GameSession['getViewState']>>): void {
    if (this.touchSlot === null || !this.input) return;
    const slot = this.touchSlot;
    if (view.round.phase === 'waiting_ready') {
      this.input.showTouchAction(view.match.playersReady.includes(slot) ? 'NOT READY' : 'READY', true);
    } else {
      const alive = view.round.players.find(p => p.slotIndex === slot)?.alive === true;
      const speedUp = view.round.speedUp !== undefined && !!this.session.setSpeedUp;
      this.input.showTouchAction(speedUp ? 'SPEED UP' : 'ACTION', speedUp || (view.round.phase === 'playing' && alive));
    }
  }

  // What the arena says about speeding up, if anything (design/local-and-ai.md)
  private speedUpHint(speedUp: 'offered' | 'on' | undefined): string | null {
    if (speedUp === 'on') return `▶▶ ×${SPEED_UP_FACTOR}`;
    if (speedUp !== 'offered' || !this.session.setSpeedUp) return null;
    if (this.localBindings().length > 0) return 'Hold action to speed up time';
    return isTouchDevice() ? 'Hold the arena to speed up time' : 'Hold space to speed up time';
  }

  // Holding action (or, without a player here, space or the arena) speeds the round up
  // while that is offered; the press must have begun during the offer
  private checkSpeedUp(inputs: ReadonlyMap<SlotIndex, TronInput>): void {
    if (!this.session.setSpeedUp) return;
    let pressed = inputs.size === 0 && this.watcherHolds;
    for (const input of inputs.values()) pressed ||= input.action;
    const fresh = pressed && !this.actionWasPressed;
    this.actionWasPressed = pressed;
    const offered = this.session.getViewState()?.round.speedUp !== undefined;
    const speedingUp = pressed && offered && (this.speedingUp || fresh);
    if (speedingUp !== this.speedingUp) {
      this.speedingUp = speedingUp;
      this.session.setSpeedUp(speedingUp);
    }
  }

  // One simulation tick
  private step(): void {
    if (!this.input) return;
    const t0 = perfStart();
    const inputs = this.input.getInputs();
    this.session.step(inputs);
    this.checkSpeedUp(inputs);
    perfEnd('step', t0);
    this.dirty = true;

    // Track steps per second (should stay at TICK_RATE)
    const now = performance.now();
    this.stepTimes.push(now);
    while (this.stepTimes.length > 0 && this.stepTimes[0]! < now - 1000) this.stepTimes.shift();
    if (now - this.lastFpsUpdate > 500) {
      this.currentFps = this.stepTimes.length;
      this.lastFpsUpdate = now;
    }
  }

  // One display frame
  private draw(): void {
    if (!this.renderer) return;
    const view = this.session.getViewState();
    if (!view) {
      this.renderer.renderMessage('Waiting for host...');
      return;
    }

    this.showTouchAction(view);
    // The seat buttons depend on whether a round is being played
    if (view.round.phase !== this.roomUiPhase) {
      this.roomUiPhase = view.round.phase;
      this.updateRoomUi();
    }

    // Load the level image when the level changes
    const levelIndex = view.match.currentLevelIndex;
    if (levelIndex !== this.loadedLevelIndex && !this.levelLoading) {
      this.loadLevel(levelIndex);
    }

    // Nothing new since the last display frame: what is on the canvas is still right
    if (!this.dirty) return;
    this.dirty = false;

    const stats = this.session.getNetworkStats() ?? undefined;
    const t0 = perfStart();
    this.renderer.render(
      view.round, view.match, this.showFps ? this.currentFps : undefined,
      this.showFps ? stats : undefined, view.overlayTrails
    );
    perfEnd('render', t0);
    // `?botdebug=1`: what the bots know of the arena (design/bots-territory.md)
    const game = (this.session as { game?: TronGameState }).game;
    if (this.botDebug && game && view.round.phase === 'playing') this.botDebug.draw(this.renderer.context, game);
    const hint = this.speedUpHint(view.round.speedUp);
    if (hint) this.renderer.renderHint(hint);
    const silentMs = stats?.silentMs ?? 0;
    if (silentMs > HOST_SILENCE_MS) {
      this.renderer.renderNotice('Connection to the host lost', `waiting… ${Math.floor(silentMs / 1000)}s`);
    }
  }

  // Apply the one-shot events carried by a simulation frame (trail growth, cleared
  // pixels, sounds...) to the renderer and the sound manager. Must be called exactly
  // once per simulated frame, in order.
  private applyFrameEvents(state: TronGameStateData): void {
    const renderer = this.renderer;
    if (!renderer) return;
    this.dirty = true;

    if (state.roundStarted) {
      renderer.clearTrails();
    }
    // Eraser wipes everything drawn so far; segments in the same frame come after it
    if (state.eraserUsed) {
      renderer.restoreLevel();
    }
    for (const { slotIndex, segments } of state.newTrailSegments) {
      renderer.addTrailSegments(slotIndex, segments);
    }
    if (state.round.phase === 'playing') renderer.addPaths(state.round.players);
    if (state.borderSegments) {
      for (const { color, segments } of state.borderSegments) {
        renderer.addBorderSegments(color, segments);
      }
    }
    if (state.clearedLines) renderer.clearLines(state.clearedLines);
    if (state.clearedAreas) {
      for (const { x, y, w, h } of state.clearedAreas) {
        renderer.clearRect(x, y, w, h);
      }
    }
    if (state.deaths) {
      for (const d of state.deaths) {
        const name = this.config.players.find(p => p.slotIndex === d.slotIndex)?.nickname ?? d.slotIndex;
        console.info(`[game] ${name} died: ${d.cause}${d.by !== undefined ? ` by slot ${d.by}` : ''} at ${d.x},${d.y}`);
        renderer.recordDeath(d.slotIndex, d.cause, d.by);
      }
    }
    if (state.ridiculousDeathSlots) {
      for (const slot of state.ridiculousDeathSlots) {
        renderer.triggerRidiculousDeath(slot);
      }
    }
    renderer.updateColorBlindness(state.colorBlindnessFrames ?? 0);
    renderer.updateWhiteFlash(state.whiteFlashFrames ?? 0);

    // Stop sound loops whenever a round ends or restarts, so that a loop cannot
    // outlive the round that started it
    const phase = state.round.phase;
    if (this.previousPhase !== phase) {
      if (phase === 'waiting_ready' || phase === 'countdown') {
        getSoundManager().stopAllLoops();
      }
      this.previousPhase = phase;
    }

    this.playSoundEvents(state.soundEvents);
  }

  private playSoundEvents(events: SoundEvent[]): void {
    const sound = getSoundManager();
    for (const event of events) {
      if (event.stopLoop) {
        sound.stopLoop(event.stopLoop);
      } else if (event.loop && event.loopKey) {
        sound.playLoop(event.sound as SoundName, event.loopKey);
      } else if (event.sound) {
        sound.play(event.sound as SoundName);
      }
    }
  }

  private loadLevel(levelIndex: number): void {
    if (!this.renderer) return;

    const level = LEVELS[levelIndex];
    if (!level) return;

    this.levelLoading = true;

    this.renderer.loadLevel(level).then((obstacles) => {
      this.session.setLevelObstacles(levelIndex, obstacles);
      this.loadedLevelIndex = levelIndex;
      this.levelLoading = false;
      this.dirty = true;
    }).catch((error) => {
      console.error('Failed to load level:', error);
      this.levelLoading = false;
    });
  }

  // Once a second: ticks per second and, per phase, mean / worst milliseconds of the
  // last second (design/research/performance.md)
  private showPerfHud(): void {
    const hud = document.createElement('pre');
    hud.style.cssText = 'position:fixed;right:4px;bottom:4px;margin:0;padding:3px 5px;z-index:1000;' +
      'font:10px/1.25 monospace;color:#0f0;background:rgba(0,0,0,0.65);pointer-events:none;';
    document.body.appendChild(hud);
    this.perfHud = hud;
    const cursor = new Map<string, number>();
    // With `?worker=1` the simulation's timers are in the worker
    const worker = this.session as { inWorker?: boolean; workerSummary?: () => Promise<{ summary: PerfSummary; droppedTicks: number }> };
    const row = (name: string, s: PerfSummary[string] | undefined, rate = false): string =>
      s ? `${name.padEnd(11)} ${s.mean.toFixed(2).padStart(6)} ${s.worst.toFixed(1).padStart(6)}${rate ? `  ${s.n}/s` : ''}\n` : '';
    this.perfHudTimer = setInterval(() => {
      const main = perfSince(cursor);
      void ((worker.inWorker ? worker.workerSummary?.() : null) ?? Promise.resolve(null)).then((remote) => {
        const sim = remote?.summary ?? main;
        let text = 'ms            mean  worst\n';
        text += row(remote ? 'w.step' : 'step', sim.step, true);
        for (const phase of ['bots', 'sim', 'serialize']) text += row(remote ? `w.${phase}` : phase, sim[phase]);
        for (const phase of ['events', 'render', 'frame', 'workerLag']) text += row(phase, main[phase]);
        text += `dropped ticks: ${remote ? remote.droppedTicks : perfCounter('droppedTicks')}`;
        const off = this.renderer?.canvasReadbackDifference;
        if (off !== null && off !== undefined) text += `\ncanvas read-back off by ${off} px`;
        hud.textContent = text;
      });
    }, 1000);
  }

  cleanup(): void {
    getSoundManager().stopAllLoops();

    if (this.perfHudTimer !== null) clearInterval(this.perfHudTimer);
    this.perfHudTimer = null;
    this.perfHud?.remove();
    this.perfHud = null;

    this.ticker?.stop();
    this.ticker = null;

    if (this.fpsKeyHandler) {
      document.removeEventListener('keydown', this.fpsKeyHandler);
      this.fpsKeyHandler = null;
    }
    for (const type of ['keyup', 'pointerup', 'pointercancel', 'blur']) window.removeEventListener(type, this.watcherRelease);

    this.input?.cleanup();
    this.input = null;
    if (this.mobileLayoutHandler) {
      window.removeEventListener('resize', this.mobileLayoutHandler);
      this.mobileLayoutHandler = null;
    }

    this.renderer?.destroy();
    this.renderer = null;
    this.botDebug?.destroy();
    this.botDebug = null;

    window.removeEventListener('resize', this.resizeRoomUi);
    this.container.removeEventListener('click', this.handleRoomClick);
    if (this.options.room) this.options.room.onChange = null;
    this.session.onRoster = null;
    this.session.onFrame = null;
    this.session.onSnapshot = null;
    this.session.onEnded = null;
    this.session.destroy();
  }
}
