import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { Plugin } from 'vite';

function stationRoutes(): Plugin {
  return {
    name: 'station-routes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url?.match(/^\/(red|blue)[1-3]$/)) {
          req.url = '/station.html';
        }
        next();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stationRoutes()],
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
