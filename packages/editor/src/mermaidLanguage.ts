// mermaid 的 CodeMirror StreamLanguage。
//
// 聚焦块编辑的是整段 raw（含 ``` 围栏），所以分词器要认得围栏行：
// 围栏行给 meta 色，围栏内按 mermaid 语法上色（图类型声明、关键字、
// 箭头记号、注释、字符串、数字）。轻量手写而不引语法包——mermaid
// 没有现成的 lezer 实现，完整文法对「顺手能改」是过度工程。

import { StreamLanguage, type StringStream } from '@codemirror/language'

/** 图类型声明：只在行首认，避免把普通词误染。 */
const DIAGRAM_TYPES = new Set([
  'flowchart',
  'graph',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'quadrantChart',
  'gitGraph',
  'requirementDiagram',
  'sankey',
  'xychart',
  'xychart-beta',
  'block-beta',
  'architecture',
  'C4Context',
  'info',
])

const KEYWORDS = new Set([
  'participant',
  'actor',
  'activate',
  'deactivate',
  'note',
  'over',
  'right',
  'left',
  'of',
  'loop',
  'alt',
  'else',
  'opt',
  'par',
  'and',
  'critical',
  'option',
  'break',
  'rect',
  'autonumber',
  'subgraph',
  'end',
  'direction',
  'classDef',
  'class',
  'style',
  'click',
  'call',
  'href',
  'linkStyle',
  'state',
  'as',
  'transition',
  'TB',
  'TD',
  'BT',
  'RL',
  'LR',
  'title',
  'accTitle',
  'accDescr',
])

// 连线记号，长记号在前（否则 --> 会吃掉 -->> 的前缀）
const ARROW_RE = /-->>|-->|->>|-\.->|-\.-|===|==>|---|->|--|==|-/

function token(stream: StringStream): string | null {
  // 围栏行（```mermaid / ```）：整行 meta
  if (stream.sol() && stream.match(/\s*```/)) {
    stream.skipToEnd()
    return 'meta'
  }
  // 注释 %% 到行尾（含 %%{init}%% 指令行，注释色可接受）
  if (stream.match('%%')) {
    stream.skipToEnd()
    return 'comment'
  }
  // 字符串
  const quote = stream.peek()
  if (quote === '"' || quote === "'") {
    stream.next()
    while (!stream.eol()) {
      if (stream.next() === quote) break
    }
    return 'string'
  }
  // 连线记号
  if (stream.match(ARROW_RE)) return 'operator'
  // 词：行首的图类型声明 > 关键字 > 数字 > 朴素
  const atLineStart = stream.sol()
  if (stream.match(/[\w][\w-]*/)) {
    // 本次 token 调用还没消费过别的字符，current() 就是刚匹配的词
    const w = stream.current()
    if (atLineStart && DIAGRAM_TYPES.has(w)) return 'meta'
    if (KEYWORDS.has(w)) return 'keyword'
    if (/^\d+$/.test(w)) return 'number'
    return null
  }
  stream.next()
  return null
}

export const mermaidLanguage = StreamLanguage.define({
  token,
  // 让 CM 的切换注释命令知道 mermaid 的行注释
  languageData: { commentTokens: { line: '%%' } },
})
