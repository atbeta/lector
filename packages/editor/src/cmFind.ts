import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import type { FindMatch } from './findMatch.ts'

/**
 * 整篇 CM 的查找标记。
 *
 * 名字不再带 large：大文件档和源码档都是整篇一份 CM，能力是同一份，
 * 挂在「整篇」这个事实上，而不是挂在「大文件」这个性能档位上。
 */
const setHits = StateEffect.define<{ hits: FindMatch[]; current: number }>()
const clearHits = StateEffect.define<null>()

const hitMark = Decoration.mark({ class: 'find-hit' })
const currentMark = Decoration.mark({ class: 'find-hit find-hit--current' })

export const findHitField = StateField.define<DecorationSet>({
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

export function applyFindHits(view: EditorView, hits: FindMatch[], current: number): void {
  const hit = hits[current]
  view.dispatch({
    effects: hit
      ? [setHits.of({ hits, current }), EditorView.scrollIntoView(hit.start, { y: 'center' })]
      : setHits.of({ hits, current }),
  })
}

export function clearFindHits(view: EditorView): void {
  view.dispatch({ effects: clearHits.of(null) })
}
