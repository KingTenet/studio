import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const PAGES = ['cockpit']

// One page per build: the single-file plugin inlines one entry's whole graph, so it can't take several inputs.
const page = process.env.PAGE ?? 'cockpit'
if (!PAGES.includes(page)) throw new Error(`PAGE must be one of ${PAGES.join(', ')}`)

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  build: {
    emptyOutDir: false,
    rollupOptions: { input: path.resolve(import.meta.dirname, `${page}.html`) },
  },
})
