# Lector — 立项包

调研日期：2026-08-23（当日完成竞品复核与决策收敛）
状态（2026-09-18）：方案已落地。core 切片/序列化、editor IR、Tauri 双端壳、设置/图片/导出等均已实现，
Windows 已发到 v0.28.1，并完成 0.28.x 一轮重构与加固（platform / io 拆域、快捷键判定表）。
本目录保留为立项记录；成功标准 1/2/4 的验收证据与遗留项见 [07-acceptance.md](./07-acceptance.md)。
定位：阅读优先的**纯 Markdown 编辑器**；不做文档管理；日后可作为 NoteFast 配套（「送到收集箱」），**不嵌 NoteFast engine**。

| 文档 | 内容 |
|---|---|
| [01-brief.md](./01-brief.md) | 产品边界、窗口模型、成功标准、非目标 |
| [02-research.md](./02-research.md) | 竞品与内核调研（IR / CM / PM / Vditor / MarkText / SoloMD） |
| [03-architecture.md](./03-architecture.md) | **推荐方案**：源码切片 IR + 块内裸 CM + Tauri 双端薄壳 |
| [04-bootstrap.md](./04-bootstrap.md) | 第一周怎么开、决策已锁定项 |
| [05-handoff.md](./05-handoff.md) | 开工顺序（历史计划，已完成） |
| [06-ipc-contract.md](./06-ipc-contract.md) | 壳 ↔ Web 的 IPC 契约（随代码对齐） |
| [07-acceptance.md](./07-acceptance.md) | v1 成功标准的验收现状与手动清单 |

AGENTS.md 草稿已转正，见仓库根目录 `AGENTS.md`（含最终决策：Tauri 双端、无 Tab 多窗口）。

**一句话方案：** 磁盘上的 `.md` 是唯一真相。打开后按块做即时渲染（IR）；未改过的块保存时原样写回（切片保真）；正在编辑的那一块用裸 CodeMirror 6 当源码框；壳是 Tauri 2，一个文档一个窗口。
