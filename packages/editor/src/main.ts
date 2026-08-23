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
  onMenu,
  shellAssetResolver,
} from '@lector/shell-web'
import { mountEditor, type CmHandle } from './cm.ts'
import type { EditorView } from '@codemirror/view'
import { renderBlockHtml } from './mdastHtml.ts'
import { setAssetResolver, setCurrentMdPath } from './asset.ts'
import { initSettings, toggleTheme, getSettings } from './settings.ts'
import { openSettingsModal } from './settingsModal.ts'
import { findBar, escapeRegExp } from './findBar.ts'
import { iconSvg } from './icons.ts'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/source-serif-4'
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
const settingsBtn = document.getElementById('settings-btn')!
const outlineBtn = document.getElementById('outline-btn')!
const findBtn = document.getElementById('find-btn')!

// 图标（SVG，替换 emoji）
setIcon('open-glyph', 'folder')
setIcon('save-glyph', 'save')
outlineBtn.innerHTML = iconSvg('outline')
findBtn.innerHTML = iconSvg('search')
settingsBtn.innerHTML = iconSvg('settings')
function setIcon(id: string, name: string) {
  document.getElementById(id)!.innerHTML = iconSvg(name)
}
function refreshThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  themeBtn.innerHTML = iconSvg(dark ? 'sun' : 'moon')
}
refreshThemeIcon()
const themeObserver = new MutationObserver(() => refreshThemeIcon())
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

const outlinePanel = document.createElement('aside')
outlinePanel.className = 'outline-panel'
outlinePanel.setAttribute('aria-label', '大纲')
outlinePanel.hidden = true
document.body.appendChild(outlinePanel)
let outlineOpen = false

/** 从块内 mdast 提取纯文本（标题用）。 */
function headingText(mdast: unknown): string {
  const walk = (n: unknown): string => {
    if (!n || typeof n !== 'object') return ''
    const node = n as { type?: string; value?: string; children?: unknown[] }
    if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
    return (node.children ?? []).map(walk).join('')
  }
  return walk(mdast)
}

function renderOutline() {
  const headings = session.blocks
    .filter((b) => b.kind === 'heading')
    .map((b) => {
      const d = b.mdast as { depth?: number } | null
      return { id: b.id, depth: d?.depth ?? 1, text: headingText(b.mdast) || b.raw.trim() }
    })
  outlinePanel.innerHTML = ''
  const list = document.createElement('div')
  list.className = 'outline-list'
  for (const h of headings) {
    const row = document.createElement('button')
    row.className = 'outline-row'
    row.dataset.depth = String(h.depth)
    row.textContent = h.text
    row.addEventListener('click', () => {
      const el = blocksEl.get(h.id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    list.appendChild(row)
  }
  const empty = headings.length === 0
  if (empty) {
    const p = document.createElement('p')
    p.className = 'outline-empty'
    p.textContent = '暂无标题'
    outlinePanel.appendChild(p)
  }
  outlinePanel.appendChild(list)
}

function toggleOutline() {
  outlineOpen = !outlineOpen
  outlinePanel.hidden = !outlineOpen
  if (outlineOpen) renderOutline()
}

const blocksEl = new Map<string, HTMLElement>()
let cm: CmHandle | null = null

const liveText = new Map<string, string>()
let seq = 0
function nextId(): string {
  seq += 1
  return `e${seq}`
}

function markDirty() {
  session.dirty = session.blocks.some((b) => b.dirty)
  dirtyDot.style.display = session.dirty ? 'block' : 'none'
}

/** 聚焦段末回车 → 分裂成两段（前段 + 空段）。返回 true 表示已处理。 */
function splitBlock(block: BlockView, view: EditorView): boolean {
  const doc = view.state.doc.toString()
  const pos = view.state.selection.main.head
  if (block.kind !== 'paragraph' && block.kind !== 'heading') return false
  if (pos !== doc.length) return false // 只在块末分裂，规避光标映射复杂度
  const i = session.blocks.findIndex((b) => b.id === block.id)
  if (i < 0) return false
  // 其后应是空白缝（段落间必有）
  const gap = session.blocks[i + 1]
  if (!gap || gap.kind !== 'unknown' || gap.raw.trim() !== '') return false
  const gapRaw = gap.raw || '\n\n'
  const emptyPara: BlockView = {
    id: nextId(),
    kind: 'paragraph',
    start: gap.start,
    end: gap.start,
    raw: '',
    mdast: parseOne(''),
    dirty: true,
  }
  const extraGap: BlockView = {
    id: nextId(),
    kind: 'unknown',
    start: gap.start,
    end: gap.start,
    raw: gapRaw,
    mdast: null,
    dirty: true,
  }
  session.blocks.splice(i + 2, 0, emptyPara, extraGap)
  session.originals.set(emptyPara.id, emptyPara.raw)
  session.originals.set(extraGap.id, extraGap.raw)
  session.focusedId = emptyPara.id
  markDirty()
  render()
  return true
}

/** 空段块首 Backspace → 删除该空段并上移，与上一内容块合并。 */
function mergeBlock(block: BlockView, view: EditorView): boolean {
  const doc = view.state.doc.toString()
  if (doc.trim() !== '') return false
  if (view.state.selection.main.head !== 0) return false
  const i = session.blocks.findIndex((b) => b.id === block.id)
  if (i < 0) return false
  // 删除该空段与其前的空白缝
  const remove: number[] = []
  let prevContent: BlockView | null = null
  for (let k = i - 1; k >= 0; k--) {
    const b = session.blocks[k]!
    if (b.kind === 'unknown') {
      remove.push(k)
    } else {
      prevContent = b
      break
    }
  }
  remove.push(i)
  for (const k of remove.sort((a, b) => b - a)) {
    session.blocks.splice(k, 1)
  }
  if (prevContent) {
    session.focusedId = prevContent.id
  } else {
    session.focusedId = null
  }
  markDirty()
  render()
  return true
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
    const config = {
      autoCharacterPairs: getSettings().autoCharacterPairs,
      showWhitespace: getSettings().showWhitespace,
      structuralKeymap: {
        Enter: (view: EditorView) => splitBlock(block, view),
        Backspace: (view: EditorView) => mergeBlock(block, view),
      },
    }
    cm = mountEditor(host, block.raw, (text) => liveText.set(block.id, text), config)
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
  try {
    const picked = await pickAndRead()
    if (picked) loadSession(picked.path, picked.content, picked.mtime_ms)
  } catch (err) {
    console.error('[lector] open failed', err)
    showToast(`打开失败：${String(err)}`)
  }
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

themeBtn.addEventListener('click', () => toggleTheme())
settingsBtn.addEventListener('click', () => openSettingsModal())
outlineBtn.addEventListener('click', () => toggleOutline())

function openFind() {
  if (document.querySelector('.find-bar')) {
    document.querySelector<HTMLInputElement>('.find-input')?.focus()
    return
  }
  findBar({
    getBlocks: () => session.blocks,
    replaceInBlock: (id, from, to) => {
      const b = session.blocks.find((x) => x.id === id)
      if (!b) return
      const re = new RegExp(escapeRegExp(from), 'gi')
      b.raw = b.raw.replace(re, () => to)
      b.dirty = true
      b.mdast = parseOne(b.raw)
      markDirty()
      render()
    },
    scrollTo: (id) => blocksEl.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
  })
}

findBtn.addEventListener('click', () => openFind())
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault()
    openFind()
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
  // 原生菜单
  void onMenu((action) => {
    switch (action) {
      case 'open':
        void openFromShellOrDialog()
        break
      case 'save':
        saveBtn.click()
        break
      case 'find':
        openFind()
        break
      case 'theme':
        toggleTheme()
        break
      case 'outline':
        toggleOutline()
        break
    }
  })
}

// 初始化：壳环境注入资源解析器 + 绑定事件
if (detectEnv() === 'shell') {
  setAssetResolver(shellAssetResolver)
}
bindShellEvents()

// 关闭脏文档前的浏览器级守卫（原生窗口关闭确认属壳侧后续项）
window.addEventListener('beforeunload', (e) => {
  if (getSettings().closeAlwaysConfirmsChanges && session.dirty && session.source) {
    e.preventDefault()
    e.returnValue = ''
  }
})

function renderEmptyState() {
  contentEl.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'empty-state'
  const icon = document.createElement('div')
  icon.className = 'empty-icon'
  icon.innerHTML = iconSvg('book', 24)
  const title = document.createElement('h2')
  title.textContent = 'Lector'
  const p = document.createElement('p')
  p.textContent = '打开一个 Markdown 文件开始阅读。'
  const btn = document.createElement('button')
  btn.className = 'btn btn-primary'
  btn.innerHTML = `${iconSvg('folder', 16)} 打开文件`
  btn.addEventListener('click', () => void openFromShellOrDialog())
  wrap.append(icon, title, p, btn)
  contentEl.appendChild(wrap)
  fileNameEl.textContent = ''
  blocksEl.clear()
  markDirty()
}

const sample = `# 阅读体验展示

> Lector —— 阅读优先的纯 Markdown 编辑器。未聚焦块以预览显示，点击任意块进入源码编辑。

## 中西文混排与行内

在 AI 时代，**读** 远大于 **写**。Markdown 是 AI 内容的事实格式，\`inline code\` 里可以放 \`const a = 1\`，链接请看 [CommonMark](https://commonmark.org)，编号 2026 与指标 1.618 也要排得顺眼。中文段落里混排 Latin 与数字，应当平滑而不突兀。

## 任务列表

- [ ] 未完成任务，后面还有一段未勾选
- [x] 已完成的任务，会显示为勾选态
- [x] 支持多行任务项，当文本足够长而换行时，续行应当对齐在复选框之后而不是回到 bullet 起点缩进。

## 一个表格

| 引擎 | 语言 | 体积 | 定位 |
| --- | --- | --- | --- |
| CodeMirror 6 | TS | ~4MB | 焦点块源码编辑 |
| ProseMirror | TS | 重 | 被排除（保真原罪） |
| Vditor | JS | 重 | 被排除（内核绑定） |

## 代码块

\`\`\`ts
export function parseBlocks(text: string): BlockView[] {
  const tree = fromMarkdown(text, { extensions, mdastExtensions })
  return sliceSeamless(tree, text)
}
\`\`\`

---
第二段，用于测试「只改这一块」的切片保真。
`

void (async () => {
  await initSettings()
  if (detectEnv() === 'shell') {
    if (/Mac/i.test(navigator.platform)) {
      document.documentElement.setAttribute('data-shell', 'macos')
    }
    renderEmptyState()
  } else {
    loadSession('sample.md', sample)
  }
})()
