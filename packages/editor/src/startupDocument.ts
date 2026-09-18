import { detectEnv, takePendingOpen, read } from '@lector/shell-web'
import { mediaSample, frontmatterSample, mermaidSample, sample } from './previewSamples.ts'
import type { FileController } from './fileController.ts'

export async function openStartupDocument(files: Pick<FileController, 'loadSession' | 'renderEmptyState' | 'renderLoadingState'>): Promise<void> {
  if (detectEnv() === 'shell') {
    // 冷启动时不默认走空态——壳可能有 argv 要打开文件。先进加载态，
    // 有 pending 才走 loadSession，没有 pending 才回空态。
    files.renderLoadingState()
    try {
      const pending = await takePendingOpen()
      if (pending) {
        const res = await read(pending)
        files.loadSession(res.path, res.content, res.mtime_ms)
      } else {
        files.renderEmptyState()
      }
    } catch (err) {
      console.error('[lector] pending open', err)
      files.renderEmptyState()
    }
  } else {
    // 浏览器预览（vite dev）：默认载入内置样例，方便脱离壳调版式。
    // ?doc=empty 可切回空态，检查首屏。
    const params = new URLSearchParams(location.search)
    const which = params.get('doc')
    if (which === 'empty') files.renderEmptyState()
    else if (which === 'frontmatter') files.loadSession('frontmatter.md', frontmatterSample)
    else if (which === 'media') files.loadSession('media.md', mediaSample)
    else if (which === 'mermaid') files.loadSession('mermaid.md', mermaidSample)
    // 空文档样例：`?doc=blank`。用来验证"空的 .md 仍是一份可编辑文档"
    // （空文件必须能直接打字，不能表现成"没打开文件"）。
    else if (which === 'blank') files.loadSession('blank.md', '')
    // 长文样例：`?doc=long`。专门用来验"大纲跟随阅读位置"——
    // 大纲必须比侧栏高，否则当前项永远在视野里，那条断言就白写了。
    else if (which === 'long') {
      // 全部用 `##`（**不套 H1**）：扁平大纲不会被折叠分支吃掉高度，
      // 40 条一定超过侧栏高度，"跟随滚动"才真的可验。
      const parts: string[] = []
      for (let i = 1; i <= 60; i++) {
        parts.push(`## 第 ${i} 节\n\n本节用于压测大纲跟随：往下滚，侧栏里当前那一项必须跟着进视野。\n\n`)
      }
      files.loadSession('long.md', parts.join(''))
    }
    // 大文件样例：`?doc=huge`。现场生成 5 万行（约 2MB）——不往仓库里塞大文件，
    // 同时正好压到"大文件模式"的阈值上（行数阈 4 万）。
    else if (which === 'huge') {
      const line = '- 这是一行用于压测的正文内容，重复出现以撑大文件体积。\n'
      files.loadSession('huge.md', '# 大文件压测\n\n' + line.repeat(50_000))
    }
    else files.loadSession(which || 'sample.md', sample)
  }
}
