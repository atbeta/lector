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

/** 这次点击要不要打开链接。见文件头：阅读档直接开，编辑/源码档要修饰键。
 * anchor（文内锚点）与外链同权：阅读档直接跳，编辑档要修饰键。 */
export function shouldOpenHref(kind: HrefKind, mode: ViewMode, withModifier: boolean): boolean {
  if (kind !== 'external' && kind !== 'local' && kind !== 'anchor') return false
  return mode === 'read' || withModifier
}

/** 壳侧失败码 → 用户看得懂的一句话。码见 Rust 的 resolve_link_target / open_link。 */
function reasonText(err: unknown): string {
  const msg = String(err)
  if (msg.includes('missing')) return t('linkOpenMissing')
  if (msg.includes('not_text')) return t('linkOpenNotText')
  return t('linkOpenFailed')
}

/**
 * GitHub slug：标题文本 → 锚点 id。规则：拉丁转小写、删全部标点/符号
 * （含 emoji 与中文标点，\p{P}\p{S}）、每个空白字符各换成一个 `-`。
 * 与 GitHub/Typora/Obsidian 生成的锚点兼容——别人文档里的目录链接拿过来就能用。
 * 例：`十二、折叠块 / 详情` → `十二折叠块--详情`（删「、」「/」，两个空格各变一个 -）。
 */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s/g, '-')
}

/**
 * 滚动到锚点对应的标题。渲染期不给标题生成 id（省一次全文状态），点击时按
 * DOM 顺序重算：第 n 个同名标题的 slug 追加 -n（GitHub 重复标题规则）。
 * 找不到返回 false，调用方提示。scrollIntoView 滚最近可滚祖先，无需知道
 * 滚动容器是谁；大纲侧栏监听滚动会自动跟上高亮。
 */
export function scrollToAnchor(target: string, root: HTMLElement): boolean {
  const want = decodeURIComponent(target).trim().toLowerCase()
  if (!want) return false
  // 精确 id 优先（脚注定义 id="fn-…"、脚注引用 id="fnref-…" 等非标题锚点），
  // 没有再走标题 slug 匹配。
  const byId = root.querySelector(`#${CSS.escape(want)}`)
  if (byId) {
    byId.scrollIntoView({ behavior: 'auto', block: 'start' })
    return true
  }
  const seen = new Map<string, number>()
  for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const base = githubSlug(h.textContent ?? '')
    if (!base) continue
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const slug = n === 0 ? base : `${base}-${n}`
    if (slug === want) {
      h.scrollIntoView({ behavior: 'auto', block: 'start' })
      return true
    }
  }
  return false
}

/** 真正去打开。外链交给系统浏览器；本地文件走壳的 open_link（解析与校验都在壳侧）；
 * 文内锚点滚动到对应标题（GitHub slug 规则，见 scrollToAnchor）。 */
export async function openHref(
  kind: HrefKind,
  href: string,
  docPath: string | null,
  anchorRoot?: HTMLElement | null,
): Promise<void> {
  if (kind === 'anchor') {
    const ok = scrollToAnchor(href.slice(1), anchorRoot ?? document.body)
    if (!ok) showToast(t('anchorNotFound'))
    return
  }
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
