import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import type { FindMatch } from './findMatch.ts'

const setHits = StateEffect.define<{ hits: FindMatch[]; current: number }>()
const clearHits = StateEffect.define<null>()

const hitMark = Decoration.mark({ class: 'find-hit' })
const currentMark = Decoration.mark({ class: 'find-hit find-hit--current' })

export const largeFindField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(clearHits)) return Decoration.none
      if (e.is(setHits)) {
        const { hits, current } = e.value
        const marks = hits
          .filter((h) => h.start < h.end)
          .map((h, i) => (i === current ? currentMark : hitMark).range(h.start, h.end))
        return Decoration.set(marks, true)
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

export function applyLargeFind(view: EditorView, hits: FindMatch[], current: number): void {
  const hit = hits[current]
  view.dispatch({
    effects: hit
      ? [setHits.of({ hits, current }), EditorView.scrollIntoView(hit.start, { y: 'center' })]
      : setHits.of({ hits, current }),
  })
}

export function clearLargeFind(view: EditorView): void {
  view.dispatch({ effects: clearHits.of(null) })
}
