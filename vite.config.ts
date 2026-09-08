import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages publishes this project beneath the repository name.
  base: '/weca-collision-map/',
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 4173,
  },
  build: {
    target: 'es2022',
  },
});
