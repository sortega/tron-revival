import { defineConfig } from 'vitest/config';
import fs from 'fs';

// Local HTTPS (needed to test on phones over LAN) is used only when mkcert
// certificates are present; builds and CI work without them.
const keyPath = '.certs/localhost+2-key.pem';
const certPath = '.certs/localhost+2.pem';
const https = fs.existsSync(keyPath) && fs.existsSync(certPath)
  ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
  : undefined;

export default defineConfig({
  base: '/tron-revival/',
  server: {
    port: 3000,
    host: true, // Expose on network
    https,
  },
  build: {
    target: 'es2020',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
