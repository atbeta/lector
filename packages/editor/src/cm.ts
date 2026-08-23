import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { keymap, EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

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
    { tag: tags.heading, color: 'rgb(var(--primary))', fontWeight: '650' },
    { tag: tags.strong, fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.link, color: 'rgb(var(--primary))', textDecoration: 'underline' },
    { tag: tags.url, color: 'rgb(var(--code-string))' },
    { tag: [tags.meta, tags.processingInstruction], color: 'rgb(var(--code-comment))' },
  ]),
)

/**
 * 挂一个「裸 CodeMirror 6」到容器，文档 = 该块 raw。
 * 禁止任何 Decoration.replace widget——只编源码。语法高亮走 markdown() + token 色，安全。
 */
export function mountEditor(host: HTMLElement, doc: string, onChange: (text: string) => void): CmHandle {
  const view = new EditorView({
    parent: host,
    doc,
    extensions: [
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
        '&': { fontSize: '14px', backgroundColor: 'transparent', color: 'rgb(var(--foreground))' },
        '.cm-content': { padding: '2px 4px', caretColor: 'rgb(var(--foreground))' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--foreground))' },
        '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
        '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
        '.cm-gutters': { display: 'none' },
        '.cm-activeLine': { backgroundColor: 'rgb(var(--muted) / 0.5)' },
        '&.cm-focused': { outline: 'none' },
        '.cm-selectionMatch': { backgroundColor: 'rgb(var(--primary) / 0.12)' },
      }),
    ],
  })
  return {
    view,
    destroy: () => view.destroy(),
  }
}
