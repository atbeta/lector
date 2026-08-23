# @lector/core

SourceDocument、parse、serialize、BlockView。**无 DOM**，必须能在 `bun test` 里跑。

## 开发顺序

按 `.ai/04-bootstrap.md` Day 1：先写黄金测试（切片无缝覆盖、未编辑保存恒等、脏一块只动一块、CRLF/BOM 还原），再实现 `parseBlocks` / `serialize`。

## 红线

- 禁止整篇 `remark-stringify` 作为默认保存路径
- `position` 缺失的节点并入 `unknown` 块，不许丢内容
