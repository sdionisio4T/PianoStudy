/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

// Config minima: index.html en la raiz ya es el entry point de Vite.
// Los scripts CDN (supabase-js global, essentia.js, basic-pitch, YouTube
// iframe API) quedan como <script src="https://..."> normales en index.html
// y Vite los deja pasar sin tocarlos (no son parte del grafo de modulos ES).
export default defineConfig({
    build: {
        outDir: 'dist',
        // Cache-busting automatico: Vite hashea los nombres de archivo de
        // salida (app.[hash].js, styles.[hash].css) en cada build.
        assetsDir: 'assets-build'
    },
    server: {
        port: 5173
    },
    preview: {
        port: 4173
    },
    test: {
        environment: 'node',
        setupFiles: ['./tests/setup.js'],
        include: ['tests/**/*.test.js']
    }
});
