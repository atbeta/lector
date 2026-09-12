// 轻量代码高亮。
//
// 为什么自己写而不引 Shiki / highlight.js：这是阅读器的预览层，不是 IDE。
// Shiki 会带进整套 TextMate 语法与主题（几百 KB），highlight.js 也要几十 KB，
// 而我们要的只是「关键词、字符串、注释、数字」四类离线可辨。
// 复用 tokens 里已有的 --code-* 四个颜色，换主题自动跟着走。
//
// 原则：宁可少上色，也不要上错色。识别不了就当普通文本——高亮错了比不高亮更难读。

const KEYWORDS: Record<string, string[]> = {
  ts: ['const','let','var','function','return','if','else','for','while','class','interface','type','import','export','from','new','await','async','try','catch','finally','throw','typeof','instanceof','extends','implements','public','private','readonly','enum','as','in','of','this','super','null','undefined','true','false','void','yield','static','satisfies','declare'],
  js: ['const','let','var','function','return','if','else','for','while','class','import','export','from','new','await','async','try','catch','finally','throw','typeof','instanceof','extends','this','super','null','undefined','true','false','void','yield','static'],
  rust: ['fn','let','mut','pub','use','mod','struct','enum','impl','trait','for','while','loop','if','else','match','return','self','Self','crate','super','as','const','static','ref','move','async','await','dyn','where','unsafe','in','true','false','Some','None','Ok','Err','String','Vec'],
  python: ['def','class','return','if','elif','else','for','while','import','from','as','with','try','except','finally','raise','lambda','yield','async','await','pass','break','continue','global','nonlocal','assert','del','in','is','not','and','or','None','True','False','self'],
  py: ['def','class','return','if','elif','else','for','while','import','from','as','with','try','except','finally','raise','lambda','yield','async','await','pass','break','continue','global','nonlocal','assert','del','in','is','not','and','or','None','True','False','self'],
  sh: ['if','then','else','elif','fi','for','in','do','done','while','case','esac','function','return','export','local','echo','cd','set','unset'],
  bash: ['if','then','else','elif','fi','for','in','do','done','while','case','esac','function','return','export','local','echo','cd','set','unset'],
  sql: ['select','from','where','insert','into','values','update','set','delete','create','table','drop','alter','join','left','right','inner','outer','on','group','by','order','having','limit','offset','as','and','or','not','null','primary','key','index','distinct','union'],
  css: ['important','media','supports','keyframes','import','from','to'],
  go: ['func','package','import','var','const','type','struct','interface','map','chan','go','defer','return','if','else','for','range','switch','case','default','break','continue','nil','true','false'],
  json: ['true','false','null'],
  yaml: ['true','false','null','yes','no'],
  yml: ['true','false','null','yes','no'],
}

/** 语言别名 → 关键字表 */
function keywordsFor(lang: string): string[] {
  const key = lang.toLowerCase().replace(/^language-/, '')
  return KEYWORDS[key] ?? []
}

/** 反引号是模板字符串的只有这几个语言；其它语言里它是普通字符。 */
const BACKTICK_LANGS = new Set(['ts', 'js', 'tsx', 'jsx', 'typescript', 'javascript'])

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c)
}

/**
 * 高亮一段代码，返回 HTML（已转义）。
 * 只做「整词」级切分，不做 AST——阅读器的代码块不需要更精确。
 */
export function highlightCode(code: string, lang: string): string {
  const key = lang.toLowerCase().replace(/^language-/, '')
  const words = keywordsFor(lang)
  const backticks = BACKTICK_LANGS.has(key)
  // 不认识的语言一律原样（仅转义）：宁可不上色，也不要上错色。
  // 认字的语言大多是弱类型脚本，没有关键字表时按「有注释/字符串」猜反而会误伤正文。
  if (words.length === 0) return esc(code)
  const keywords = new Set(words)
  const out: string[] = []
  let i = 0
  while (i < code.length) {
    const rest = code.slice(i)
    // 行注释：// 或 # 或 --（SQL）
    const lineComment = rest.match(/^(\/\/|#(?![0-9a-fA-F]{3,8}\b)|--\s).*?(?=\n|$)/)
    if (lineComment) {
      out.push(`<span class="tok-comment">${esc(lineComment[0])}</span>`)
      i += lineComment[0].length
      continue
    }
    const blockComment = rest.match(/^\/\*[\s\S]*?\*\//)
    if (blockComment) {
      out.push(`<span class="tok-comment">${esc(blockComment[0])}</span>`)
      i += blockComment[0].length
      continue
    }
    const str = rest.match(
      backticks
        ? /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/
        : /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/,
    )
    if (str) {
      out.push(`<span class="tok-string">${esc(str[0])}</span>`)
      i += str[0].length
      continue
    }
    const num = rest.match(/^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/)
    if (num && !/[\w$]/.test(code[i - 1] ?? '')) {
      out.push(`<span class="tok-number">${esc(num[0])}</span>`)
      i += num[0].length
      continue
    }
    // 整词：前后不能是标识符字符，否则 `constant` 里的 `const` 会被染色
    const word = rest.match(/^[A-Za-z_$][\w$]*/)
    if (word) {
      const w = word[0]
      const prevOk = !/[\w$.]/.test(code[i - 1] ?? '')
      const nextOk = !/[\w$]/.test(code[i + w.length] ?? '')
      out.push(keywords.has(w) && prevOk && nextOk ? `<span class="tok-keyword">${esc(w)}</span>` : esc(w))
      i += w.length
      continue
    }
    // 其它字符原样搬（转义后）
    out.push(esc(code[i]!))
    i += 1
  }
  return out.join('')
}
