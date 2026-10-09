import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The browser only ever talks to this Vite dev server; `/api/*` is proxied to
// the example's Hono backend, which in turn proxies AgentDock. That keeps the
// AgentDock A2A endpoint off the public/CORS surface entirely.
export default defineConfig(({ mode }) => {
  const backendPort = loadEnv(mode, process.cwd(), '').PORT ?? '8787';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5273,
      proxy: {
        '/api': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
    },
  };
});
