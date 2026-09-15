// 代码高亮：Prism（core + 按需注册的语言）。
//
// 为什么改成引库：自写的 tokenizer 只覆盖 12 种语言，别名全靠一张手维护的表，
// 结果最常用的 ```typescript / ```javascript 反而是白的（只有 ```ts / ```js 有色）。
// 阅读器预览层确实不需要 Shiki 的 TextMate 级保真，但「常用语言 + 别名归一」
// 这件事 Prism 用几十 KB 就做全了，自维护不划算。
//
// 颜色仍走我们自己的 --code-* 四个 token（映射见 app.css），**不套 Prism 主题**——
// 这样换阅读主题时代码配色跟着一起变。

import './prism-setup.ts'
import Prism from 'prismjs'

// ⚠ 导入顺序=依赖顺序：组件文件会 Prism.languages.extend('c', …) / clone('typescript')，
// 基语言没先加载就会抛。`prismjs` 入口已带 markup / css / clike / javascript。
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-csharp'
import 'prismjs/components/prism-objectivec'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-kotlin'
import 'prismjs/components/prism-scala'
import 'prismjs/components/prism-groovy'
import 'prismjs/components/prism-dart'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-swift'
import 'prismjs/components/prism-zig'
import 'prismjs/components/prism-opencl'
import 'prismjs/components/prism-glsl'
import 'prismjs/components/prism-hlsl'
import 'prismjs/components/prism-wgsl'
import 'prismjs/components/prism-wasm'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-ini'
import 'prismjs/components/prism-csv'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-diff'
import 'prismjs/components/prism-latex'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-powershell'
import 'prismjs/components/prism-batch'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-ruby'
import 'prismjs/components/prism-perl'
import 'prismjs/components/prism-lua'
import 'prismjs/components/prism-r'
import 'prismjs/components/prism-julia'
import 'prismjs/components/prism-matlab'
import 'prismjs/components/prism-markup-templating'
import 'prismjs/components/prism-php'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-plsql'
import 'prismjs/components/prism-graphql'
import 'prismjs/components/prism-protobuf'
import 'prismjs/components/prism-regex'
import 'prismjs/components/prism-http'
import 'prismjs/components/prism-log'
import 'prismjs/components/prism-docker'
import 'prismjs/components/prism-nginx'
import 'prismjs/components/prism-makefile'
import 'prismjs/components/prism-cmake'
// 半导体 / EDA 日用：HDL、脚本（Tcl）、汇编、GPU/加速器、老牌科学计算
import 'prismjs/components/prism-verilog'
import 'prismjs/components/prism-vhdl'
import 'prismjs/components/prism-tcl'
import 'prismjs/components/prism-nasm'
import 'prismjs/components/prism-armasm'
import 'prismjs/components/prism-llvm'
import 'prismjs/components/prism-fortran'

/** 围栏别名 → Prism 语言键。用户写什么都别让它变成「有标签没颜色」。 */
const ALIAS: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  rs: 'rust',
  py: 'python',
  py3: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  kt: 'kotlin',
  rb: 'ruby',
  pl: 'perl',
  md: 'markdown',
  ps1: 'powershell',
  pwsh: 'powershell',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  objc: 'objectivec',
  'objective-c': 'objectivec',
  m: 'matlab',
  vhd: 'vhdl',
  sv: 'verilog',
  systemverilog: 'verilog',
  asm: 'nasm',
  x86: 'nasm',
  arm: 'armasm',
  tclsh: 'tcl',
  tex: 'latex',
  dockerfile: 'docker',
  make: 'makefile',
  mk: 'makefile',
  gql: 'graphql',
  proto: 'protobuf',
  shader: 'glsl',
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c)
}

function normalizeLang(lang: string): string {
  const k = (lang || '').trim().toLowerCase().replace(/^language-/, '')
  return ALIAS[k] ?? k
}

// 同一块代码会随重渲染（切档、编辑落块）反复走高亮，结果缓存下来不重复算。
// 颜色由 CSS 变量决定，所以换主题不需要清缓存。
const cache = new Map<string, string>()
const CACHE_MAX = 400

/**
 * 高亮一段代码，返回 HTML（已转义）。
 * 不认识的语言原样转义——宁可不上色，也不要上错色。
 */
export function highlightCode(code: string, lang: string): string {
  const key = normalizeLang(lang)
  const grammar = Prism.languages[key]
  if (!grammar) return esc(code)
  const cacheKey = `${key}\u0000${code}`
  const hit = cache.get(cacheKey)
  if (hit !== undefined) return hit
  let html: string
  try {
    html = Prism.highlight(code, grammar, key)
  } catch {
    // Prism 极端边界（语法文件本身有问题）也不该把预览打崩
    return esc(code)
  }
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(cacheKey, html)
  return html
}
