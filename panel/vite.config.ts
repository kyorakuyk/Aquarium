import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const panelRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: panelRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:5180',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
