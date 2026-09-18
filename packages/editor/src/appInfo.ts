// 外部应用的显示名 / 图标：壳侧 `app_info` 的查询与缓存。
//
// 为什么要单独一个模块：显示名有两个来源——路径基名（同步就得）和 exe 的
// **产品名**（壳异步查得，更准：`NoteFast.exe` → 「NoteFast」而不是「notefast」）。
// 设置页与文件菜单都要这个名字，两处各自查必然不一致（用户实测：设置里是
// NoteFast、菜单里是 notefast）。这里让它们共用一份缓存：
//   - 设置页用异步的 appInfoFor() 换图标与真名；
//   - 文件菜单标签是同步渲染的，用 resolvedAppName() 读**已经查到的**真名，
//     没查到就回退到路径基名（appDisplayName）。
// 启动时与设置变更时预热当前应用，菜单展开时就已拿到真名。

import { appInfo, type ExternalAppInfo } from '@lector/shell-web'
import { appDisplayName } from '@lector/core'

const resolved = new Map<string, ExternalAppInfo | null>()
const names = new Map<string, string>()
const pending = new Map<string, Promise<ExternalAppInfo | null>>()
const listeners = new Set<() => void>()

/**
 * 查询外部应用信息（带缓存，同一个路径只问壳一次）。纯装饰性：失败返回 null，
 * 调用方用路径基名兜底，不为装饰打断界面。
 */
export function appInfoFor(path: string): Promise<ExternalAppInfo | null> {
  if (!path) return Promise.resolve(null)
  const done = resolved.get(path)
  if (done !== undefined) return Promise.resolve(done)
  const inflight = pending.get(path)
  if (inflight) return inflight
  const p = appInfo(path)
    .then((info) => {
      resolved.set(path, info)
      if (info?.name) names.set(path, info.name)
      for (const fn of listeners) fn()
      return info
    })
    .catch(() => {
      resolved.set(path, null)
      return null
    })
    .finally(() => pending.delete(path))
  pending.set(path, p)
  return p
}

/**
 * 同步的展示名：优先壳里查到的真名，否则回退到路径基名（去可执行扩展名）。
 * 菜单标签这种同步上下文只能走这里——所以启动时要先预热当前应用。
 */
export function resolvedAppName(path: string): string {
  return names.get(path) ?? appDisplayName(path)
}

/** 真名到达时通知（用于需要就地更新的界面；菜单每次展开会重新取，一般不必订阅）。 */
export function onAppInfoResolved(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
