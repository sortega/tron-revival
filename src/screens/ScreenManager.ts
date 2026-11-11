// Screen manager for navigation between screens

import type { GameConfig } from '../types/game';
import type { GameSession } from '../game/session/GameSession';

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
  private mainMenuFactory: ((message?: string) => Screen) | null = null;
  private localSetupFactory: (() => Screen) | null = null;
  private networkLobbyFactory: ((options: LobbyOptions) => Screen) | null = null;
  private gameFactory: ((config: GameConfig, session: GameSession) => Screen) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  setScreenFactories(factories: {
    mainMenu: (message?: string) => Screen;
    localSetup: () => Screen;
    networkLobby: (options: LobbyOptions) => Screen;
    game: (config: GameConfig, session: GameSession) => Screen;
  }): void {
    this.mainMenuFactory = factories.mainMenu;
    this.localSetupFactory = factories.localSetup;
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

  /** Show the main menu, optionally with a notice (e.g. why a game ended). */
  showMainMenu(message?: string): void {
    if (!this.mainMenuFactory) {
      console.error('MainMenu factory not set');
      return;
    }
    this.transition(this.mainMenuFactory(message));
    // Clear URL params without adding a history entry
    window.history.replaceState({}, '', window.location.pathname);
  }

  showLocalSetup(): void {
    if (!this.localSetupFactory) {
      console.error('LocalSetup factory not set');
      return;
    }
    this.transition(this.localSetupFactory());
  }

  showNetworkLobby(options: LobbyOptions): void {
    if (!this.networkLobbyFactory) {
      console.error('NetworkLobby factory not set');
      return;
    }
    this.transition(this.networkLobbyFactory(options));
  }

  showGame(config: GameConfig, session: GameSession): void {
    if (!this.gameFactory) {
      console.error('Game factory not set');
      return;
    }
    this.transition(this.gameFactory(config, session));
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
