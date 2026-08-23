import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// 编辑器可 vite 单独打开。@lector/core 指向源码 TS，走 workspace 别名。
export default defineConfig({
  resolve: {
    alias: {
      '@lector/core': resolve(import.meta.dirname, '../core/src/index.ts'),
    },
  },
  server: {
    port: 5173,
  },
})
