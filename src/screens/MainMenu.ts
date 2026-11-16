// Main menu screen

import type { Screen, ScreenManager } from './ScreenManager';
import { escapeHtml } from '../util/html';
import { normalizeRoomCode } from '../network/roomCode';

export class MainMenu implements Screen {
  private container: HTMLElement;
  private screenManager: ScreenManager;
  private showingSubmenu: boolean = false;
  private showingJoinInput: boolean = false;

  private message: string | undefined;

  constructor(container: HTMLElement, screenManager: ScreenManager, message?: string) {
    this.container = container;
    this.screenManager = screenManager;
    this.message = message;
  }

  render(): void {
    // Layout: screens.css and design/screen-layout.md
    this.container.innerHTML = `
      <div class="ui-screen menu-screen">
        <h1 class="menu-title">TERATRON</h1>

        <div class="menu-items">
          ${this.message ? `<div class="menu-message">${escapeHtml(this.message)}</div>` : ''}

          <div class="menu-main">
            <button id="localGameBtn" class="menu-btn">LOCAL GAME</button>
            <button id="networkGameBtn" class="menu-btn">NETWORK GAME</button>
          </div>

          <div id="submenu" class="menu-sub ui-panel">
            <button id="createRoomBtn" class="ui-btn ui-btn-green">CREATE ROOM</button>
            <button id="joinRoomBtn" class="ui-btn ui-btn-blue">JOIN ROOM</button>
          </div>

          <div id="joinInputSection" class="menu-sub menu-join ui-panel">
            <label for="roomCodeInput">Enter room code or paste link:</label>
            <input id="roomCodeInput" class="ui-input" type="text" placeholder="red-bear-moon"
              autocapitalize="none" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="go" />
            <div class="ui-row">
              <button id="joinConfirmBtn" class="ui-btn ui-btn-green">JOIN</button>
              <button id="joinCancelBtn" class="ui-btn ui-btn-red">CANCEL</button>
            </div>
            <div id="joinError" class="menu-error" style="display: none;"></div>
          </div>
        </div>
      </div>
    `;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const networkGameBtn = document.getElementById('networkGameBtn');
    const submenu = document.getElementById('submenu');
    const createRoomBtn = document.getElementById('createRoomBtn');
    const joinRoomBtn = document.getElementById('joinRoomBtn');
    const joinInputSection = document.getElementById('joinInputSection');
    const roomCodeInput = document.getElementById('roomCodeInput') as HTMLInputElement;
    const joinConfirmBtn = document.getElementById('joinConfirmBtn');
    const joinCancelBtn = document.getElementById('joinCancelBtn');
    const joinError = document.getElementById('joinError');

    document.getElementById('localGameBtn')?.addEventListener('click', () => {
      this.screenManager.showLocalSetup();
    });

    // Toggle submenu
    networkGameBtn?.addEventListener('click', () => {
      if (this.showingJoinInput) {
        // Hide join input, show submenu
        if (joinInputSection) joinInputSection.style.display = 'none';
        if (submenu) submenu.style.display = 'flex';
        this.showingJoinInput = false;
        this.showingSubmenu = true;
      } else if (this.showingSubmenu) {
        // Hide submenu
        if (submenu) submenu.style.display = 'none';
        this.showingSubmenu = false;
      } else {
        // Show submenu
        if (submenu) submenu.style.display = 'flex';
        this.showingSubmenu = true;
      }
    });

    // Create room
    createRoomBtn?.addEventListener('click', () => {
      this.screenManager.showNetworkLobby({ mode: 'host' });
    });

    // Show join input
    joinRoomBtn?.addEventListener('click', () => {
      if (submenu) submenu.style.display = 'none';
      if (joinInputSection) joinInputSection.style.display = 'flex';
      this.showingSubmenu = false;
      this.showingJoinInput = true;
      roomCodeInput?.focus();
    });

    // Join room
    joinConfirmBtn?.addEventListener('click', () => {
      this.handleJoin(roomCodeInput, joinError);
    });

    roomCodeInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.handleJoin(roomCodeInput, joinError);
      }
    });

    // Cancel join
    joinCancelBtn?.addEventListener('click', () => {
      if (joinInputSection) joinInputSection.style.display = 'none';
      if (submenu) submenu.style.display = 'flex';
      if (roomCodeInput) roomCodeInput.value = '';
      if (joinError) joinError.style.display = 'none';
      this.showingJoinInput = false;
      this.showingSubmenu = true;
    });
  }

  private handleJoin(input: HTMLInputElement | null, errorEl: HTMLElement | null): void {
    const value = input?.value.trim() ?? '';
    const roomId = this.extractRoomId(value);

    if (!roomId) {
      if (errorEl) {
        errorEl.textContent = 'Please enter a valid room code or link';
        errorEl.style.display = 'block';
      }
      return;
    }

    this.screenManager.showNetworkLobby({ mode: 'guest', roomId });
  }

  private extractRoomId(input: string): string | null {
    if (!input) return null;

    // If it's a URL, extract the room parameter
    if (input.includes('?room=') || input.includes('&room=')) {
      try {
        const url = new URL(input.startsWith('http') ? input : `https://example.com${input}`);
        return normalizeRoomCode(url.searchParams.get('room') ?? '') || null;
      } catch {
        return null;
      }
    }

    return normalizeRoomCode(input) || null;
  }

  cleanup(): void {
    // No cleanup needed for static menu
  }
}
