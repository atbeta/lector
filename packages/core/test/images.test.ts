import { describe, expect, test } from 'bun:test'
import { listImages, replaceImageUrl } from '../src/images.ts'

describe('listImages', () => {
  test('单张行内图片：url/alt/位置都对', () => {
    const raw = '看这张 ![封面](images/a.png) 图'
    const imgs = listImages(raw)
    expect(imgs.length).toBe(1)
    expect(imgs[0]!.url).toBe('images/a.png')
    expect(imgs[0]!.alt).toBe('封面')
    expect(raw.slice(imgs[0]!.start, imgs[0]!.end)).toBe('![封面](images/a.png)')
  })

  test('多张按文档顺序，且跨越列表/表格', () => {
    const raw = [
      '![一](1.png)',
      '',
      '- 项',
      '  - ![二](2.png)',
      '',
      '| 列 |',
      '| --- |',
      '| ![三](3.png) |',
    ].join('\n')
    const imgs = listImages(raw)
    expect(imgs.map((i) => i.alt)).toEqual(['一', '二', '三'])
    expect(imgs.map((i) => i.url)).toEqual(['1.png', '2.png', '3.png'])
  })

  test('title 单独取出；空串与无图片返回空表', () => {
    expect(listImages('![a](x.png "标题")')[0]!.title).toBe('标题')
    expect(listImages('没有图片的段落')).toEqual([])
    expect(listImages('')).toEqual([])
  })
})

describe('replaceImageUrl', () => {
  test('只换目标 URL，其余字节不变', () => {
    const raw = '前 ![a](old.png) 后 ![b](keep.png)'
    const out = replaceImageUrl(raw, 0, 'new.png')
    expect(out).toBe('前 ![a](new.png) 后 ![b](keep.png)')
  })

  test('保留 alt 与 title', () => {
    expect(replaceImageUrl('![封面](old.png "题")', 0, 'new.png')).toBe('![封面](new.png "题")')
  })

  test('编号越界 / 畸形返回 null', () => {
    expect(replaceImageUrl('![a](x.png)', 3, 'y.png')).toBeNull()
    expect(replaceImageUrl('无图', 0, 'y.png')).toBeNull()
  })

  test('尖括号 URL 连括号一起换掉', () => {
    expect(replaceImageUrl('![a](<old path.png>)', 0, 'new.png')).toBe('![a](new.png)')
  })

  test('换完能被重新解析出目标 url（roundtrip）', () => {
    const raw = '![a](1.png) 与 ![b](2.png)'
    const out = replaceImageUrl(raw, 1, 'https://cdn/x.png')!
    const imgs = listImages(out)
    expect(imgs[0]!.url).toBe('1.png')
    expect(imgs[1]!.url).toBe('https://cdn/x.png')
  })
})
