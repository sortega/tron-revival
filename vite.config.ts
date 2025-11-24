import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // Listen on all addresses including LAN
    port: 5173,
  },
});
