import {
  applyEncoding,
  createSourceDocument,
  adjacentFocusableId,
  isFocusableBlock,
  isWhitespaceGap,
  kindFromMdast,
  parseBlocks,
  parseBlockRoots,
  parseOne,
  serialize,
  type BlockKind,
  type BlockView,
  type SourceDocument,
} from '@lector/core'
import {
  bindTitlebar,
  detectEnv,
  pickAndRead,
  pickSavePath,
  read,
  save,
  watch,
  takePendingOpen,
  bindDocument,
  saveImage,
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
import { t } from './i18n.ts'
import { chooseConflict, confirmDiscard } from './dialog.ts'
import { applyKeyedChildren } from './reconcile.ts'
import { sessionIsDirty } from './sessionDirty.ts'
import {
  fileToBase64,
  imageMarkdown,
  isImageMime,
  pastedFileName,
  safeDropName,
} from './imageInsert.ts'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/source-serif-4'
import './styles/app.css'

interface Session {
  source: SourceDocument | null
  blocks: BlockView[]
  focusedId: string | null
  dirty: boolean
  /** 插入/删除块后，即使各块 raw 未改也算脏。 */
  structuralDirty: boolean
  /** 解析时的原始 raw，用于判定 dirty（还原到原文即不算脏）。 */
  originals: Map<string, string>
}

const session: Session = {
  source: null,
  blocks: [],
  focusedId: null,
  dirty: false,
  structuralDirty: false,
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

openBtn.innerHTML = iconSvg('folder', 16)
openBtn.setAttribute('aria-label', t('openAria'))
openBtn.title = t('openAria')
saveBtn.innerHTML = iconSvg('save', 16)
saveBtn.setAttribute('aria-label', t('saveAria'))
saveBtn.title = t('saveAria')
outlineBtn.innerHTML = iconSvg('outline', 16)
outlineBtn.setAttribute('aria-label', t('outlineAria'))
outlineBtn.title = t('outlineAria')
findBtn.innerHTML = iconSvg('search', 16)
findBtn.setAttribute('aria-label', t('findAria'))
findBtn.title = t('findAria')
themeBtn.setAttribute('aria-label', t('themeAria'))
themeBtn.title = t('themeAria')
settingsBtn.innerHTML = iconSvg('settings', 16)
settingsBtn.setAttribute('aria-label', t('settingsAria'))
settingsBtn.title = t('settingsAria')
dirtyDot.title = t('dirtyTitle')
const titlebarDrag = document.querySelector<HTMLElement>('.titlebar-drag')
if (titlebarDrag) bindTitlebar(titlebarDrag)

function refreshThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  themeBtn.innerHTML = iconSvg(dark ? 'sun' : 'moon', 16)
}
refreshThemeIcon()
const themeObserver = new MutationObserver(() => refreshThemeIcon())
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

const outlinePanel = document.createElement('aside')
outlinePanel.className = 'outline-panel'
outlinePanel.setAttribute('aria-label', t('outlineLabel'))
outlinePanel.hidden = true
document.body.appendChild(outlinePanel)
let outlineOpen = false

/** 从块内 mdast 提取纯文本（标题用）。 */
function headingText(mdast: unknown): string {
  if (Array.isArray(mdast)) return mdast.map(headingText).join(' ')
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
      return { id: b.id, depth: headingDepth(b) ?? 1, text: headingText(b.mdast) || b.raw.trim() }
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
    p.textContent = t('outlineEmpty')
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
  session.dirty = sessionIsDirty(session.blocks, session.structuralDirty)
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
  session.structuralDirty = true
  session.focusedId = emptyPara.id
  if (cm) {
    cm.destroy()
    cm = null
  }
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
  session.structuralDirty = true
  if (prevContent) {
    caretIntent = { mode: 'end' }
    session.focusedId = prevContent.id
  } else {
    session.focusedId = null
  }
  if (cm) {
    cm.destroy()
    cm = null
  }
  markDirty()
  render()
  caretIntent = null
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
  session.structuralDirty = false
  fileNameEl.textContent = path.split('/').pop() ?? path
  fileNameEl.dataset.untitled = 'false'
  contentEl.innerHTML = ''
  render()
  markDirty()
  if (detectEnv() === 'shell') {
    void bindDocument(path)
    void watch(path)
  }
}

function render() {
  const desired: HTMLElement[] = []
  const seen = new Set<string>()
  for (const block of session.blocks) {
    seen.add(block.id)
    let el = blocksEl.get(block.id)
    if (!el) {
      el = createBlockEl(block)
      blocksEl.set(block.id, el)
    }
    desired.push(el)
  }
  for (const [id, el] of blocksEl) {
    if (!seen.has(id)) {
      el.remove()
      blocksEl.delete(id)
    }
  }
  applyKeyedChildren(contentEl, desired)
  for (const block of session.blocks) {
    const el = blocksEl.get(block.id)
    if (el) renderBlockContent(el, block)
  }
}

function headingDepth(block: BlockView): number | null {
  if (block.kind !== 'heading') return null
  const node = Array.isArray(block.mdast) ? block.mdast[0] : block.mdast
  const d = (node as { depth?: number } | null)?.depth
  return d == null ? 1 : d
}

function applyBlockMeta(el: HTMLElement, block: BlockView) {
  el.dataset.kind = block.kind
  const depth = headingDepth(block)
  if (depth != null) el.dataset.depth = String(depth)
  else delete el.dataset.depth
}

function createBlockEl(block: BlockView): HTMLElement {
  const el = document.createElement('div')
  el.className = 'block'
  el.dataset.blockId = block.id
  applyBlockMeta(el, block)
  if (isWhitespaceGap(block)) el.classList.add('gap')
  return el
}

/** 点击或方向键跨块后，光标要落到哪里。 */
type CaretIntent =
  | { mode: 'coords'; x: number; y: number }
  | { mode: 'start'; x?: number }
  | { mode: 'end'; x?: number }

let caretIntent: CaretIntent | null = null

function placeCaret(view: EditorView, intent: CaretIntent) {
  const doc = view.state.doc
  let pos: number | null = null
  if (intent.mode === 'coords') {
    pos = view.posAtCoords({ x: intent.x, y: intent.y })
  } else if (intent.mode === 'start') {
    if (intent.x == null) pos = 0
    else {
      const line = doc.line(1)
      const c = view.coordsAtPos(line.from)
      pos = c ? view.posAtCoords({ x: intent.x, y: c.top + 1 }) : 0
    }
  } else if (intent.x == null) {
    pos = doc.length
  } else {
    const line = doc.line(doc.lines)
    const c = view.coordsAtPos(line.to)
    pos = c ? view.posAtCoords({ x: intent.x, y: c.top + 1 }) : doc.length
  }
  if (pos == null) pos = intent.mode === 'end' ? doc.length : 0
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
}

function caretX(view: EditorView): number | undefined {
  return view.coordsAtPos(view.state.selection.main.head)?.left
}

function atVisualVerticalEdge(view: EditorView, down: boolean): boolean {
  if (view.composing) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const moved = view.moveVertically(sel, down)
  if (moved.head === sel.head) return true
  // 单行块上 moveVertically 常把光标挪到行尾，head 变了但还在同一视觉行
  const a = view.coordsAtPos(sel.head)
  const b = view.coordsAtPos(moved.head)
  if (!a || !b) return true
  return a.top < b.bottom && b.top < a.bottom
}

function atHorizontalEdge(view: EditorView, right: boolean): boolean {
  if (view.composing) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  return right ? sel.head === view.state.doc.length : sel.head === 0
}

/** 方向键顶到块边界 → 跳到相邻可聚焦块，并接上光标列。 */
function moveAcrossBlocks(
  block: BlockView,
  view: EditorView,
  dir: 'up' | 'down' | 'left' | 'right',
): boolean {
  const vertical = dir === 'up' || dir === 'down'
  const forward = dir === 'down' || dir === 'right'
  if (vertical ? !atVisualVerticalEdge(view, forward) : !atHorizontalEdge(view, forward)) {
    return false
  }
  const nextId = adjacentFocusableId(session.blocks, block.id, forward ? 1 : -1)
  if (!nextId) return false
  const x = vertical ? caretX(view) : undefined
  const intent: CaretIntent = forward
    ? x == null ? { mode: 'start' } : { mode: 'start', x }
    : x == null ? { mode: 'end' } : { mode: 'end', x }
  // 必须等当前 keydown 结束再切块，否则新 CM 会吃到同一记方向键，单行块会被连跳两次。
  window.setTimeout(() => {
    focusBlock(nextId, intent)
    blocksEl.get(nextId)?.scrollIntoView({ block: 'nearest' })
  }, 0)
  return true
}

function renderBlockContent(el: HTMLElement, block: BlockView) {
  if (isWhitespaceGap(block)) {
    el.className = 'block gap'
    el.replaceChildren()
    return
  }
  applyBlockMeta(el, block)
  el.classList.remove('gap')
  el.classList.toggle('focused', block.id === session.focusedId)
  const focus = block.id === session.focusedId
  el.replaceChildren()
  if (focus) {
    const host = document.createElement('div')
    host.className = 'cm-host'
    applyBlockMeta(host, block)
    el.appendChild(host)
    const config = {
      autoCharacterPairs: getSettings().autoCharacterPairs,
      showWhitespace: getSettings().showWhitespace,
      structuralKeymap: {
        Enter: (view: EditorView) => splitBlock(block, view),
        Backspace: (view: EditorView) => mergeBlock(block, view),
        ArrowUp: (view: EditorView) => moveAcrossBlocks(block, view, 'up'),
        ArrowDown: (view: EditorView) => moveAcrossBlocks(block, view, 'down'),
        ArrowLeft: (view: EditorView) => moveAcrossBlocks(block, view, 'left'),
        ArrowRight: (view: EditorView) => moveAcrossBlocks(block, view, 'right'),
      },
    }
    cm = mountEditor(host, block.raw, (text) => liveText.set(block.id, text), config)
    const intent = caretIntent
    requestAnimationFrame(() => {
      if (!cm) return
      cm.view.focus()
      if (intent) placeCaret(cm.view, intent)
    })
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
  if (block.dirty) {
    const roots = parseBlockRoots(text)
    block.mdast = roots.length <= 1 ? (roots[0] ?? null) : roots
    block.kind = kindFromMdast(roots[0]) as BlockKind
  }
  markDirty()
}

function focusBlock(id: string, intent?: CaretIntent) {
  if (session.focusedId === id) {
    if (intent && cm) {
      placeCaret(cm.view, intent)
      cm.view.focus()
    }
    return
  }
  const next = session.blocks.find((b) => b.id === id)
  if (!next || !isFocusableBlock(next)) return
  finalizeFocused()
  if (cm) {
    cm.destroy()
    cm = null
  }
  session.focusedId = id
  caretIntent = intent ?? null
  render()
  caretIntent = null
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

async function confirmOpenIfDirty(): Promise<boolean> {
  if (!session.dirty) return true
  return confirmDiscard()
}

async function openFromShellOrDialog() {
  if (!(await confirmOpenIfDirty())) return
  try {
    const picked = await pickAndRead()
    if (picked) loadSession(picked.path, picked.content, picked.mtime_ms)
  } catch (err) {
    console.error('[lector] open failed', err)
    showToast(`${t('openFailed')}：${String(err)}`)
  }
}

contentEl.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest('a')
  if (link && !link.closest('.cm-host')) {
    e.preventDefault()
    const href = link.getAttribute('href')
    if (href && /^(https?:|mailto:)/i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer')
    }
    return
  }
  const target = (e.target as HTMLElement).closest<HTMLElement>('.block:not(.gap)')
  if (!target) {
    if (session.focusedId !== null) defocus()
    return
  }
  const id = target.dataset.blockId
  if (id) focusBlock(id, { mode: 'coords', x: e.clientX, y: e.clientY })
})

const MAX_IMAGE_BYTES = 15 * 1024 * 1024

function appendImageParagraph(md: string) {
  const onlyEmpty =
    session.blocks.length === 1 &&
    session.blocks[0] &&
    isFocusableBlock(session.blocks[0]) &&
    session.blocks[0].raw === ''
  if (onlyEmpty) {
    const b = session.blocks[0]!
    b.raw = md
    b.dirty = true
    b.mdast = parseOne(md)
    b.kind = kindFromMdast(b.mdast)
    markDirty()
    render()
    return
  }
  const last = session.blocks[session.blocks.length - 1]
  if (last && !isWhitespaceGap(last)) {
    const gapId = nextId()
    session.blocks.push({
      id: gapId,
      kind: 'unknown',
      start: 0,
      end: 0,
      raw: '\n\n',
      mdast: null,
      dirty: true,
    })
    session.originals.set(gapId, '')
  }
  const para: BlockView = {
    id: nextId(),
    kind: 'paragraph',
    start: 0,
    end: 0,
    raw: md,
    mdast: parseOne(md),
    dirty: true,
  }
  session.blocks.push(para)
  session.originals.set(para.id, '')
  session.structuralDirty = true
  markDirty()
  render()
}

function insertImageMarkdownAtCaret(md: string) {
  if (cm && session.focusedId) {
    const pos = cm.view.state.selection.main.head
    cm.view.dispatch({
      changes: { from: pos, insert: md },
      selection: { anchor: pos + md.length },
    })
    return
  }
  appendImageParagraph(md)
}

async function ingestImageFile(file: File, name: string | null) {
  if (!name) return
  if (file.size > MAX_IMAGE_BYTES) {
    showToast(t('imageTooLarge'))
    return
  }
  if (detectEnv() !== 'shell' || !session.source) {
    showToast(t('imageNeedFile'))
    return
  }
  try {
    const bytes_base64 = fileToBase64(await file.arrayBuffer())
    const { relative_path } = await saveImage(session.source.path, name, bytes_base64)
    insertImageMarkdownAtCaret(imageMarkdown(relative_path))
  } catch (err) {
    showToast(`${t('imageFailed')}：${String(err)}`)
  }
}

function imageFilesFromList(list: FileList | DataTransferItemList | undefined | null): File[] {
  if (!list) return []
  const out: File[] = []
  for (const item of list) {
    if (item instanceof File) {
      if (isImageMime(item.type) || safeDropName(item.name)) out.push(item)
      continue
    }
    if (item.kind === 'file' && isImageMime(item.type)) {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

window.addEventListener(
  'paste',
  (e) => {
    const files = imageFilesFromList(e.clipboardData?.items)
    if (files.length === 0) return
    e.preventDefault()
    void (async () => {
      for (const f of files) {
        await ingestImageFile(f, pastedFileName(new Date(), f.type) ?? safeDropName(f.name))
      }
    })()
  },
  true,
)

window.addEventListener('dragover', (e) => {
  if (imageFilesFromList(e.dataTransfer?.files).length > 0 || e.dataTransfer?.types.includes('Files')) {
    e.preventDefault()
  }
})

window.addEventListener('drop', (e) => {
  const files = imageFilesFromList(e.dataTransfer?.files)
  if (files.length === 0) return
  e.preventDefault()
  void (async () => {
    for (const f of files) {
      await ingestImageFile(f, safeDropName(f.name) ?? pastedFileName(new Date(), f.type))
    }
  })()
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && session.focusedId !== null) {
    e.preventDefault()
    defocus()
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void saveAsFlow()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault()
    saveBtn.click()
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
      const roots = parseBlockRoots(b.raw)
      b.mdast = roots.length <= 1 ? (roots[0] ?? null) : roots
      b.kind = kindFromMdast(roots[0]) as BlockKind
      markDirty()
      if (session.focusedId === id && cm) {
        cm.destroy()
        cm = null
      }
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

async function persistToDisk(force = false): Promise<boolean> {
  if (!session.source) return false
  finalizeFocused()
  const normalized = serialize(session.blocks)
  const finalText = applyEncoding(session.source, normalized)
  const res = await save(session.source.path, finalText, session.source.mtimeMs, force)
  if (res.conflict) {
    const choice = await chooseConflict()
    if (choice === 'reload') {
      await reloadFromDisk()
      return false
    }
    if (choice === 'overwrite') return persistToDisk(true)
    return false
  }
  if (!res.ok) {
    showToast(t('saveFailed'))
    return false
  }
  session.blocks.forEach((b) => {
    session.originals.set(b.id, b.raw)
    b.dirty = false
  })
  session.structuralDirty = false
  if (typeof res.current_mtime_ms === 'number') {
    session.source.mtimeMs = res.current_mtime_ms
  }
  if (cm) {
    cm.destroy()
    cm = null
  }
  session.focusedId = null
  markDirty()
  render()
  showToast(t('saved'))
  return true
}

saveBtn.addEventListener('click', () => void persistToDisk())

/** 另存为：选新路径 → 强制写（系统对话框已确认覆盖）→ 会话切到新文件。 */
async function saveAsFlow() {
  if (!session.source) return
  if (detectEnv() !== 'shell') {
    await persistToDisk()
    return
  }
  finalizeFocused()
  const normalized = serialize(session.blocks)
  const finalText = applyEncoding(session.source, normalized)
  const defaultName = session.source.path.split('/').pop() ?? 'untitled.md'
  let target: string | null = null
  try {
    target = await pickSavePath(defaultName)
  } catch (err) {
    console.error('[lector] save-as dialog', err)
    return
  }
  if (!target) return
  try {
    const res = await save(target, finalText, 0, true)
    if (!res.ok) {
      showToast(t('saveFailed'))
      return
    }
    loadSession(target, finalText, res.current_mtime_ms ?? Date.now())
    showToast(t('saved'))
  } catch (err) {
    console.error('[lector] save-as failed', err)
    showToast(t('saveFailed'))
  }
}

async function reloadFromDisk() {
  if (!session.source) return
  try {
    const res = await read(session.source.path)
    loadSession(res.path, res.content, res.mtime_ms)
  } catch {
    showToast(t('reloadFailed'))
  }
}

function bindShellEvents() {
  if (detectEnv() !== 'shell') return
  // 壳把最终路径交给 web（双击 / 单实例转发）
  void onOpen(async (e) => {
    if (!(await confirmOpenIfDirty())) return
    try {
      const res = await read(e.path)
      loadSession(res.path, res.content, res.mtime_ms)
    } catch {
      showToast(t('readFailed'))
    }
  })
  // 外部变更（watch 回调）
  void onFileChanged(async (e) => {
    if (session.source && e.path === session.source.path && !session.dirty) {
      await reloadFromDisk()
    } else if (session.source && e.path === session.source.path && session.dirty) {
      showToast(t('diskChanged'))
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
      case 'save-as':
        void saveAsFlow()
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
  title.textContent = t('emptyTitle')
  const p = document.createElement('p')
  p.textContent = t('emptyHint')
  const btn = document.createElement('button')
  btn.className = 'btn btn-primary'
  btn.innerHTML = `${iconSvg('folder', 16)} ${t('openFile')}`
  btn.addEventListener('click', () => void openFromShellOrDialog())
  wrap.append(icon, title, p, btn)
  contentEl.appendChild(wrap)
  fileNameEl.textContent = 'Lector'
  fileNameEl.dataset.untitled = 'true'
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
    try {
      const pending = await takePendingOpen()
      if (pending) {
        const res = await read(pending)
        loadSession(res.path, res.content, res.mtime_ms)
      }
    } catch (err) {
      console.error('[lector] pending open', err)
    }
  } else {
    loadSession('sample.md', sample)
  }
})()
