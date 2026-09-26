import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'GEOSCOPE_');
  const apiTarget = env.GEOSCOPE_API_PROXY || 'http://127.0.0.1:8000';
  return {
    base: '/',
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.js'],
      restoreMocks: true,
      clearMocks: true,
    },
  };
});
