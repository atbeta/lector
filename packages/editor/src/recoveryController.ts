import { applyEncoding, serialize } from '@lector/core'
import { getSettings } from './settings.ts'
import { readRecovery, rememberRecovery, forgetRecovery, type Recovery } from './recovery.ts'
import { showToast } from './feedback.ts'
import { t } from './i18n.ts'
import type { DocumentSession } from './documentSession.ts'

interface RecoveryDeps {
  getSession(): Readonly<DocumentSession>
  isLarge(): boolean
  loadSession(path: string, raw: string, mtimeMs?: number): void
  markStructuralDirty(): void
}

export function createRecoveryController({ getSession, isLarge, loadSession, markStructuralDirty }: RecoveryDeps) {
  /**
   * ── 未保存内容恢复 ──
   *
   * 只在「真实文件」上启用：内置预览样例（sample.md / media.md …）没有目录，
   * 给它们记草稿没有意义（下次启动就弹一个假的"未保存"），真实文件的路径必带目录分隔符。
   *
   * 存的是「保存会写成什么」——用 serialize + applyEncoding，与写盘同一条路径，
   * 不用另一套拼接方式：草稿和最终文件内容必须一字不差，否则"恢复"恢复出的是另一个东西。
   */
  function isRecoverable(path: string): boolean {
    return path.includes('/') || path.includes('\\')
  }

  let pendingRecovery: Recovery | null = null
  let recoveryBar: HTMLElement | null = null
  let recoveryTimer: number | null = null

  /** 输入停下来再记草稿：每敲一个字都写 localStorage，长文档会肉眼可见地卡。 */
  function scheduleRecoveryWrite(): void {
    if (recoveryTimer !== null) window.clearTimeout(recoveryTimer)
    recoveryTimer = window.setTimeout(() => {
      recoveryTimer = null
      if (!getSettings().recoverUnsaved) return
      const src = getSession().source
      // 大文件不写草稿：一是几十 MB 的整篇序列化本身不划算，二是这份文本没有块基线
      // （serialize([]) 会得到空串，真存下去就是一条"文件变空了"的假草稿）。
      if (isLarge()) return
      if (!getSession().dirty || !src || !isRecoverable(src.path)) return
      rememberRecovery(src.path, applyEncoding(src, serialize(getSession().blocks)))
    }, 1200)
  }

  function hideRecoveryBar(): void {
    recoveryBar?.remove()
    recoveryBar = null
  }

  /**
   * 提示条固定在顶栏下方，而不是插进正文流：插进 #content 会被任何一次重渲染
   * （切模式、改设置、编辑落块）冲掉，而这条提示必须一直在，直到用户做出选择。
   */
  function showRecoveryBar(): void {
    if (!pendingRecovery || recoveryBar) return
    const bar = document.createElement('div')
    bar.className = 'recover-bar'
    bar.setAttribute('role', 'alert')
    const text = document.createElement('span')
    text.className = 'recover-text'
    text.textContent = t('recoverFound', { time: new Date(pendingRecovery.at).toLocaleString() })
    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'btn btn-primary'
    restore.textContent = t('recoverRestore')
    restore.addEventListener('click', () => void restoreDraft())
    const discard = document.createElement('button')
    discard.type = 'button'
    discard.className = 'btn'
    discard.textContent = t('recoverDiscard')
    discard.addEventListener('click', () => {
      if (pendingRecovery) forgetRecovery(pendingRecovery.path)
      pendingRecovery = null
      hideRecoveryBar()
    })
    bar.append(text, restore, discard)
    document.body.appendChild(bar)
    recoveryBar = bar
  }

  async function restoreDraft(): Promise<void> {
    const rec = pendingRecovery
    if (!rec) return
    pendingRecovery = null
    hideRecoveryBar()
    const mtime = getSession().source?.mtimeMs ?? Date.now()
    loadSession(rec.path, rec.content, mtime)
    // 恢复出来的内容**相对磁盘是有改动的**，必须保持"未保存"：
    // 否则用户关窗口时拿不到提示，恢复就等于白做一次。
    markStructuralDirty()
    showToast(t('recoverRestored'))
  }

  function inspect(path: string, raw: string): void {
    pendingRecovery = null
    hideRecoveryBar()
    if (getSettings().recoverUnsaved && isRecoverable(path)) {
      const rec = readRecovery(path)
      if (rec && rec.content !== raw) {
        pendingRecovery = rec
        showRecoveryBar()
      } else if (rec) {
        // 草稿与磁盘一致（用户已经存过了）：留着没有意义
        forgetRecovery(path)
      }
    }
  }

  function syncDirty(): void {
    const session = getSession()
    if (session.dirty) {
      scheduleRecoveryWrite()
    } else if (session.source) {
      // 干净了就把草稿清掉：内容已与磁盘一致（保存成功，或用户自己改回来了），
      // 留着只会在下次打开时弹一个假的"未保存"。
      forgetRecovery(session.source.path)
    }
  }

  return { inspect, syncDirty, hideRecoveryBar }
}

export type RecoveryController = ReturnType<typeof createRecoveryController>
