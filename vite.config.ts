import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
) as {version: string};

export default defineConfig(({mode}) => {
  loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      // Surfaced in the in-app debug panel. These are build-time constants,
      // not secrets.
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    // NOTE: `define: { 'process.env.GEMINI_API_KEY': ... }` was removed.
    // It inlined the raw API key as a string literal into the client bundle,
    // which ships inside the APK — anyone can unzip it and read the key.
    // Nothing in src/ actually referenced GEMINI_API_KEY, so this was pure
    // credential exposure with no benefit. If a model API is added later,
    // proxy it through a backend rather than embedding the key in the app.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify\u2014file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
