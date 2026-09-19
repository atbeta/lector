// 全局错误兜底。
//
// 为什么需要：漏网的 Promise 拒绝 / 未捕获异常以前只会进 WebView 控制台，
// 而 release 下没人看那个控制台——用户只说「点了没反应」，开发者手里什么都没有。
// 这里把两类全局错误写进壳的文件日志（经 webLog → 壳 web_log → 日志文件），
// 并给一次可见提示，让早期用户至少知道「可以去看日志」。
//
// 只记 message + stack，不碰文档正文——日志不是内容备份。
import { webLog } from '@lector/shell-web'
import { t } from './i18n.ts'
import { showToast } from './feedback.ts'

/** 单条上限：栈可能极长，不能让一次崩溃把日志文件灌满。 */
export const MAX_REPORT_CHARS = 2000

/** 把任意 reject 原因整理成可读文本（纯函数，便于测试）。 */
export function describeReason(reason: unknown): string {
  if (reason instanceof Error) {
    const stack = reason.stack ? `\n${reason.stack}` : ''
    return `${reason.name}: ${reason.message}${stack}`
  }
  if (typeof reason === 'string') return reason
  try {
    return JSON.stringify(reason) ?? String(reason)
  } catch {
    // 循环引用等：JSON.stringify 会抛，退回最朴素的形式
    return String(reason)
  }
}

/** 截断超长文本（纯函数，便于测试）。 */
export function clampReport(text: string, max = MAX_REPORT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 注册全局兜底。每类错误只提示一次——首个错误之后的连锁失败再弹会淹没界面；
 * 日志仍逐条记，提示只是「出事了」的可见信号。
 */
export function installGlobalErrorReporting(): void {
  let notified = false
  const report = (message: string) => {
    void webLog('error', clampReport(message))
    if (notified) return
    notified = true
    showToast(t('errorToast'))
  }

  window.addEventListener('error', (e) => {
    // 资源加载失败（img/script）也会走到这里，此时 message 为空——补个占位，
    // 否则日志里只有坐标没有原因。
    const message = e.message || '(no message)'
    report(`[web] error: ${message} @ ${e.filename}:${e.lineno}:${e.colno}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    report(`[web] unhandledrejection: ${describeReason(e.reason)}`)
  })
}
