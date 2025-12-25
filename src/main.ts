import { ConnectionTest } from './network/ConnectionTest';

const app = document.querySelector<HTMLDivElement>('#app')!;

// For now, show the P2P connection test page
const test = new ConnectionTest(app);
test.render();
