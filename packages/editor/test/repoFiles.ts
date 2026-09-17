// 测试用的仓库遍历助手（不是测试文件：名字里没有 .test）。
//
// 有两条守卫要扫全仓库的源码（腐化字符、没人用的 i18n key），跳过清单与
// 扩展名清单只该有一份——两处各写一份，迟早一处漏了 node_modules 或改了目录结构。
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'

/** 仓库根：本文件在 packages/editor/test/ 下。 */
export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

const SKIP = /node_modules|[\\/]\.git|[\\/]target|[\\/]dist|[\\/]\.tmp|gen[\\/]schemas/

export function walkRepo(dir: string = REPO_ROOT, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (SKIP.test(p)) continue
    if (e.isDirectory()) walkRepo(p, out)
    else out.push(p)
  }
  return out
}

export function readText(file: string): string {
  return readFileSync(file, 'utf8')
}

/** 仓库内的相对路径，报错信息里更短也更好认。 */
export function relPath(file: string): string {
  return file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/')
}

/** 按扩展名剥掉注释（行注释 / 块注释 / CSS 块注释 / YAML `#`）。 */
export function stripComments(text: string, ext: string): string {
  if (ext === '.css') return text.replace(/\/\*[\s\S]*?\*\//g, ' ')
  if (ext === '.ts' || ext === '.mjs') {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  }
  if (ext === '.rs' || ext === '.nsh') {
    // Rust 的 // 与 ///；NSIS 的 ; 只出现在行首
    return text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ')
      .replace(/^[ \t]*;.*$/gm, ' ')
  }
  if (ext === '.yml') return text.replace(/^[ \t]*#.*$/gm, ' ')
  return text
}

/** 只看这些扩展名的源码（.json/.md 里的 U+FFFD 可能是有意为之的测试数据）。 */
export const SOURCE_EXTS = ['.ts', '.css', '.rs', '.html', '.mjs', '.nsh', '.yml']

export function ext(file: string): string {
  return extname(file)
}
