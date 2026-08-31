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
      btn.className = a.primary ? 'btn btn-primary' : 'btn'
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
    footer.querySelector<HTMLButtonElement>('button:last-child')?.focus()
  })
}

export async function confirmDiscard(): Promise<boolean> {
  const id = await showDialog({
    title: t('discardTitle'),
    body: t('discardBody'),
    actions: [
      { id: 'cancel', label: t('cancel') },
      { id: 'discard', label: t('discardConfirm'), primary: true },
    ],
  })
  return id === 'discard'
}

export async function chooseConflict(): Promise<'overwrite' | 'reload' | null> {
  const id = await showDialog({
    title: t('conflictTitle'),
    body: t('conflictBody'),
    actions: [
      { id: 'cancel', label: t('cancel') },
      { id: 'reload', label: t('conflictReload') },
      { id: 'overwrite', label: t('conflictOverwrite'), primary: true },
    ],
  })
  if (id === 'overwrite' || id === 'reload') return id
  return null
}
