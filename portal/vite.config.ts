import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = dirname(fileURLToPath(import.meta.url))

// base './' so the built app runs from any local path (file-served or static host).
export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react()],
  publicDir: command === 'serve' ? 'public' : false,
  build: {
    outDir: '../dist/portal',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        portal: resolve(root, 'index.html'),
        styleStudy: resolve(root, 'style-study.html'),
      },
    },
  },
  server: { port: 4179 },
}))
