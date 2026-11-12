import { ScreenManager } from './screens/ScreenManager';
import { MainMenu } from './screens/MainMenu';
import { NetworkLobby } from './screens/NetworkLobby';
import { LocalSetup } from './screens/LocalSetup';
import { TronGame } from './game/TronGame';

const app = document.querySelector<HTMLDivElement>('#app')!;

// Initialize screen manager
const screenManager = new ScreenManager(app);

// Set up screen factories
screenManager.setScreenFactories({
  mainMenu: (message) => new MainMenu(app, screenManager, message),
  localSetup: () => new LocalSetup(app, screenManager),
  networkLobby: (options) => new NetworkLobby(app, screenManager, options),
  game: (config, session, options) => new TronGame(app, screenManager, config, session, options),
});

// Start the app
screenManager.init();
