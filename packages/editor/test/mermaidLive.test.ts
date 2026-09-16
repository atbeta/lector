import { describe, expect, test } from 'bun:test'
import { extractMermaidSource } from '../src/mermaidLive.ts'

describe('extractMermaidSource', () => {
  test('剥掉首尾围栏', () => {
    expect(extractMermaidSource('```mermaid\nflowchart TD\n A-->B\n```')).toBe(
      'flowchart TD\n A-->B',
    )
  })

  test('编辑中间态缺收尾围栏也能剥', () => {
    expect(extractMermaidSource('```mermaid\nflowchart TD\n A-->B')).toBe('flowchart TD\n A-->B')
  })

  test('无围栏原样返回', () => {
    expect(extractMermaidSource('pie\n  "a": 1')).toBe('pie\n  "a": 1')
  })

  test('只剥最后一行的收尾围栏，内部含 ``` 的行保留', () => {
    const raw = '```mermaid\nflowchart TD\n A["```"]\n```'
    expect(extractMermaidSource(raw)).toBe('flowchart TD\n A["```"]')
  })

  test('围栏带语言后缀（```mermaid extra）也认', () => {
    expect(extractMermaidSource('```mermaid x\ngraph LR\n```')).toBe('graph LR')
  })
})
