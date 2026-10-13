import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => ({
  plugins: mode === 'portable' ? [react(), viteSingleFile({ removeViteModuleLoader: true })] : [react()],
  server: { port: 5173 },
  build: mode === 'portable' ? { outDir: '.local/portable', emptyOutDir: true } : {},
}));
