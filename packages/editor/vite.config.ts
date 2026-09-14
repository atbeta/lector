import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// 编辑器可 vite 单独打开。@lector/core 指向源码 TS，走 workspace 别名。
export default defineConfig({
  resolve: {
    alias: {
      '@lector/core': resolve(import.meta.dirname, '../core/src/index.ts'),
      '@lector/shell-web': resolve(import.meta.dirname, '../shell-web/src/platform.ts'),
    },
  },
  server: {
    port: 5173,
    // 端口被别家项目占住时直接报错，而不是静默改到 5174——
    // devUrl 写死 5173，一旦 vite 悄悄换口，Tauri 会连通 5173 上那个冒牌前端
    //（真实发生过：5173 被另一个本地工程的 dev server 占用，Lector 窗口里装进了别人家的 app）。
    strictPort: true,
  },
})
