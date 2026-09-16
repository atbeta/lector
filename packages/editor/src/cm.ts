import { defaultKeymap, history, historyKeymap, undoDepth } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { keymap, EditorView, highlightWhitespace } from '@codemirror/view'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { Prec, type Extension } from '@codemirror/state'
import { htmlToMarkdown } from '@lector/core'
import { expandFence, toggleWrap } from './wrap.ts'

export interface EditorialConfig {
  autoCharacterPairs: boolean
  showWhitespace: boolean
  /**
   * 选区变化回调：非空选区 → 给 {text, from, to, rect}；空选区/失焦 → null。
   * 给 rect 是因为只有 CM 自己知道选区的视口坐标（coordsAtPos），
   * 调用方（选区浮条）不该再去猜。
   */
  onSelectionChange?: (
    sel: { text: string; from: number; to: number; rect: DOMRect } | null,
  ) => void
  /**
   * 兜底撤销：这个块的 CM 历史已经空了，块级操作还有可撤的时候调用。
   * 返回 true 表示真的撤掉了（调用方自己重绘）。
   */
  onUndoFallback?: () => boolean
  /**
   * 粘贴 HTML 时是否转成 Markdown（默认转）。
   * 代码块里要关掉：那里要的是代码原文，把网页的 `<pre>` 转成一个新围栏
   * 塞进已有围栏里，等于在代码里插了一段 Markdown。
   */
  pasteHtmlAsMarkdown?: boolean
  /** 返回 true = 处理了该结构键（阻止默认行为）。 */
  structuralKeymap?: {
    Enter?: (view: EditorView) => boolean
    Backspace?: (view: EditorView) => boolean
    ArrowUp?: (view: EditorView) => boolean
    ArrowDown?: (view: EditorView) => boolean
    ArrowLeft?: (view: EditorView) => boolean
    ArrowRight?: (view: EditorView) => boolean
  }
  /**
   * 大文件模式：文档可能几十 MB，逐键 `doc.toString()` 复制整篇会直接卡死。
   * 打开后 onChange 不再收到文本，只在每次变更时触发 onDocChanged（无参）；
   * 需要全文时（保存）调用方自己从 view.state.doc.toString() 取一次。
   */
  largeDocument?: boolean
  /** 配合 largeDocument：变更通知（不含文本）。 */
  onDocChanged?: () => void
  /** 覆盖默认的 markdown 语法（mermaid 块换专用 StreamLanguage 高亮）。 */
  language?: Extension
}

export interface CmHandle {
  view: EditorView
  destroy: () => void
}

/** 比较时忽略空白：只看「转出来的是不是还是那堆字」。 */
function sameIgnoringSpace(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
}

/**
 * 粘贴：剪贴板里带 HTML 就转成 Markdown 再插入。
 *
 * 为什么要管这件事——浏览器的 `text/plain` 只留文字，加粗、链接、清单、表格全丢，
 * 而本产品的文件就是 Markdown。粘贴是「顺手能改」的第一入口，不该是纯文本漏斗。
 *
 * 走正常的 dispatch（`userEvent: 'input.paste'`）：这次粘贴和手打的字一样进
 * CM 的撤销链，所以块内 ⌘Z 能把它整段撤回，不需要另做一套。
 *
 * 返回 false = 交回 CM 的原生粘贴。转换没带来任何增益（或转不出东西）时不要自作主张。
 */
function pasteAsMarkdown(event: ClipboardEvent, view: EditorView, enabled: boolean): boolean {
  if (!enabled) return false
  const data = event.clipboardData
  if (!data) return false
  const html = data.getData('text/html')
  if (!html) return false
  const markdown = htmlToMarkdown(html)
  if (!markdown) return false
  const plain = data.getData('text/plain')
  // 转出来跟纯文本一模一样，说明这段 HTML 没有 Markdown 能表达的结构
  if (plain && sameIgnoringSpace(markdown, plain)) return false
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: markdown },
    selection: { anchor: sel.from + markdown.length },
    scrollIntoView: true,
    userEvent: 'input.paste',
  })
  event.preventDefault()
  return true
}

// 代码高亮映射 NoteFast token（低饱和），用 CSS 变量取色以适配深浅主题。
const syntaxHigh = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: 'rgb(var(--code-keyword))', fontWeight: '500' },
    { tag: [tags.string, tags.attributeValue], color: 'rgb(var(--code-string))' },
    { tag: [tags.comment, tags.blockComment], color: 'rgb(var(--code-comment))', fontStyle: 'italic' },
    { tag: [tags.number, tags.bool, tags.null], color: 'rgb(var(--code-number))' },
    { tag: tags.heading, color: 'inherit', fontWeight: '650' },
    { tag: tags.strong, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.link, color: 'inherit', textDecoration: 'underline' },
    { tag: tags.url, color: 'rgb(var(--muted-foreground))' },
    { tag: [tags.meta, tags.processingInstruction], color: 'rgb(var(--muted-foreground))' },
  ]),
)

/**
 * 挂一个「裸 CodeMirror 6」到容器，文档 = 该块 raw。
 * 禁止任何 Decoration.replace widget——只编源码。语法高亮走 markdown() + token 色，安全。
 */
/** 对当前选区套用行内格式。⌘B/⌘I/⌘E/⌘K 与选区浮条共用这一份实现。 */
function applyWrap(view: EditorView, left: string, right?: string, placeholder?: string): void {
  const { state } = view
  const sel = state.selection.main
  const r = toggleWrap(state.doc.toString(), sel.from, sel.to, { left, right, placeholder })
  view.dispatch({
    changes: { from: 0, to: state.doc.length, insert: r.text },
    selection: { anchor: r.selection.from, head: r.selection.to },
    scrollIntoView: true,
    userEvent: 'input',
  })
}

/** 选区浮条用：套用指定行内格式（与快捷键同一套实现，不另抄一份）。 */
export function formatSelection(
  view: EditorView,
  kind: 'bold' | 'italic' | 'code' | 'link',
): void {
  if (kind === 'bold') applyWrap(view, '**')
  else if (kind === 'italic') applyWrap(view, '*')
  else if (kind === 'code') applyWrap(view, '`')
  else applyWrap(view, '[', undefined, 'url')
}

export function mountEditor(
  host: HTMLElement,
  doc: string,
  onChange: (text: string) => void,
  config: EditorialConfig,
): CmHandle {
  const extensions: Extension[] = [
    config.language ?? markdown(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    syntaxHigh,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        // 大文件不把整篇 toString（那是 O(n) 复制，逐键调用会卡死）；只报「变了」
        if (config.largeDocument) config.onDocChanged?.()
        else onChange(update.state.doc.toString())
      }
      if (config.onSelectionChange && (update.selectionSet || update.docChanged || update.focusChanged)) {
        reportSelection(update.view)
      }
    }),
    EditorView.domEventHandlers({
      paste: (event, view) => pasteAsMarkdown(event, view, config.pasteHtmlAsMarkdown !== false),
    }),
    EditorView.theme({
      '&': {
        fontSize: 'inherit',
        fontFamily: 'inherit',
        backgroundColor: 'transparent',
        color: 'inherit',
      },
      '.cm-content': { padding: '0', caretColor: 'rgb(var(--foreground))', fontFamily: 'inherit' },
      '.cm-line': { padding: '0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--foreground))' },
      '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
      '.cm-gutters': { display: 'none' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' },
      '.cm-selectionMatch': { backgroundColor: 'transparent' },
    }),
  ]
  if (config.autoCharacterPairs) {
    extensions.push(closeBrackets(), keymap.of(closeBracketsKeymap))
  }
  if (config.showWhitespace) {
    extensions.push(highlightWhitespace())
  }
  // 行内格式快捷键：⌘B 粗体 / ⌘I 斜体 / ⌘E 行内代码 / ⌘K 链接。
  //
  // 这是「顺手能改」的核心：没有它，读者想加粗一个词就得手打四个星号、
  // 想加链接就得记住 `[]()` 的顺序。参考 notefast 的 keymap��但只取纯格式部分
  // （它的 ⌘Enter 续写、选区气泡问 AI 属于 AI 能力，本项目不做）。
  //
  // 用 Prec.high：lang-markdown 自带的 keymap 里有同键位（如 ⌘E 在某些编辑器里
  // 是「行内代码」），要先于它执行。
  const wrapKey = (left: string, right?: string, placeholder?: string) => (view: EditorView) => {
    applyWrap(view, left, right, placeholder)
    return true
  }

  extensions.push(
    Prec.high(
      keymap.of([
        { key: 'Mod-b', preventDefault: true, run: wrapKey('**') },
        { key: 'Mod-i', preventDefault: true, run: wrapKey('*') },
        { key: 'Mod-e', preventDefault: true, run: wrapKey('`') },
        // 中文输入法下 ⌘K 不冲突；链接一律给 url 占位
        { key: 'Mod-k', preventDefault: true, run: wrapKey('[', undefined, 'url') },
        {
          key: 'Mod-z',
          run: (view) => {
            // 块内打字是 CM 自己的历史，先让它走
            if (undoDepth(view.state) > 0) return false
            // 历史见底了才轮到块级撤销：刚插入的空段落、上一次删掉的块、勾错的任务。
            // 没有这一条，用户在空块里按 ⌘Z 会「什么都没发生」——插入的段落撤不掉。
            //
            // 必须等这一记键盘事件走完再动手：撤掉的可能正是当前聚焦的这个块，
            // 中途销毁 CM 会让它继续在自己已经被拆掉的 DOM 上跑。
            window.setTimeout(() => config.onUndoFallback?.(), 0)
            return true
          },
        },
        {
          key: 'Enter',
          run: (view) => {
            // 大文件：围栏展开要拿整篇文本（doc.toString()），几十 MB 下每次回车
            // 都是一次全量复制。大文件模式不做这个便利，交给普通换行。
            if (config.largeDocument) return false
            // ``` 之后回车 → 展开成代码块（光标进块内）。返回 false 时
            // 交给 lang-markdown 的列表续行等默认行为。
            const { state } = view
            const sel = state.selection.main
            if (!sel.empty) return false
            const line = state.doc.lineAt(sel.head)
            const before = state.doc.line(line.number)
            // 已闭合的围栏：数一数前面还有几个 ``` 行
            let fences = 0
            for (let i = 1; i < line.number; i++) {
              if (/^\s*```/.test(state.doc.line(i).text)) fences++
            }
            void before
            const r = expandFence(state.doc.toString(), sel.head, fences)
            if (!r) return false
            view.dispatch({
              changes: { from: 0, to: state.doc.length, insert: r.text },
              selection: { anchor: r.cursor },
              scrollIntoView: true,
              userEvent: 'input',
            })
            return true
          },
        },
      ]),
    ),
  )

  if (config.structuralKeymap) {
    const keys = config.structuralKeymap
    const bindings: { key: string; run: (view: EditorView) => boolean }[] = []
    const bind = (key: string, fn?: (view: EditorView) => boolean) => {
      if (fn) bindings.push({ key, run: (view) => fn(view) })
    }
    bind('Enter', keys.Enter)
    bind('Backspace', keys.Backspace)
    bind('ArrowUp', keys.ArrowUp)
    bind('ArrowDown', keys.ArrowDown)
    bind('ArrowLeft', keys.ArrowLeft)
    bind('ArrowRight', keys.ArrowRight)
    if (bindings.length) extensions.push(Prec.high(keymap.of(bindings)))
  }
  /** 把当前选区（含视口坐标）报给外部；空选区或失焦报 null。 */
  const reportSelection = (view: EditorView): void => {
    const hook = config.onSelectionChange
    if (!hook) return
    if (!view.hasFocus) return hook(null)
    const sel = view.state.selection.main
    if (sel.empty) return hook(null)
    const from = view.coordsAtPos(sel.from)
    const to = view.coordsAtPos(sel.to)
    if (!from || !to) return hook(null)
    // 多行选区：取两端的并集，够浮条定位用（不求像素级精确）
    const left = Math.min(from.left, to.left)
    const right = Math.max(from.right, to.right)
    const top = Math.min(from.top, to.top)
    const bottom = Math.max(from.bottom, to.bottom)
    hook({
      text: view.state.sliceDoc(sel.from, sel.to),
      from: sel.from,
      to: sel.to,
      rect: new DOMRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top)),
    })
  }

  const view = new EditorView({ parent: host, doc, extensions })
  return {
    view,
    destroy: () => view.destroy(),
  }
}
