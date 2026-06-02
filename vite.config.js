import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['qr-code-styling', 'jsqr', 'pako', 'qrcode'],
  },
  build: {
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks: {
          qrstyling: ['qr-code-styling'],
          transfer: ['jsqr', 'qrcode', 'pako'],
        },
      },
    },
  },
});
