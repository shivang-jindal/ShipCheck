import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_PROXY ?? 'http://localhost:4000';

export default defineConfig({
  // One .env at the repository root configures the server and the client.
  envDir: '..',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // The API sets an HTTP-only cookie, so development proxies the API
      // origin instead of calling it cross-origin.
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});