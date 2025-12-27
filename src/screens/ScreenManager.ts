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
  private placeholderGameFactory: ((config: GameConfig, connection: GameConnection) => Screen) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  setScreenFactories(factories: {
    mainMenu: () => Screen;
    networkLobby: (options: LobbyOptions) => Screen;
    placeholderGame: (config: GameConfig, connection: GameConnection) => Screen;
  }): void {
    this.mainMenuFactory = factories.mainMenu;
    this.networkLobbyFactory = factories.networkLobby;
    this.placeholderGameFactory = factories.placeholderGame;
  }

  init(): void {
    // Check for room parameter in URL
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');

    if (roomId) {
      // Auto-join as guest
      this.showNetworkLobby({ mode: 'guest', roomId });
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
    if (!this.placeholderGameFactory) {
      console.error('PlaceholderGame factory not set');
      return;
    }
    this.transition(this.placeholderGameFactory(config, connection));
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
