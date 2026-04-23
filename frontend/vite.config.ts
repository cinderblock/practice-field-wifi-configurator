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

        // Legacy /control/<ssid> → redirect to /<ssid>
        if (url?.startsWith('/control/')) {
          const ssid = url.slice('/control/'.length);
          res.writeHead(302, { Location: `/${ssid}` });
          res.end();
          return;
        }

        // Team control page: /<teamNumber> or /<teamNumber-suffix> → control.html
        if (url?.match(/^\/\d/)) {
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
        if (url === '/match') {
          req.url = '/match.html';
        }
        if (url === '/scores') {
          req.url = '/scores.html';
        }
        if (url === '/overview') {
          req.url = '/overview.html';
        }
        if (url === '/support') {
          // Redirect old /support URL to home — support is now a widget on every page
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }

        // Fallback: serve 404 page for unrecognized paths (skip assets/files with extensions)
        if (url && !url.includes('.') && url !== '/') {
          req.url = '/404.html';
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
      '/api/team-avatar': {
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
        match: 'match.html',
        overview: 'overview.html',
        notfound: '404.html',
      },
    },
  },
});
