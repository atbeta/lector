// 文档里的链接：点击该怎么处理。
//
// 背景：这些链接以前被 preventDefault() 之后**什么都不做**——本地文件点了没反应，
// 文内锚点也没反应。`safeHref` 的注释写着「点击时由编辑器拦截导航」，拦是拦了，
// 后半句没接上。
//
// 分档的理由：阅读档里点击的第一含义是「跟着链接走」；编辑/源码档里点击的第一含义是
// 「进这一块改」（点块里任何别的地方就是这个效果）。所以那两档要 Cmd/Ctrl 才开链接，
// 不加修饰键点链接就落到「进块编辑」，而不是把整篇文档换成另一个窗口。
// 外部链接走同一条规矩——同一件事不许有两套手势。
import { detectEnv, openExternal, openLink } from '@lector/shell-web'
import { showToast } from './feedback.ts'
import { t } from './i18n.ts'
import type { ViewMode } from './editorChrome.ts'

export type HrefKind = 'external' | 'local' | 'anchor' | 'other'

/**
 * 按 href 的形状分流。
 *
 * 只认 `safeHref` 放行过的东西（不认识的 scheme 在渲染层已经变成纯文本），
 * 但这里仍按形状再判一次：渲染层与点击层各判一次，任一处被改坏都不会变成
 * 「点一下去执行 javascript:」。
 */
export function classifyHref(href: string | null | undefined): HrefKind {
  const h = (href ?? '').trim()
  if (!h) return 'other'
  if (h.startsWith('#')) return 'anchor'
  if (/^(https?:|mailto:)/i.test(h)) return 'external'
  // Windows 盘符（`C:\` / `C:/`）看着像 scheme，先认出来（同 paths.ts 的 isAbsolutePath）
  if (/^[A-Za-z]:[\\/]/.test(h)) return 'local'
  if (/^file:\/\//i.test(h)) return 'local'
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return 'other'
  return 'local'
}

/** 这次点击要不要打开链接。见文件头：阅读档直接开，编辑/源码档要修饰键。 */
export function shouldOpenHref(kind: HrefKind, mode: ViewMode, withModifier: boolean): boolean {
  if (kind !== 'external' && kind !== 'local') return false
  return mode === 'read' || withModifier
}

/** 壳侧失败码 → 用户看得懂的一句话。码见 Rust 的 resolve_link_target / open_link。 */
function reasonText(err: unknown): string {
  const msg = String(err)
  if (msg.includes('missing')) return t('linkOpenMissing')
  if (msg.includes('not_text')) return t('linkOpenNotText')
  return t('linkOpenFailed')
}

/** 真正去打开。外链交给系统浏览器；本地文件走壳的 open_link（解析与校验都在壳侧）。 */
export async function openHref(kind: HrefKind, href: string, docPath: string | null): Promise<void> {
  if (kind === 'external') {
    await openExternal(href).catch(() => showToast(t('menuOpenLinkFailed')))
    return
  }
  if (kind !== 'local') return
  if (detectEnv() !== 'shell') {
    // 浏览器预览（vite dev）没有壳、也没有文档的真实路径。说清楚，别装作点了没反应
    showToast(t('linkOpenShellOnly'))
    return
  }
  if (!docPath) {
    showToast(t('linkOpenFailed'))
    return
  }
  try {
    await openLink(docPath, href)
  } catch (err) {
    showToast(reasonText(err))
  }
}
