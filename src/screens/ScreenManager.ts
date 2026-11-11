// Screen manager for navigation between screens

import type { GameConfig } from '../types/game';
import type { GameConnection } from '../network/GameConnection';

export interface Screen {
  render(): void;
  cleanup(): void;
}

export interface LobbyOptions {
  mode: 'host' | 'guest';
  roomId?: string; // Required for guest mode
}

export class ScreenManager {
  private container: HTMLElement;
  private currentScreen: Screen | null = null;

  // Screen factories (to avoid circular dependencies)
  private mainMenuFactory: (() => Screen) | null = null;
  private networkLobbyFactory: ((options: LobbyOptions) => Screen) | null = null;
  private gameFactory: ((config: GameConfig, connection: GameConnection) => Screen) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  setScreenFactories(factories: {
    mainMenu: () => Screen;
    networkLobby: (options: LobbyOptions) => Screen;
    game: (config: GameConfig, connection: GameConnection) => Screen;
  }): void {
    this.mainMenuFactory = factories.mainMenu;
    this.networkLobbyFactory = factories.networkLobby;
    this.gameFactory = factories.game;
  }

  init(): void {
    // Check for room parameter in URL
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');

    if (roomId) {
      // Auto-join as guest (lowercase for case-insensitivity)
      this.showNetworkLobby({ mode: 'guest', roomId: roomId.toLowerCase() });
    } else {
      this.showMainMenu();
    }
  }

  showMainMenu(): void {
    if (!this.mainMenuFactory) {
      console.error('MainMenu factory not set');
      return;
    }
    this.transition(this.mainMenuFactory());
    // Clear URL params
    window.history.pushState({}, '', window.location.pathname);
  }

  showNetworkLobby(options: LobbyOptions): void {
    if (!this.networkLobbyFactory) {
      console.error('NetworkLobby factory not set');
      return;
    }
    this.transition(this.networkLobbyFactory(options));
  }

  showGame(config: GameConfig, connection: GameConnection): void {
    if (!this.gameFactory) {
      console.error('Game factory not set');
      return;
    }
    this.transition(this.gameFactory(config, connection));
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  private transition(newScreen: Screen): void {
    if (this.currentScreen) {
      this.currentScreen.cleanup();
    }
    this.container.innerHTML = '';
    this.currentScreen = newScreen;
    this.currentScreen.render();
  }
}
