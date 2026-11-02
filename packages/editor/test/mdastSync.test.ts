import { expect, test } from 'bun:test'
import { mdastForEditedBlock, mdastNeedsReparse, parsedSource } from '../src/mdastSync.ts'

test('原文没变就不用重解析', () => {
  const parsed = new Map<string, string>()
  const from = parsedSource(parsed, 'b', '原文')
  expect(mdastNeedsReparse(from, '原文')).toBe(false)
})

test('加了字再删回原文：dirty 已是 false，mdast 仍然过期', () => {
  const parsed = new Map<string, string>()
  const id = 'b'
  const disk = '原文'
  let raw = disk

  // 打字前记住解析来源，再改 raw。失焦时 dirty，要重解析。
  const addedFrom = parsedSource(parsed, id, raw)
  raw = '原文增补'
  const dirtyAfterAdd = raw !== disk
  expect(dirtyAfterAdd).toBe(true)
  expect(mdastNeedsReparse(addedFrom, raw)).toBe(true)
  parsed.set(id, raw)

  // 再删回去。记录不能被「已经改回原文的 raw」盖掉，否则会误判成不用解析。
  const revertedFrom = parsedSource(parsed, id, raw)
  raw = disk
  const dirtyAfterRevert = raw !== disk
  expect(dirtyAfterRevert).toBe(false)
  expect(revertedFrom).toBe('原文增补')
  expect(mdastNeedsReparse(revertedFrom, raw)).toBe(true)
})

test('还没记下解析来源时必须重解析', () => {
  expect(mdastNeedsReparse(undefined, '原文')).toBe(true)
})

test('details 整段重解析仍是源码降级，内部 markdown 不拆成普通块', () => {
  const text = '<details>\n<summary>标题</summary>\n\n- 甲\n- 乙\n\n</details>'
  const next = mdastForEditedBlock(text)
  expect(next.kind).toBe('html')
  expect(next.mdast).toEqual({ type: 'html', value: text })
})

test('普通段落重解析仍是段落', () => {
  const next = mdastForEditedBlock('第二段。')
  expect(next.kind).toBe('paragraph')
  expect((next.mdast as { type?: string }).type).toBe('paragraph')
})
