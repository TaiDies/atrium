import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const apiTarget = process.env.API_TARGET ?? 'http://localhost:3100';

/**
 * Serves the whiteboard's fonts from this app (at /excalidraw-assets/) instead of a public CDN, so
 * whiteboards work on a server without internet access. index.html points Excalidraw at this path.
 */
function excalidrawAssets(): Plugin {
  const source = path.resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts');
  return {
    name: 'excalidraw-assets',
    configureServer(server) {
      server.middlewares.use('/excalidraw-assets/fonts', (req, res, next) => {
        const file = path.join(source, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!file.startsWith(source) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      cpSync(source, path.join(options.dir ?? 'dist', 'excalidraw-assets', 'fonts'), { recursive: true });
    },
  };
}

/**
 * PDF.js's image decoders (JPEG 2000 and JBIG2, used by many scanned PDFs), character maps, standard
 * fonts and colour profiles, served at /pdfjs/. Without them those pages draw blank.
 */
function pdfjsAssets(): Plugin {
  const root = path.resolve('node_modules/pdfjs-dist');
  const dirs = ['wasm', 'cmaps', 'standard_fonts', 'iccs'];
  const types: Record<string, string> = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.icc': 'application/vnd.iccprofile' };
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const file = path.join(root, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!dirs.some((d) => file.startsWith(path.join(root, d))) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      for (const d of dirs) cpSync(path.join(root, d), path.join(options.dir ?? 'dist', 'pdfjs', d), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawAssets(), pdfjsAssets()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/collab': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
      '/live': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
      // The admin panel's API (the dev server's ADMIN_PORT); open /admin.html in development.
      '/admin-api': process.env.ADMIN_API ?? 'http://localhost:3101',
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
    // Two pages: the app, and the admin panel (served only on the admin port).
    rollupOptions: { input: { main: 'index.html', admin: 'admin.html' } },
  },
});
