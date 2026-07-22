import fs from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local HTTPS via mkcert (see docs/https-local-dev.md). Only enabled when
// both files actually exist — e.g. not on a fresh clone before mkcert has
// run, or anywhere the certs/ volume isn't mounted — so this always falls
// back to plain HTTP rather than crashing the dev server on startup.
const CERT_PATH = process.env.SSL_CERT_PATH || '/certs/shelfqueue.test.pem';
const KEY_PATH = process.env.SSL_KEY_PATH || '/certs/shelfqueue.test-key.pem';
const httpsAvailable = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 0.0.0.0 so the Docker container's mapped port is reachable from the host.
    host: true,
    // Vite's dev server checks the Host header against this list as a
    // DNS-rebinding protection and 403s anything else — 'localhost' is
    // allowed implicitly, but a custom pentest-environment hostname (e.g.
    // for reaching this from a separate Kali VM) needs to be added
    // explicitly or every request gets blocked before it reaches React.
    allowedHosts: ['localhost', 'shelfqueue.test'],
    https: httpsAvailable
      ? { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) }
      : undefined,
  },
});
