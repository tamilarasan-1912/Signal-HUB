import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

const serverPort = Number(process.env.PORT || 12000);

/**
 * Signal-HUB frontend build.
 *
 * The command center is a Cesium application, so the Cesium plugin supplies the
 * worker/asset plumbing. In development the API is proxied to the local
 * `server/index.mjs` process on port 12001, which is the process that owns the
 * traffic-control engine; the browser never talks to the engine directly.
 */
export default defineConfig({
  plugins: [cesium()],
  server: {
    host: '0.0.0.0',
    port: serverPort,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${Number(process.env.API_PORT || 12001)}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: serverPort,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${Number(process.env.API_PORT || 12001)}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
  },
});
