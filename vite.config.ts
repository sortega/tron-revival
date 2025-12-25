import { defineConfig } from 'vite';
import fs from 'fs';

export default defineConfig({
  server: {
    port: 3000,
    host: true, // Expose on network
    https: {
      key: fs.readFileSync('.certs/localhost+2-key.pem'),
      cert: fs.readFileSync('.certs/localhost+2.pem'),
    },
  },
  build: {
    target: 'ES2020',
  },
});
