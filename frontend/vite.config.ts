import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { Plugin } from 'vite';
import { execFileSync } from 'node:child_process';

function stationRoutes(): Plugin {
  return {
    name: 'station-routes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];

        // Redirect legacy station URLs to root
        if (url?.match(/^\/(red|blue)[1-3]$/)) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }

        // Control page: /control/<ssid> → control.html
        if (url?.startsWith('/control')) {
          req.url = '/control.html';
        }
        if (url === '/admin') {
          req.url = '/admin.html';
        }
        if (url === '/logs') {
          req.url = '/logs.html';
        }
        if (url === '/network') {
          req.url = '/network.html';
        }
        if (url === '/route') {
          req.url = '/route.html';
        }
        if (url === '/test') {
          req.url = '/test.html';
        }
        if (url === '/scores') {
          req.url = '/scores.html';
        }
        next();
      });
    },
  };
}

// https://vite.dev/config/
function gitVersion(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(gitVersion()),
  },
  plugins: [react(), stationRoutes()],
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        control: 'control.html',
        station: 'station.html',
        admin: 'admin.html',
        logs: 'logs.html',
        network: 'network.html',
        route: 'route.html',
        test: 'test.html',
        scores: 'scores.html',
      },
    },
  },
});
