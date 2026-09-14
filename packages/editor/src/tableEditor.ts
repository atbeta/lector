// 表格网格编辑弹窗：点表格预览打开，改完一次写回 GFM 源码。
// 移植自 notefast 的 TableEditorDialog（React）为无依赖的 DOM 实现。
//
// 为什么不进聚焦块的 CodeMirror：管道表格在纯文本里改列/删行极其痛苦，
// 而表格恰好是「结构上想网格、存储上要源码」的典型——弹窗管网格，写回管源码。

import { t } from './i18n.ts'
import {
  addCol,
  addRow,
  deleteCol,
  deleteRow,
  padTable,
  parseTable,
  serializeTable,
  setCell,
  type ParsedTable,
} from './tableModel.ts'

export function openTableEditor(opts: {
  /** 表格块的原文（GFM 管道表格）。 */
  source: string
  /** 完成（含点遮罩 / Esc）：把网格序列化回 Markdown。 */
  onDone: (markdown: string) => void
  /** 「编辑源码」：同样先写回网格结果，再由调用方把块切到源码编辑。 */
  onEditSource: (markdown: string) => void
}): void {
  let draft: ParsedTable = padTable(parseTable(opts.source.split('\n')))
  /** 用户改过表格：仅此时序列化写回。打开-关上是常见不动作，
   *  但 parseTable → padTable → serializeTable 的双向总会规范化对齐空格，
   *  等价无改也会让 md ≠ block.raw，触发脏标。记下来以走原路。 */
  let dirty = false
  let closed = false

  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  const card = document.createElement('div')
  card.className = 'modal-card table-editor-card'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')

  const header = document.createElement('div')
  header.className = 'modal-header'
  const title = document.createElement('h2')
  title.className = 'modal-title'
  title.textContent = t('tableTitle')
  const sourceBtn = document.createElement('button')
  sourceBtn.type = 'button'
  sourceBtn.className = 'btn'
  sourceBtn.textContent = t('tableEditSource')
  const doneBtn = document.createElement('button')
  doneBtn.type = 'button'
  doneBtn.className = 'btn btn-primary'
  doneBtn.textContent = t('done')
  header.append(title, sourceBtn, doneBtn)

  const bodyEl = document.createElement('div')
  bodyEl.className = 'table-editor-body'

  card.append(header, bodyEl)
  backdrop.appendChild(card)

  function finish(editSource: boolean): void {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey, true)
    backdrop.remove()
    // 没改：不要写回。点「编辑源码」则传原始 source，让上游 applyTableMarkdown
    // 看到 md === block.raw 自行跳过，避免「打开表格看一眼」也变脏。
    if (!dirty) {
      if (editSource) opts.onEditSource(opts.source)
      return
    }
    const md = serializeTable(draft)
    if (editSource) opts.onEditSource(md)
    else opts.onDone(md)
  }

  function onKey(e: KeyboardEvent): void {
    // 编辑器里 Esc 是「取消聚焦」；弹窗开着时它只属于弹窗（capture 拦截）
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
  }

  /** 单元格：textarea 自适应高度；Enter 跳下一行（末行自动补行）。 */
  function makeCell(row: number, col: number, value: string): HTMLTextAreaElement {
    const ta = document.createElement('textarea')
    ta.rows = 1
    ta.value = value
    ta.dataset.row = String(row)
    ta.dataset.col = String(col)
    ta.spellcheck = false
    ta.setAttribute(
      'aria-label',
      row < 0 ? t('tableHeaderCell', { n: col + 1 }) : t('tableBodyCell', { row: row + 1, col: col + 1 }),
    )
    const autogrow = () => {
      ta.style.height = '0px'
      ta.style.height = `${Math.max(ta.scrollHeight, 36)}px`
    }
    ta.addEventListener('input', () => {
      // 单元格没有多行概念：换行折叠成空格（GFM 表格也不支持行内换行）
      const v = ta.value.replace(/\n/g, ' ')
      if (v !== ta.value) ta.value = v
      draft = setCell(draft, row, col, v)
      dirty = true
      autogrow()
    })
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return
      e.preventDefault()
      const nextRow = row + 1
      if (nextRow >= draft.body.length) {
        draft = addRow(draft)
        dirty = true
        renderGrid()
      }
      focusCell(nextRow, col)
    })
    requestAnimationFrame(autogrow)
    return ta
  }

  function focusCell(row: number, col: number): void {
    bodyEl.querySelector<HTMLTextAreaElement>(`textarea[data-row="${row}"][data-col="${col}"]`)?.focus()
  }

  function ghostButton(label: string, glyph: '+' | '×', run: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'table-editor-op'
    btn.tabIndex = -1
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.textContent = glyph
    btn.addEventListener('click', run)
    return btn
  }

  /** 结构变化（增删行列）后整网重绘；单元格输入不走这里。 */
  function renderGrid(): void {
    draft = padTable(draft)
    const cols = draft.header.length
    bodyEl.replaceChildren()
    const grid = document.createElement('table')
    grid.className = 'table-editor-grid'

    const thead = document.createElement('thead')
    const hr = document.createElement('tr')
    draft.header.forEach((cell, ci) => {
      const th = document.createElement('th')
      th.appendChild(makeCell(-1, ci, cell))
      if (cols > 1) {
        th.appendChild(
          ghostButton(t('tableDelCol'), '×', () => {
            draft = deleteCol(draft, ci)
            dirty = true
            renderGrid()
          }),
        )
      }
      hr.appendChild(th)
    })
    const addColTh = document.createElement('th')
    addColTh.className = 'table-editor-gutter'
    addColTh.appendChild(
      ghostButton(t('tableAddCol'), '+', () => {
        draft = addCol(draft)
        dirty = true
        renderGrid()
        focusCell(-1, draft.header.length - 1)
      }),
    )
    hr.appendChild(addColTh)
    thead.appendChild(hr)

    const tbody = document.createElement('tbody')
    draft.body.forEach((row, ri) => {
      const tr = document.createElement('tr')
      row.forEach((cell, ci) => {
        const td = document.createElement('td')
        td.appendChild(makeCell(ri, ci, cell))
        tr.appendChild(td)
      })
      const gutter = document.createElement('td')
      gutter.className = 'table-editor-gutter'
      gutter.appendChild(
        ghostButton(t('tableDelRow'), '×', () => {
          draft = deleteRow(draft, ri)
          dirty = true
          renderGrid()
        }),
      )
      tr.appendChild(gutter)
      tbody.appendChild(tr)
    })
    const addTr = document.createElement('tr')
    const addTd = document.createElement('td')
    addTd.colSpan = cols
    const addRowBtn = document.createElement('button')
    addRowBtn.type = 'button'
    addRowBtn.className = 'table-editor-add-row'
    addRowBtn.textContent = `+ ${t('tableAddRow')}`
    addRowBtn.addEventListener('click', () => {
      draft = addRow(draft)
      dirty = true
      renderGrid()
      focusCell(draft.body.length - 1, 0)
    })
    addTd.appendChild(addRowBtn)
    addTr.appendChild(addTd)
    const addGutter = document.createElement('td')
    addGutter.className = 'table-editor-gutter'
    addTr.appendChild(addGutter)
    tbody.appendChild(addTr)

    grid.append(thead, tbody)
    bodyEl.appendChild(grid)
  }

  sourceBtn.addEventListener('click', () => finish(true))
  doneBtn.addEventListener('click', () => finish(false))
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) finish(false)
  })
  document.addEventListener('keydown', onKey, true)

  renderGrid()
  document.body.appendChild(backdrop)
  // 焦点落到第一个单元格，打开就能敲
  requestAnimationFrame(() => focusCell(-1, 0))
}
