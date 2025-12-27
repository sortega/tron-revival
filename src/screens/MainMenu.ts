// Main menu screen

import type { Screen, ScreenManager } from './ScreenManager';

export class MainMenu implements Screen {
  private container: HTMLElement;
  private screenManager: ScreenManager;
  private showingSubmenu: boolean = false;
  private showingJoinInput: boolean = false;

  constructor(container: HTMLElement, screenManager: ScreenManager) {
    this.container = container;
    this.screenManager = screenManager;
  }

  render(): void {
    this.container.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 2rem;
      ">
        <h1 style="
          font-size: 4rem;
          color: #0ff;
          text-shadow: 0 0 20px #0ff, 0 0 40px #0ff;
          margin-bottom: 3rem;
          letter-spacing: 0.5rem;
          font-family: monospace;
        ">TERATRON</h1>

        <div style="
          display: flex;
          flex-direction: column;
          gap: 1rem;
          align-items: center;
        ">
          <button id="localGameBtn" style="
            padding: 1rem 3rem;
            font-size: 1.2rem;
            font-family: monospace;
            background: #333;
            color: #666;
            border: 2px solid #444;
            cursor: not-allowed;
            position: relative;
          " disabled>
            LOCAL GAME
            <span style="
              position: absolute;
              top: -10px;
              right: -10px;
              background: #444;
              color: #888;
              font-size: 0.6rem;
              padding: 2px 6px;
              border-radius: 3px;
            ">COMING SOON</span>
          </button>

          <button id="networkGameBtn" style="
            padding: 1rem 3rem;
            font-size: 1.2rem;
            font-family: monospace;
            background: #111;
            color: #0ff;
            border: 2px solid #0ff;
            cursor: pointer;
            transition: all 0.2s;
          ">
            NETWORK GAME
          </button>

          <div id="submenu" style="
            display: none;
            flex-direction: column;
            gap: 0.5rem;
            margin-top: 0.5rem;
            padding: 1rem;
            background: #111;
            border: 1px solid #333;
            border-radius: 4px;
          ">
            <button id="createRoomBtn" style="
              padding: 0.75rem 2rem;
              font-size: 1rem;
              font-family: monospace;
              background: #020;
              color: #0f0;
              border: 1px solid #0f0;
              cursor: pointer;
            ">
              CREATE ROOM
            </button>
            <button id="joinRoomBtn" style="
              padding: 0.75rem 2rem;
              font-size: 1rem;
              font-family: monospace;
              background: #002;
              color: #08f;
              border: 1px solid #08f;
              cursor: pointer;
            ">
              JOIN ROOM
            </button>
          </div>

          <div id="joinInputSection" style="
            display: none;
            flex-direction: column;
            gap: 0.5rem;
            margin-top: 0.5rem;
            padding: 1rem;
            background: #111;
            border: 1px solid #333;
            border-radius: 4px;
            align-items: center;
          ">
            <label style="color: #888; font-size: 0.9rem;">Enter room code or paste link:</label>
            <input id="roomCodeInput" type="text" placeholder="abc123xyz" style="
              padding: 0.5rem;
              font-size: 1rem;
              font-family: monospace;
              background: #000;
              color: #0ff;
              border: 1px solid #0ff;
              width: 250px;
              text-align: center;
            " />
            <div style="display: flex; gap: 0.5rem;">
              <button id="joinConfirmBtn" style="
                padding: 0.5rem 1.5rem;
                font-family: monospace;
                background: #020;
                color: #0f0;
                border: 1px solid #0f0;
                cursor: pointer;
              ">JOIN</button>
              <button id="joinCancelBtn" style="
                padding: 0.5rem 1.5rem;
                font-family: monospace;
                background: #200;
                color: #f44;
                border: 1px solid #f44;
                cursor: pointer;
              ">CANCEL</button>
            </div>
            <div id="joinError" style="color: #f44; font-size: 0.8rem; display: none;"></div>
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

    // Hover effects
    networkGameBtn?.addEventListener('mouseenter', () => {
      networkGameBtn.style.background = '#022';
      networkGameBtn.style.boxShadow = '0 0 10px #0ff';
    });
    networkGameBtn?.addEventListener('mouseleave', () => {
      networkGameBtn.style.background = '#111';
      networkGameBtn.style.boxShadow = 'none';
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
        return url.searchParams.get('room');
      } catch {
        return null;
      }
    }

    // Otherwise treat it as a room ID (must be non-empty)
    return input.length > 0 ? input : null;
  }

  cleanup(): void {
    // No cleanup needed for static menu
  }
}
