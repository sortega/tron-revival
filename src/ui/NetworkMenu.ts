/**
 * Network Menu
 * Create or join network game
 */

export class NetworkMenu {
  private onCreateRoom: () => void;
  private onJoinRoom: (roomId: string) => void;
  private onBack: () => void;
  private showingJoinDialog = false;

  constructor(
    onCreateRoom: () => void,
    onJoinRoom: (roomId: string) => void,
    onBack: () => void
  ) {
    this.onCreateRoom = onCreateRoom;
    this.onJoinRoom = onJoinRoom;
    this.onBack = onBack;
  }

  render(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'menu-screen network-menu';

    if (!this.showingJoinDialog) {
      // Main network menu
      container.innerHTML = `
        <div class="menu-content">
          <h1 class="menu-title">NETWORK GAME</h1>
          <div class="menu-buttons">
            <button class="menu-button" data-action="create-room">Create Room</button>
            <button class="menu-button" data-action="join-room">Join Room</button>
            <button class="menu-button menu-button-secondary" data-action="back">Back</button>
          </div>
        </div>
      `;

      // Add event listeners
      const createBtn = container.querySelector('[data-action="create-room"]') as HTMLButtonElement;
      const joinBtn = container.querySelector('[data-action="join-room"]') as HTMLButtonElement;
      const backBtn = container.querySelector('[data-action="back"]') as HTMLButtonElement;

      createBtn.addEventListener('click', () => {
        this.onCreateRoom();
      });

      joinBtn.addEventListener('click', () => {
        this.showingJoinDialog = true;
        this.showJoinDialog(container);
      });

      backBtn.addEventListener('click', () => {
        this.onBack();
      });
    }

    return container;
  }

  private showJoinDialog(container: HTMLElement): void {
    container.innerHTML = `
      <div class="menu-content">
        <h1 class="menu-title">JOIN ROOM</h1>
        <div class="join-dialog">
          <p class="dialog-text">Enter room code or paste link:</p>
          <input type="text" class="room-input" placeholder="abc123xyz" autofocus>
          <div class="error-message" style="display: none;"></div>
          <div class="menu-buttons">
            <button class="menu-button" data-action="join">Join</button>
            <button class="menu-button menu-button-secondary" data-action="cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;

    const input = container.querySelector('.room-input') as HTMLInputElement;
    const errorMsg = container.querySelector('.error-message') as HTMLElement;
    const joinBtn = container.querySelector('[data-action="join"]') as HTMLButtonElement;
    const cancelBtn = container.querySelector('[data-action="cancel"]') as HTMLButtonElement;

    const handleJoin = () => {
      let roomId = input.value.trim();

      if (!roomId) {
        this.showError(errorMsg, 'Please enter a room code');
        return;
      }

      // Extract room ID from URL if full URL was pasted
      if (roomId.includes('?room=')) {
        const match = roomId.match(/[?&]room=([^&]+)/);
        if (match) {
          roomId = match[1] || '';
        }
      }

      // For now, just accept any non-empty string (Phase 2 will validate with PeerJS)
      this.showingJoinDialog = false;
      this.onJoinRoom(roomId);
    };

    joinBtn.addEventListener('click', handleJoin);

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        handleJoin();
      }
    });

    cancelBtn.addEventListener('click', () => {
      this.showingJoinDialog = false;
      const newContainer = this.render();
      container.parentElement?.replaceChild(newContainer, container);
    });
  }

  private showError(element: HTMLElement, message: string): void {
    element.textContent = message;
    element.style.display = 'block';
    setTimeout(() => {
      element.style.display = 'none';
    }, 3000);
  }
}
