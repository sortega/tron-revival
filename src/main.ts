import { ScreenManager } from './screens/ScreenManager';
import { MainMenu } from './screens/MainMenu';
import { NetworkLobby } from './screens/NetworkLobby';
import { TronGame } from './game/TronGame';

const app = document.querySelector<HTMLDivElement>('#app')!;

// Initialize screen manager
const screenManager = new ScreenManager(app);

// Set up screen factories
screenManager.setScreenFactories({
  mainMenu: () => new MainMenu(app, screenManager),
  networkLobby: (options) => new NetworkLobby(app, screenManager, options),
  placeholderGame: (config, connection) => new TronGame(app, screenManager, config, connection),
});

// Start the app
screenManager.init();
