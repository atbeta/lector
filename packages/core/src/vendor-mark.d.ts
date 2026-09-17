// micromark-extension-mark 没带类型声明（无 .d.ts），按运行时实际形态给最小
// 声明；用法处的收窄见 parse.ts。
declare module 'micromark-extension-mark' {
  export const pandocMark: unknown
}
