/**
 * 未保存内容的本地暂存（「下次打开时恢复」的唯一数据来源）。
 *
 * 为什么不存壳侧文件：
 *   - 这是一份**短命的草稿**，不是文档。放磁盘上要新增一条写路径、一个目录、
 *     一套清理规则（多久过期、退出要不要删），而磁盘 .md 是唯一权威这条红线
 *     不该为一份草稿让步；
 *   - 它也**不会被误当成"保存"**——从来不碰原文件。
 *
 * 为什么是 IndexedDB 而不是 localStorage：草稿上限是 3MB（与完整 IR 的体积上限一致），
 * localStorage 只有约 5MB 的总配额，一份草稿就能把它撑满，而且写入是同步的，
 * 3MB 的 JSON.stringify 会卡住主线程。IndexedDB 按应用隔离、异步、配额以几十 MB 计。
 *
 * 记的是「内容」，不是「改了什么」：恢复时直接整篇替换，简单且不会漂移。
 */
const DB_NAME = 'lector'
const STORE = 'recovery'
/** 单份草稿上限：与完整 IR 的体积上限一致。再大的文档走纯文本模式，不记草稿。 */
const MAX_LEN = 3 * 1024 * 1024
/** 旧实现存在 localStorage 里，键是这个前缀。首次读到时迁进 IndexedDB 再删掉。 */
const LEGACY_PREFIX = 'lector-recovery:'

export interface Recovery {
  path: string
  content: string
  /** 记这份草稿的时间（展示给用户看"上次是几点"） */
  at: number
}

interface RecoveryRecord {
  path: string
  content: string
  at: number
}

let dbPromise: Promise<IDBDatabase> | null = null

/** 测试里换掉 indexedDB 之前调用。连接是进程级缓存，不丢掉的话失败注入打不中。 */
export function resetRecoveryDbForTests(): void {
  dbPromise = null
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * 记一份草稿。path 为空（未落到磁盘的新文档）时不记——没有"上次打开"可言。
 * 返回是否写进了 IndexedDB。调用方只有在成功之后才能删掉旧的 localStorage 副本。
 */
export async function rememberRecovery(path: string, content: string): Promise<boolean> {
  if (!path || content.length > MAX_LEN) return false
  try {
    const db = await openDb()
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put({ path, content, at: Date.now() }, path))
    return true
  } catch {
    // 配额满 / 隐私模式：恢复是尽力而为的能力，失败不该打扰正在写作的人
    return false
  }
}

export async function readRecovery(path: string): Promise<Recovery | null> {
  if (!path) return null
  try {
    const legacy = readLegacy(path)
    if (legacy) {
      // 写失败就留下 localStorage。先删再发现 IndexedDB 没写上，这份草稿就没了。
      if (await rememberRecovery(path, legacy.content)) localStorage.removeItem(LEGACY_PREFIX + path)
      return legacy
    }
    const db = await openDb()
    const record = await requestToPromise(db.transaction(STORE).objectStore(STORE).get(path) as IDBRequest<RecoveryRecord | undefined>)
    if (!record || typeof record.content !== 'string') return null
    return { path, content: record.content, at: typeof record.at === 'number' ? record.at : 0 }
  } catch {
    return null
  }
}

/** 存盘成功后清掉：草稿已经落进磁盘，留着只会在下次打开时弹一个假的"未保存" */
export async function forgetRecovery(path: string): Promise<void> {
  if (!path) return
  try {
    localStorage.removeItem(LEGACY_PREFIX + path)
    const db = await openDb()
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(path))
  } catch {
    /* ignore */
  }
}

/** 旧 localStorage 草稿。读不到（没有、坏数据）返回 null。 */
function readLegacy(path: string): Recovery | null {
  try {
    const raw = localStorage.getItem(LEGACY_PREFIX + path)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { content?: unknown; at?: unknown }
    if (typeof parsed.content !== 'string') return null
    return { path, content: parsed.content, at: typeof parsed.at === 'number' ? parsed.at : 0 }
  } catch {
    return null
  }
}
