import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { keymap, EditorView, highlightWhitespace } from '@codemirror/view'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { Prec, type Extension } from '@codemirror/state'
import { expandFence, toggleWrap } from './wrap.ts'

export interface EditorialConfig {
  autoCharacterPairs: boolean
  showWhitespace: boolean
  /** 返回 true = 处理了该结构键（阻止默认行为）。 */
  structuralKeymap?: {
    Enter?: (view: EditorView) => boolean
    Backspace?: (view: EditorView) => boolean
    ArrowUp?: (view: EditorView) => boolean
    ArrowDown?: (view: EditorView) => boolean
    ArrowLeft?: (view: EditorView) => boolean
    ArrowRight?: (view: EditorView) => boolean
  }
}

export interface CmHandle {
  view: EditorView
  destroy: () => void
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
export function mountEditor(
  host: HTMLElement,
  doc: string,
  onChange: (text: string) => void,
  config: EditorialConfig,
): CmHandle {
  const extensions: Extension[] = [
    markdown(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    syntaxHigh,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChange(update.state.doc.toString())
      }
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
  // 想加链接就得记住 `[]()` 的顺序。参考 notefast 的 keymap，但只取纯格式部分
  // （它的 ⌘Enter 续写、选区气泡问 AI 属于 AI 能力，本项目不做）。
  //
  // 用 Prec.high：lang-markdown 自带的 keymap 里有同键位（如 ⌘E 在某些编辑器里
  // 是「行内代码」），要先于它执行。
  const wrapKey = (left: string, right?: string, placeholder?: string) => (view: EditorView) => {
    const { state } = view
    const sel = state.selection.main
    const r = toggleWrap(state.doc.toString(), sel.from, sel.to, { left, right, placeholder })
    view.dispatch({
      changes: { from: 0, to: state.doc.length, insert: r.text },
      selection: { anchor: r.selection.from, head: r.selection.to },
      scrollIntoView: true,
      userEvent: 'input',
    })
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
          key: 'Enter',
          run: (view) => {
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
  const view = new EditorView({ parent: host, doc, extensions })
  return {
    view,
    destroy: () => view.destroy(),
  }
}
