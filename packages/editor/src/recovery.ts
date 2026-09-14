/**
 * 未保存内容的本地暂存（「下次打开时恢复」的唯一数据来源）。
 *
 * 为什么存 localStorage 而不是壳侧文件：
 *   - 这是一份**短命的草稿**，不是文档。放磁盘上要新增一条写路径、一个目录、
 *     一套清理规则（多久过期、退出要不要删），而磁盘 .md 是唯一权威这条红线
 *     不该为一份草稿让步；
 *   - localStorage 天然按应用隔离、随 WebView 持久化，几十 KB 的文本完全够用，
 *     也**不会被误当成"保存"**——它从来不碰原文件。
 *
 * 记的是「内容」，不是「改了什么」：恢复时直接整篇替换，简单且不会漂移。
 */
const PREFIX = 'lector-recovery:'
/** 单份草稿上限：超了就不记，避免把 localStorage 撑爆（超长文档本来也该早点保存） */
const MAX_LEN = 512 * 1024

export interface Recovery {
  path: string
  content: string
  /** 记这份草稿的时间（展示给用户看"上次是几点"） */
  at: number
}

/** 记一份草稿。path 为空（未落到磁盘的新文档）时不记——没有"上次打开"可言。 */
export function rememberRecovery(path: string, content: string): void {
  if (!path || content.length > MAX_LEN) return
  try {
    localStorage.setItem(PREFIX + path, JSON.stringify({ content, at: Date.now() }))
  } catch {
    // 配额满 / 隐私模式：恢复是尽力而为的能力，失败不该打扰正在写作的人
  }
}

export function readRecovery(path: string): Recovery | null {
  if (!path) return null
  try {
    const raw = localStorage.getItem(PREFIX + path)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { content?: unknown; at?: unknown }
    if (typeof parsed.content !== 'string') return null
    return { path, content: parsed.content, at: typeof parsed.at === 'number' ? parsed.at : 0 }
  } catch {
    return null
  }
}

/** 存盘成功后清掉：草稿已经落进磁盘，留着只会在下次打开时弹一个假的"未保存" */
export function forgetRecovery(path: string): void {
  if (!path) return
  try {
    localStorage.removeItem(PREFIX + path)
  } catch {
    /* ignore */
  }
}
