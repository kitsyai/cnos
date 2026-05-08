import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.CNOS_UI_API_TARGET ?? 'http://127.0.0.1:4311';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': apiTarget,
    },
  },
});
