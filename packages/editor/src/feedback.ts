import { t } from './i18n.ts'

export function showToast(msg: string) {
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

/** 复制文本：优先 Clipboard API，失败退回 execCommand（壳里的老 WebView 可能不支持前者）。 */
export async function copyText(text: string, okMessage?: string): Promise<void> {
  const done = okMessage ?? t('codeCopied')
  try {
    await navigator.clipboard.writeText(text)
    showToast(done)
    return
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    showToast(ok ? done : t('codeCopyFailed'))
  } catch {
    showToast(t('codeCopyFailed'))
  }
}
