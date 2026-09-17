# 接力开发计划（给其他 Agent）

> 状态（2026-09-18）：**本文档已完成**。它是第一周的开工计划，保留作历史记录；
> 实际交付已远超第一周范围（见根 `README.md` 与 [07-acceptance.md](./07-acceptance.md)）。
> 下面的步骤与验收不再作为待办。

仓库已建仓并完成立项。接手的 Agent 按本文档开工。

## 开工前必读（顺序）

1. 根目录 `AGENTS.md` —— 红线与工程纪律
2. `.ai/01-brief.md` —— 产品边界、窗口模型、成功标准
3. `.ai/03-architecture.md` —— 推荐架构、核心类型、明确拒绝的架构
4. `.ai/02-research.md` —— 选型依据（被挑战时来这里找论据）
5. `.ai/04-bootstrap.md` —— 第一周按天拆分

## 开工顺序（不可乱）

| 序 | 任务 | 验收 |
|---|---|---|
| 1 | `bun install` + 根 `tsconfig.json`（strict） | `bun run typecheck` 通过（空实现也算） |
| 2 | `packages/core`：Day 1 黄金测试**先行**（6 条夹具） | 测试红着提交 |
| 3 | `packages/core`：`parseBlocks` + `serialize` 实现 | 黄金测试全绿 |
| 4 | `packages/editor`：Vite 最小 IR（预览/聚焦切换/失焦标脏） | 浏览器内打开-编辑-下载闭环 |
| 5 | `packages/editor`：相对图片预览 | 夹具图可见 |
| 6 | `clients/tauri`：壳（Day 4 macOS → Day 5 Windows） | 双击 md 开窗口见正文 |

每步完成跑 `bun test && bun run typecheck`。测试不绿不进入下一步。

## 关键实现提示

- **core 第一原则**：切片必须无缝覆盖全文（`blocks[i].end === blocks[i+1].start`）；空隙合成 `unknown` 块，丢空行 = 保真破产。
- **依赖钉版本**：micromark / mdast-util-from-markdown / micromark-extension-frontmatter 写死确切版本，不用 `^`。
- **editor 的 CM 实例**：每聚焦块新建、失焦销毁，不池化不复用（先求对，再求省）。
- **壳 IPC 契约**：先定 `open(path) / read(path) / write(path, text, mtimeMs) / watch(path)` 四个消息形状，写进本目录新文档 `.ai/06-ipc-contract.md` 再写代码。
- **i18n**：第一个文案出现时就建 `zh-CN.json` / `en.json` 结构，不允许裸字面量活到第二天。

## 不要做的事（会被打回）

- 加 Tab、侧栏文件树、标签、搜索跨文件、任何 AI 功能
- 引入 ProseMirror / Milkdown / Vditor / Electron
- 从 NoteFast monorepo 链 workspace 依赖
- 整篇 `remark-stringify` 当默认保存

## 完成后回报

Day 1–3 完成后：贴 `bun test` 输出 + 夹具清单。Day 4–5 完成后：贴双击打开耗时（已在跑 / 冷启动各一次）。
