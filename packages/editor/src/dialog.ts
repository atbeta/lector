import { t } from './i18n.ts'

export type DialogAction = { id: string; label: string; primary?: boolean; danger?: boolean }

/** 简易模态：点按钮、点遮罩或 Escape 关闭。 */
export function showDialog(opts: {
  title: string
  body: string
  actions: DialogAction[]
}): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop'
    const card = document.createElement('div')
    card.className = 'modal-card dialog-card'
    const header = document.createElement('div')
    header.className = 'modal-header'
    const h = document.createElement('h2')
    h.className = 'modal-title'
    h.textContent = opts.title
    header.appendChild(h)
    const body = document.createElement('p')
    body.className = 'dialog-body'
    body.textContent = opts.body
    const footer = document.createElement('div')
    footer.className = 'modal-footer'
    const finish = (id: string | null) => {
      document.removeEventListener('keydown', onKey)
      backdrop.remove()
      resolve(id)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      }
    }
    for (const a of opts.actions) {
      const btn = document.createElement('button')
      btn.type = 'button'
      // 次要/危险键用 ghost（有描边）：三个键里两个光秃秃、一个实心，读起来是拼凑的。
      btn.className = a.primary ? 'btn btn-primary' : 'btn btn-ghost'
      if (a.danger) btn.classList.add('btn-danger')
      btn.textContent = a.label
      btn.addEventListener('click', () => finish(a.id))
      footer.appendChild(btn)
    }
    card.append(header, body, footer)
    backdrop.appendChild(card)
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null)
    })
    document.addEventListener('keydown', onKey)
    document.body.appendChild(backdrop)
    // 默认焦点：危险动作（danger: true）绝不能默认获焦，否则回车即毁数据。
    // 没有危险动作时：先 primary（语义上的「确认」），再第一个普通按钮。
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>('button')]
    const safe = (b: HTMLButtonElement) => !b.classList.contains('btn-danger')
    const initial = buttons.find(safe) ?? buttons[0]
    initial?.focus()
  })
}

export async function confirmDiscard(): Promise<boolean> {
  const id = await showDialog({
    title: t('discardTitle'),
    body: t('discardBody'),
    actions: [
      { id: 'cancel', label: t('cancel'), primary: true },
      { id: 'discard', label: t('discardConfirm'), danger: true },
    ],
  })
  return id === 'discard'
}

export async function chooseConflict(): Promise<'overwrite' | 'reload' | null> {
  const id = await showDialog({
    title: t('conflictTitle'),
    body: t('conflictBody'),
    actions: [
      { id: 'cancel', label: t('cancel'), primary: true },
      { id: 'reload', label: t('conflictReload') },
      { id: 'overwrite', label: t('conflictOverwrite'), danger: true },
    ],
  })
  if (id === 'overwrite' || id === 'reload') return id
  return null
}
