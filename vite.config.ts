import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => ({
  plugins: mode === 'portable' ? [react(), viteSingleFile({ removeViteModuleLoader: true })] : [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
    watch: { ignored: ['**/.local/**', '**/android/**', '**/server/**'] },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**', '**/android/**', '**/server/**'] },
  },
  build: mode === 'portable' ? { outDir: '.local/portable', emptyOutDir: true } : {},
}));
