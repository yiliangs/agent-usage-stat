import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const artifactRoot = resolve(root, '../dist')

// base './' so the built app runs from any local path (file-served or static host).
export default defineConfig(({ command }) => ({
  root,
  base: './',
  cacheDir: resolve(artifactRoot, 'vite-cache'),
  publicDir: command === 'serve' ? resolve(artifactRoot, 'dev-portal') : false,
  build: {
    outDir: resolve(root, '../dist/portal'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: resolve(root, 'index.html'),
    },
  },
  server: { port: 4179 },
}))
