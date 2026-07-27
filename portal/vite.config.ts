import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))

// base './' so the built app runs from any local path (file-served or static host).
export default defineConfig(({ command }) => ({
  base: './',
  publicDir: command === 'serve' ? 'public' : false,
  build: {
    outDir: '../dist/portal',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: resolve(root, 'index.html'),
    },
  },
  server: { port: 4179 },
}))
