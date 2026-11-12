// Screen manager for navigation between screens

import type { GameConfig } from '../types/game';
import type { GameSession } from '../game/session/GameSession';
import type { RoomConnection } from '../network/RoomConnection';
import { normalizeRoomCode } from '../network/roomCode';

export interface Screen {
  render(): void;
  cleanup(): void;
}

export type LobbyOptions =
  | { mode: 'host' }
  | { mode: 'guest'; roomId: string }
  | { room: RoomConnection };   // Return to the lobby of a room we are already in

/** Hooks a game screen gets from whoever started the game. */
export interface GameScreenOptions {
  /** Host of a network game: send everybody back to the lobby. */
  onBackToLobby?: () => void;
  /** Called when the player leaves the game for the main menu. */
  onLeave?: () => void;
}

export class ScreenManager {
  private container: HTMLElement;
  private currentScreen: Screen | null = null;

  // Screen factories (to avoid circular dependencies)
  private mainMenuFactory: ((message?: string) => Screen) | null = null;
  private localSetupFactory: (() => Screen) | null = null;
  private networkLobbyFactory: ((options: LobbyOptions) => Screen) | null = null;
  private gameFactory: ((config: GameConfig, session: GameSession, options: GameScreenOptions) => Screen) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  setScreenFactories(factories: {
    mainMenu: (message?: string) => Screen;
    localSetup: () => Screen;
    networkLobby: (options: LobbyOptions) => Screen;
    game: (config: GameConfig, session: GameSession, options: GameScreenOptions) => Screen;
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

    const code = roomId ? normalizeRoomCode(roomId) : '';
    if (code) {
      // Shared link, or a reload while in a room: (re)join it
      this.showNetworkLobby({ mode: 'guest', roomId: code });
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

  showGame(config: GameConfig, session: GameSession, options: GameScreenOptions = {}): void {
    if (!this.gameFactory) {
      console.error('Game factory not set');
      return;
    }
    this.transition(this.gameFactory(config, session, options));
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
