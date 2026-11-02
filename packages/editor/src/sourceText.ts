import { Text } from '@codemirror/state'

/**
 * CM 装载文档时的切行口径（@codemirror/state 的 DefaultSplit）。
 *
 * CM 里的文档只有 LF 形态：磁盘原文的 CRLF / 裸 CR 在装载时就被规整掉了。
 * 所以比「用户改过没有」要按内容比，不能直接比字符串——
 * 否则一个没动过的 CRLF 文件会被判成已改（反方向的误判同样要命）。
 */
export function toCmText(text: string): Text {
  return Text.of(text.split(/\r\n?|\n/))
}
