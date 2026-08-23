import {
  applyEncoding,
  createSourceDocument,
  parseBlocks,
  parseOne,
  serialize,
  type BlockView,
  type SourceDocument,
} from '@lector/core'
import {
  detectEnv,
  pickAndRead,
  read,
  save,
  watch,
  onOpen,
  onFileChanged,
  shellAssetResolver,
} from '@lector/shell-web'
import { mountEditor, type CmHandle } from './cm.ts'
import { renderBlockHtml } from './mdastHtml.ts'
import { setAssetResolver, setCurrentMdPath } from './asset.ts'
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
const openBtn = document.getElementById('open-btn')!
const saveBtn = document.getElementById('save-btn')!
const themeBtn = document.getElementById('theme-btn')!

const blocksEl = new Map<string, HTMLElement>()
let cm: CmHandle | null = null

const liveText = new Map<string, string>()

function markDirty() {
  session.dirty = session.blocks.some((b) => b.dirty)
  dirtyDot.style.display = session.dirty ? 'block' : 'none'
}

function showToast(msg: string) {
  let toast = document.getElementById('lector-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'lector-toast'
    toast.className = 'lector-toast'
    document.body.appendChild(toast)
  }
  toast.textContent = msg
  toast.classList.add('show')
  window.setTimeout(() => toast?.classList.remove('show'), 2400)
}

function loadSession(path: string, raw: string, mtimeMs = Date.now()) {
  if (cm) {
    cm.destroy()
    cm = null
  }
  blocksEl.clear()
  liveText.clear()
  session.source = createSourceDocument(path, raw, mtimeMs)
  setCurrentMdPath(session.source.path)
  session.blocks = parseBlocks(session.source.text)
  session.originals = new Map(session.blocks.map((b) => [b.id, b.raw] as const))
  session.focusedId = null
  session.dirty = false
  fileNameEl.textContent = path.split('/').pop() ?? path
  contentEl.innerHTML = ''
  render()
  markDirty()
  if (detectEnv() === 'shell') {
    void watch(path)
  }
}

function render() {
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

function finalizeFocused() {
  if (session.focusedId === null || !cm) return
  const block = session.blocks.find((b) => b.id === session.focusedId)
  if (!block) return
  const text = cm.view.state.doc.toString()
  const original = session.originals.get(block.id) ?? block.raw
  block.raw = text
  block.dirty = text !== original
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

async function openFromShellOrDialog() {
  const picked = await pickAndRead()
  if (picked) loadSession(picked.path, picked.content, picked.mtime_ms)
}

contentEl.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('.block')
  if (!target) return
  const id = target.dataset.blockId
  if (id) focusBlock(id)
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && session.focusedId !== null) {
    e.preventDefault()
    defocus()
  }
})

openBtn.addEventListener('click', () => void openFromShellOrDialog())

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

saveBtn.addEventListener('click', async () => {
  if (!session.source) return
  finalizeFocused()
  if (cm) {
    cm.destroy()
    cm = null
  }
  const normalized = serialize(session.blocks)
  const finalText = applyEncoding(session.source, normalized)
  const res = await save(session.source.path, finalText, session.source.mtimeMs)
  if (res.conflict) {
    showToast('磁盘已发生变化，已重新加载最新内容（未覆盖）。')
    // 重新加载磁盘版本，避免覆盖外部改动
    await reloadFromDisk()
    return
  }
  session.blocks.forEach((b) => {
    session.originals.set(b.id, b.raw)
    b.dirty = false
  })
  // 更新 mtime，避免下一次保存误判冲突
  session.source.mtimeMs = Date.now()
  markDirty()
  showToast('已保存')
})

async function reloadFromDisk() {
  if (!session.source) return
  try {
    const res = await read(session.source.path)
    loadSession(res.path, res.content, res.mtime_ms)
  } catch {
    showToast('重新加载失败')
  }
}

function bindShellEvents() {
  if (detectEnv() !== 'shell') return
  // 壳把最终路径交给 web（双击 / 单实例转发）
  void onOpen(async (e) => {
    try {
      const res = await read(e.path)
      loadSession(res.path, res.content, res.mtime_ms)
    } catch {
      showToast('读取失败')
    }
  })
  // 外部变更（watch 回调）
  void onFileChanged(async (e) => {
    if (session.source && e.path === session.source.path && !session.dirty) {
      await reloadFromDisk()
    } else if (session.source && e.path === session.source.path && session.dirty) {
      showToast('磁盘文件已变化')
    }
  })
}

// 初始化：壳环境注入资源解析器 + 绑定事件
if (detectEnv() === 'shell') {
  setAssetResolver(shellAssetResolver)
}
bindShellEvents()

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
