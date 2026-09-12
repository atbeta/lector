// 阅读位置记忆：同一个文件再打开，回到上次读到的地方。
//
// 这是阅读器的刚需，不是锦上添花：一篇长文档关掉再打开就回到顶部，
// 等于每次都要重新找位置。存的是「滚动偏移 + 文档长度」，
// 而不是百分比——文档被编辑变长后，按比例恢复会把位置算错，
// 按绝对偏移至少落在同一段附近，读取时再用长度做一次合理性判断。
//
// 存取逻辑抽成纯函数：这类「键值累积 + 淘汰」的代码最容易长成
// 一个只会增长的 localStorage，而它出问题没有任何报错。

export interface ReadingPosition {
  /** 滚动偏移（px） */
  top: number
  /** 记录时的文档内容长度，用于判断位置是否还有效 */
  length: number
  /** 记录时间戳，淘汰最旧用 */
  at: number
}

export type PositionMap = Record<string, ReadingPosition>

/** 最多记多少个文件的位置。超出后淘汰最久未打开的。 */
export const MAX_POSITIONS = 60

/** 位置小于这个值就不记：刚打开就关掉的文件不值得占一个槽位。 */
export const MIN_RECORDED_TOP = 40

/**
 * 记录一个位置。返回新的 map（不修改入参）。
 * 同一路径覆盖旧值，并更新 at。
 */
export function recordPosition(
  map: PositionMap,
  path: string,
  top: number,
  length: number,
  now = Date.now(),
): PositionMap {
  if (!path) return map
  if (top < MIN_RECORDED_TOP) {
    // 回到顶部 = 主动放弃记录，删掉旧位置，避免下次又跳回中间
    if (!(path in map)) return map
    const next = { ...map }
    delete next[path]
    return next
  }
  return { ...map, [path]: { top: Math.round(top), length, at: now } }
}

/** 取某个路径的位置；没有或明显失效时返回 null。 */
export function getPosition(map: PositionMap, path: string, currentLength: number): number | null {
  const rec = map[path]
  if (!rec) return null
  if (rec.top < MIN_RECORDED_TOP) return null
  // 文档被大幅改写（删掉一半以上）时，旧偏移多半已经落到别处，不恢复
  if (rec.length > 0 && currentLength < rec.length * 0.5) return null
  return rec.top
}

/** 淘汰到上限之内，保留最近打开的。 */
export function prunePositions(map: PositionMap, max = MAX_POSITIONS): PositionMap {
  const keys = Object.keys(map)
  if (keys.length <= max) return map
  const keep = keys
    .sort((a, b) => (map[b]?.at ?? 0) - (map[a]?.at ?? 0))
    .slice(0, max)
  const next: PositionMap = {}
  for (const k of keep) {
    const v = map[k]
    if (v) next[k] = v
  }
  return next
}

/** 解析 localStorage 里的原始字符串，坏数据一律当空。 */
export function parsePositions(raw: string | null): PositionMap {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: PositionMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const rec = v as Partial<ReadingPosition>
      if (typeof rec.top !== 'number' || !Number.isFinite(rec.top)) continue
      out[k] = {
        top: rec.top,
        length: typeof rec.length === 'number' && Number.isFinite(rec.length) ? rec.length : 0,
        at: typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}
