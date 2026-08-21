import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const artifactRoot = resolve(root, '../dist')

/**
 * Carry the font licence into the build.
 *
 * The packaged application takes only `dist/`, so a licence left in the source
 * tree never reaches the machine that receives the fonts. The Open Font License
 * asks for the notice to travel with the files, so it is emitted beside them.
 */
function fontLicense() {
  return {
    name: 'font-license',
    apply: 'build' as const,
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'fonts/OFL.txt',
        source: readFileSync(resolve(root, 'fonts/OFL.txt'), 'utf8'),
      })
    },
  }
}

// base './' so the built app runs from any local path (file-served or static host).
export default defineConfig(({ command }) => ({
  root,
  base: './',
  cacheDir: resolve(artifactRoot, 'vite-cache'),
  publicDir: command === 'serve' ? resolve(artifactRoot, 'dev-portal') : false,
  plugins: [fontLicense()],
  build: {
    outDir: resolve(root, '../dist/portal'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: resolve(root, 'index.html'),
      output: {
        // Fonts keep their own names under fonts/. The first-run window is a
        // data: URL document that cannot resolve a relative path, so it reads
        // these files off disk and inlines them; a hashed name would leave it
        // nothing to look for.
        assetFileNames: (asset) =>
          asset.names?.some((name) => name.endsWith('.woff2'))
            ? 'fonts/[name][extname]'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 4179 },
}))
