import {
  applyEncoding,
  createSourceDocument,
  parseBlocks,
  parseOne,
  serialize,
  type BlockView,
  type SourceDocument,
} from '@lector/core'
import { mountEditor, type CmHandle } from './cm.ts'
import { renderBlockHtml } from './mdastHtml.ts'
import { setCurrentMdPath } from './asset.ts'
import './styles/app.css'

interface Session {
  source: SourceDocument | null
  blocks: BlockView[]
  focusedId: string | null
  dirty: boolean
  /** 解析时的原始 raw，用于判定 dirty（还原到原文即不算脏）。 */
  originals: Map<string, string>
}

const session: Session = {
  source: null,
  blocks: [],
  focusedId: null,
  dirty: false,
  originals: new Map(),
}

const contentEl = document.getElementById('content')!
const dirtyDot = document.getElementById('dirty-dot')!
const fileNameEl = document.getElementById('file-name')!
const fileInput = document.getElementById('file-input') as HTMLInputElement
const openBtn = document.getElementById('open-btn')!
const saveBtn = document.getElementById('save-btn')!
const themeBtn = document.getElementById('theme-btn')!

const blocksEl = new Map<string, HTMLElement>()
let cm: CmHandle | null = null

/** 记录聚焦块在 CM 内的实时文本（finalize 时读取）。 */
const liveText = new Map<string, string>()

function markDirty() {
  session.dirty = session.blocks.some((b) => b.dirty)
  dirtyDot.style.display = session.dirty ? 'block' : 'none'
}

function loadSession(path: string, raw: string) {
  if (cm) {
    cm.destroy()
    cm = null
  }
  blocksEl.clear()
  liveText.clear()
  session.source = createSourceDocument(path, raw, Date.now())
  setCurrentMdPath(session.source.path)
  session.blocks = parseBlocks(session.source.text)
  session.originals = new Map(session.blocks.map((b) => [b.id, b.raw] as const))
  session.focusedId = null
  session.dirty = false
  fileNameEl.textContent = path.split('/').pop() ?? path
  contentEl.innerHTML = ''
  render()
  markDirty()
}

function render() {
  // 若 CM 聚焦，finalize 前先取出文本进 liveText
  for (const block of session.blocks) {
    let el = blocksEl.get(block.id)
    if (!el) {
      el = createBlockEl(block)
      blocksEl.set(block.id, el)
      contentEl.appendChild(el)
    }
    renderBlockContent(el, block)
  }
}

function createBlockEl(block: BlockView): HTMLElement {
  const el = document.createElement('div')
  el.className = 'block'
  el.dataset.blockId = block.id
  return el
}

function renderBlockContent(el: HTMLElement, block: BlockView) {
  el.classList.toggle('focused', block.id === session.focusedId)
  const focus = block.id === session.focusedId

  // 清理旧的 CM/preview 子节点
  el.textContent = ''
  if (focus) {
    const host = document.createElement('div')
    host.className = 'cm-host'
    el.appendChild(host)
    cm = mountEditor(host, block.raw, (text) => liveText.set(block.id, text))
  } else {
    const preview = document.createElement('div')
    preview.className = 'preview reading-prose'
    preview.innerHTML = renderBlockHtml(block.mdast, block.raw)
    el.appendChild(preview)
  }
}

/** 失焦当前块：把 CM 文本写回 raw，标 dirty。 */
function finalizeFocused() {
  if (session.focusedId === null || !cm) return
  const block = session.blocks.find((b) => b.id === session.focusedId)
  if (!block) return
  const text = cm.view.state.doc.toString()
  const original = session.originals.get(block.id) ?? block.raw
  block.raw = text
  block.dirty = text !== original
  // 脏块重新解析，重建预览 mdast
  block.mdast = block.dirty ? parseOne(text) : block.mdast
  markDirty()
}

function focusBlock(id: string) {
  if (session.focusedId === id) return
  finalizeFocused()
  if (cm) {
    cm.destroy()
    cm = null
  }
  session.focusedId = id
  render()
}

function defocus() {
  finalizeFocused()
  if (cm) {
    cm.destroy()
    cm = null
  }
  session.focusedId = null
  render()
}

contentEl.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('.block')
  if (!target) return
  const id = target.dataset.blockId
  if (id) focusBlock(id)
})

// Enter 在空段落末尾：分裂块（结构变化，占位实现：先失焦）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && session.focusedId !== null) {
    e.preventDefault()
    defocus()
  }
})

openBtn.addEventListener('click', () => fileInput.click())

themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') ?? 'light'
  const next = cur === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  try {
    localStorage.setItem('lector-theme', next)
  } catch {
    /* 忽略持久化失败 */
  }
})
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (!file) return
  void file.text().then((raw) => {
    loadSession(file.name, raw)
  })
})

saveBtn.addEventListener('click', () => {
  if (!session.source) return
  finalizeFocused()
  if (cm) {
    cm.destroy()
    cm = null
  }
  const blocks = session.blocks
  const normalized = serialize(blocks)
  const finalText = applyEncoding(session.source, normalized)

  const blob = new Blob([finalText], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = session.source.path.split('/').pop() ?? 'untitled.md'
  a.click()
  URL.revokeObjectURL(url)
  // 保存后视为干净
  session.blocks.forEach((b) => {
    session.originals.set(b.id, b.raw)
    b.dirty = false
  })
  markDirty()
})

// 首次加载一个示例，便于直开即见。
const sample = `# 欢迎使用 Lector

> 阅读优先的纯 Markdown 编辑器。未聚焦块以预览显示，点击任意块进入源码编辑。

## 试试这些

- 点击下方段落，原地编辑 Markdown 源码
- 按 Esc 或点击别处失焦并标脏
- 顶部「保存」写回并标记为干净

相对图片预览：![示例图](images/sample.png)

第二段，用于测试「只改这一块」的切片保真。
`
loadSession('sample.md', sample)
