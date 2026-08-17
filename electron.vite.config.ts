import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// electron-vite ships unminified by default; there is no reason to parse
// half a megabyte of pretty-printed React in every window of a packaged app.
const minify = { minify: 'esbuild' as const }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: minify
  },
  preload: {
    // autoconsent must ride inside the bundle: the tab preload is sandboxed,
    // and a sandboxed preload cannot require() node_modules at runtime
    plugins: [externalizeDepsPlugin({ exclude: ['@duckduckgo/autoconsent'] })],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      ...minify,
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          internal: resolve('src/preload/internal.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      ...minify,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          start: resolve('src/renderer/start.html'),
          settings: resolve('src/renderer/settings.html'),
          welcome: resolve('src/renderer/welcome.html'),
          error: resolve('src/renderer/error.html')
        }
      }
    }
  }
})
