/**
 * UI Manager
 * Manages screen transitions and UI state
 */

import { MainMenu } from './MainMenu';
import { NetworkMenu } from './NetworkMenu';
import { Lobby } from './Lobby';

export type Screen = 'main-menu' | 'network-menu' | 'lobby' | 'game';

export interface UICallbacks {
  onStartLocalGame: (numPlayers: number) => void;
  onCreateRoom: () => void;
  onJoinRoom: (roomId: string) => void;
  onStartGame: () => void;
  onDisconnect: () => void;
}

export class UIManager {
  private container: HTMLElement;
  private currentScreen: Screen | null = null;
  private mainMenu: MainMenu;
  private networkMenu: NetworkMenu;
  private lobby: Lobby;
  private callbacks: UICallbacks;

  constructor(container: HTMLElement, callbacks: UICallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    // Create UI components
    this.mainMenu = new MainMenu(
      (numPlayers) => this.handleStartLocalGame(numPlayers),
      () => this.showScreen('network-menu')
    );

    this.networkMenu = new NetworkMenu(
      () => this.handleCreateRoom(),
      (roomId) => this.handleJoinRoom(roomId),
      () => this.showScreen('main-menu')
    );

    this.lobby = new Lobby(
      () => this.handleStartGame(),
      () => this.handleDisconnect()
    );
  }

  /**
   * Show a specific screen
   */
  showScreen(screen: Screen): void {
    this.currentScreen = screen;

    // Clear container (except for game screen, which is already set up by callback)
    if (screen !== 'game') {
      this.container.innerHTML = '';
    }

    // Show the appropriate screen
    switch (screen) {
      case 'main-menu':
        this.container.appendChild(this.mainMenu.render());
        break;
      case 'network-menu':
        this.container.appendChild(this.networkMenu.render());
        break;
      case 'lobby':
        this.container.appendChild(this.lobby.render());
        break;
      case 'game':
        // Game screen is already set up by the onStartLocalGame or onStartGame callback
        break;
    }
  }

  /**
   * Update lobby with current player list
   */
  updateLobby(
    players: Array<{ name: string; color: string; isReady: boolean; isHost: boolean; isYou?: boolean }>,
    roomId?: string
  ): void {
    this.lobby.updatePlayers(players, roomId);
  }

  /**
   * Get current screen
   */
  getCurrentScreen(): Screen | null {
    return this.currentScreen;
  }

  // Event handlers

  private handleStartLocalGame(numPlayers: number): void {
    this.callbacks.onStartLocalGame(numPlayers);
    this.showScreen('game');
  }

  private handleCreateRoom(): void {
    this.callbacks.onCreateRoom();
    this.showScreen('lobby');
  }

  private handleJoinRoom(roomId: string): void {
    this.callbacks.onJoinRoom(roomId);
    this.showScreen('lobby');
  }

  private handleStartGame(): void {
    this.callbacks.onStartGame();
    this.showScreen('game');
  }

  private handleDisconnect(): void {
    this.callbacks.onDisconnect();
    this.showScreen('main-menu');
  }
}
