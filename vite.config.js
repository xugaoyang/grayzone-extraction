import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs work on GitHub Pages project paths and local servers.
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.replaceAll('\\', '/').includes('/node_modules/three/')) return 'three';
        },
      },
    },
  },
});
