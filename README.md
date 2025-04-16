# Practice Field Configurator

A web interface for configuring practice field access points.

## Setup

1. Install dependencies for both backend and frontend:

```bash
npm install
```

## Development

You'll need two terminal windows to run the development servers:

1. Start the backend API server:

```bash
npm run dev
```

2. In another terminal, start the frontend development server:

```bash
npm run dev -w frontend
```

The frontend will be available at http://localhost:5173.

The backend will be available at http://localhost:3000, however it is also proxied by the frontend dev server so no configuration should be necessary.

## Project Structure

- `src/` - Backend TypeScript files
- `frontend/` - React frontend application
- `dist/` - Compiled backend JavaScript files (generated after build)
- `tsconfig.json` - TypeScript configuration
- `package.json` - Project dependencies and scripts

## Deployment

To deploy this in a production environment:

1. Run `npm run build`

- Backend will be compiled to JavaScript and placed in the `dist/` folder
- Frontend will be built and placed in the `frontend/dist/` folder

2. Run `npm start`

- This will start the backend server using the compiled JavaScript files in `dist/`
- Alternative, you can run `node dist` directly to start the backend server, or copy the `dist/` folder to a different location and run it from there.

3. Configure Webserver to server static files and proxy to backend for websocket connections

- Alternatively, you can copy the `dist/` folder to a different location and serve it from there.

### Update Script

An update script is provided to update the backend and frontend dependencies. To run it, execute:

```bash
./update.sh
```

### Systemd Service

```service
[Unit]
Description=Practice Field Configurator Backend
After=network.target

[Service]
User=www-data
WorkingDirectory=/path/to/practice-field-configurator
ExecStart=/usr/bin/node dist
Restart=on-failure
Environment=WEBSOCKET_PORT=9001

[Install]
WantedBy=multi-user.target
```

### Caddy Example Config

```Caddyfile
practice.example.com {
    @stations {
        path_regexp ^/(red|blue)[123]$
    }

    reverse_proxy /ws localhost:9002

    # Prevent direct access to html files
    rewrite /index.html /non-existent-path
    rewrite /station.html /non-existent-path

    rewrite @stations /station.html
    root /path/to/frontend/dist
    file_server
}
```

### Nginx Example Config

```conf
server {
    listen 80;
    server_name practice.example.com;
    root /path/to/frontend/dist;

    location ~^/(red|blue)[123]$ {
        rewrite ^ /station.html break;
    }

    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```
