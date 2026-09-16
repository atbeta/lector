// mermaid 用户配置：解析与合并。
//
// 这两步是纯函数，单独钉住：它们决定「用户写的那份 JSON 到底怎么进 mermaid」，
// 而配置错了在界面上只表现为「图没变」或「图变回默认色」——不测就只能靠肉眼。
import { describe, expect, test } from 'bun:test'
import { mergeMermaidConfig, nextUserConfig, parseMermaidConfig } from '../src/mermaid.ts'

describe('parseMermaidConfig', () => {
  test('空配置是合法的「没有配置」，不是错误', () => {
    expect(parseMermaidConfig('')).toEqual({ config: null, error: null })
    expect(parseMermaidConfig('   \n ')).toEqual({ config: null, error: null })
  })

  test('对象透传，缩进与换行不影响结果', () => {
    const a = parseMermaidConfig('{"theme":"neutral"}')
    const b = parseMermaidConfig('{\n  "theme": "neutral"\n}')
    expect(a.config).toEqual({ theme: 'neutral' })
    expect(b.config).toEqual(a.config)
  })

  test('非法 JSON 报错但不抛——用户是在边打边看，敲到一半必然不合法', () => {
    const r = parseMermaidConfig('{"theme": ')
    expect(r.config).toBeNull()
    expect(r.error).toBeTruthy()
    expect(parseMermaidConfig('nope').error).toBeTruthy()
  })

  test('合法但不是对象：明确拒绝', () => {
    // 一段 JSON 数组或数字对 mermaid 没有意义，静默不生效比报错更糟
    for (const bad of ['[]', '123', '"x"', 'null', 'true']) {
      const r = parseMermaidConfig(bad)
      expect(r.config).toBeNull()
      expect(r.error).toBeTruthy()
    }
  })
})

describe('mergeMermaidConfig', () => {
  const base = {
    theme: 'default',
    securityLevel: 'strict',
    themeVariables: { lineColor: 'gray', primaryColor: 'muted', fontSize: '16px' },
    flowchart: { curve: 'linear', htmlLabels: true },
  }

  test('逐层合并：只改一个键，其余保留', () => {
    const out = mergeMermaidConfig(base, { themeVariables: { lineColor: 'red' } })
    expect(out.themeVariables).toEqual({ lineColor: 'red', primaryColor: 'muted', fontSize: '16px' })
    // 没提到的分支原样保留
    expect(out.flowchart).toEqual({ curve: 'linear', htmlLabels: true })
    expect(out.theme).toBe('default')
  })

  test('整份替换不是逐层覆盖：嵌套的非对象值直接胜出', () => {
    const out = mergeMermaidConfig(base, { flowchart: { curve: 'basis' } })
    // flowchart 是对象 → 逐层合并，htmlLabels 还在
    expect(out.flowchart).toEqual({ curve: 'basis', htmlLabels: true })
    const arr = mergeMermaidConfig(base, { themeVariables: ['x'] as unknown as Record<string, unknown> })
    // 数组不是普通对象 → 后者胜（不合并成怪物）
    expect(arr.themeVariables).toEqual(['x'])
  })

  test('数组与标量按后者胜，不做元素级合并', () => {
    const out = mergeMermaidConfig({ secure: ['a', 'b'] }, { secure: ['c'] })
    expect(out.secure).toEqual(['c'])
  })

  test('不修改入参（base 是每次现算的默认配置，被改坏会影响后续所有渲染）', () => {
    const baseCopy = JSON.parse(JSON.stringify(base))
    mergeMermaidConfig(base, { themeVariables: { lineColor: 'red' }, theme: 'dark' })
    expect(base).toEqual(baseCopy)
  })

  test('空用户配置 = 原样返回默认', () => {
    expect(mergeMermaidConfig(base, {})).toEqual(base)
  })

  test('secure keys 一律忽略：这几个键决定「图里能不能跑脚本」，不是主题的事', () => {
    const out = mergeMermaidConfig(base, {
      securityLevel: 'loose',
      startOnLoad: true,
      maxTextSize: 99999999,
      maxEdges: 99999,
      suppressErrorRendering: false,
      theme: 'forest',
    })
    // 默认值原样保留
    expect(out.securityLevel).toBe('strict')
    expect(out.startOnLoad).toBeUndefined()
    expect(out.maxTextSize).toBeUndefined()
    expect(out.maxEdges).toBeUndefined()
    expect(out.suppressErrorRendering).toBeUndefined()
    // 同一份配置里合法的键照常生效——剥的是那几个键，不是整份配置
    expect(out.theme).toBe('forest')
  })
})

describe('nextUserConfig（哪种输入该生效）', () => {
  const empty = { config: null, signature: '' }
  const withPrev = { config: { lineColor: 'red' } as Record<string, unknown>, signature: '{"lineColor":"red"}' }

  test('合法对象生效，指纹按重新序列化的结果算（改缩进不算改配置）', () => {
    const a = nextUserConfig('{"theme":"forest"}', empty)
    const b = nextUserConfig('{\n  "theme": "forest"\n}', empty)
    expect(a.config).toEqual({ theme: 'forest' })
    expect(a.signature).toBe(b.signature)
  })

  test('清空输入框 = 回到默认：指纹必须跟着清掉', () => {
    // 这条是回归：曾经「空」被当成「解析失败」处理，于是清空后沿用旧配置，
    // 表现为「清掉了但图没变」，而且指纹没变所以连重画都不会触发。
    const cleared = nextUserConfig('', withPrev)
    expect(cleared.config).toBeNull()
    expect(cleared.signature).toBe('')
    const alsoBlank = nextUserConfig('   \n', withPrev)
    expect(alsoBlank.signature).toBe('')
  })

  test('解析失败才沿用上一份能用的（边打边看，敲到一半必然不合法）', () => {
    expect(nextUserConfig('{"a": ', withPrev)).toEqual(withPrev)
    expect(nextUserConfig('nope', withPrev)).toEqual(withPrev)
  })

  test('从坏配置改成空：仍然回到默认（坏的不算"能用的"）', () => {
    const bad = nextUserConfig('{"a": ', empty)
    expect(bad).toEqual(empty)
    expect(nextUserConfig('', bad).signature).toBe('')
  })
})
