import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `npm run dev` starts the core with this fixed token. Never used in builds.
      '/api': { target: 'http://127.0.0.1:8898', changeOrigin: true, headers: { 'x-proxy-app-token': 'dev-token' } },
    },
  },
});
