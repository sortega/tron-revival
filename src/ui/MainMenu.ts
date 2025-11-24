/**
 * Main Menu
 * Initial screen with Local Game and Network Game options
 */

export class MainMenu {
  private onLocalGame: (numPlayers: number) => void;
  private onNetworkGame: () => void;
  private showingPlayerSelect = false;

  constructor(
    onLocalGame: (numPlayers: number) => void,
    onNetworkGame: () => void
  ) {
    this.onLocalGame = onLocalGame;
    this.onNetworkGame = onNetworkGame;
  }

  render(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'menu-screen main-menu';

    if (!this.showingPlayerSelect) {
      // Main menu
      container.innerHTML = `
        <div class="menu-content">
          <h1 class="menu-title">TERATRON</h1>
          <div class="menu-buttons">
            <button class="menu-button" data-action="local-game">Local Game</button>
            <button class="menu-button" data-action="network-game">Network Game</button>
          </div>
        </div>
      `;

      // Add event listeners
      const localBtn = container.querySelector('[data-action="local-game"]') as HTMLButtonElement;
      const networkBtn = container.querySelector('[data-action="network-game"]') as HTMLButtonElement;

      localBtn.addEventListener('click', () => {
        this.showingPlayerSelect = true;
        this.showPlayerSelect(container);
      });

      networkBtn.addEventListener('click', () => {
        this.onNetworkGame();
      });
    }

    return container;
  }

  private showPlayerSelect(container: HTMLElement): void {
    container.innerHTML = `
      <div class="menu-content">
        <h1 class="menu-title">TERATRON</h1>
        <h2 class="menu-subtitle">Select Number of Players</h2>
        <div class="menu-buttons">
          <button class="menu-button" data-players="2">2 Players</button>
          <button class="menu-button" data-players="3">3 Players</button>
          <button class="menu-button" data-players="4">4 Players</button>
          <button class="menu-button menu-button-secondary" data-action="back">Back</button>
        </div>
      </div>
    `;

    // Add event listeners
    const buttons = container.querySelectorAll('[data-players]');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const numPlayers = parseInt((btn as HTMLElement).dataset.players || '2');
        this.showingPlayerSelect = false;
        this.onLocalGame(numPlayers);
      });
    });

    const backBtn = container.querySelector('[data-action="back"]') as HTMLButtonElement;
    backBtn.addEventListener('click', () => {
      this.showingPlayerSelect = false;
      const newContainer = this.render();
      container.parentElement?.replaceChild(newContainer, container);
    });
  }
}
