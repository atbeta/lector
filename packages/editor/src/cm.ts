import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { keymap, EditorView, highlightWhitespace } from '@codemirror/view'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

export interface EditorialConfig {
  autoCharacterPairs: boolean
  showWhitespace: boolean
  /** 返回 true = 处理了该结构键（阻止默认行为）。 */
  structuralKeymap?: {
    Enter?: (view: EditorView) => boolean
    Backspace?: (view: EditorView) => boolean
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
  ]
  if (config.autoCharacterPairs) {
    extensions.push(closeBrackets(), keymap.of(closeBracketsKeymap))
  }
  if (config.showWhitespace) {
    extensions.push(highlightWhitespace())
  }
  if (config.structuralKeymap) {
    const keys = config.structuralKeymap
    const structuralKeys: Extension[] = []
    if (keys.Enter) {
      structuralKeys.push(keymap.of([{ key: 'Enter', run: (view) => keys.Enter?.(view) ?? false }]))
    }
    if (keys.Backspace) {
      structuralKeys.push(keymap.of([{ key: 'Backspace', run: (view) => keys.Backspace?.(view) ?? false }]))
    }
    extensions.push(...structuralKeys)
  }
  const view = new EditorView({ parent: host, doc, extensions })
  return {
    view,
    destroy: () => view.destroy(),
  }
}
