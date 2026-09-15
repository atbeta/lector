// 必须在 prismjs 之前求值：把 Prism.manual 置真，关掉它自带的「扫描 DOM 自动高亮」。
//
// 两个原因：
//  1. 我们是自己调 Prism.highlight()，自动扫描多余；
//  2. 自动扫描那一段直接引用 document，在没有 DOM 的环境（bun test）会在 import
//     时抛 ReferenceError。置 manual 后那段被跳过，模块可在任何环境加载。
//
// 静态 import 按出现顺序求值，所以这个文件在 highlight.ts 里必须排在最前。

const g = globalThis as { Prism?: { manual?: boolean } }
g.Prism = { ...(g.Prism ?? {}), manual: true }
