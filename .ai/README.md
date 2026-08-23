# Lector — 立项包

调研日期：2026-08-23（当日完成竞品复核与决策收敛）
状态：方案已收敛，仓库骨架已建，待 Day 1 开工
定位：阅读优先的**纯 Markdown 编辑器**；不做文档管理；日后可作为 NoteFast 配套（「送到收集箱」），**不嵌 NoteFast engine**。

| 文档 | 内容 |
|---|---|
| [01-brief.md](./01-brief.md) | 产品边界、窗口模型、成功标准、非目标 |
| [02-research.md](./02-research.md) | 竞品与内核调研（IR / CM / PM / Vditor / MarkText / SoloMD） |
| [03-architecture.md](./03-architecture.md) | **推荐方案**：源码切片 IR + 块内裸 CM + Tauri 双端薄壳 |
| [04-bootstrap.md](./04-bootstrap.md) | 第一周怎么开、决策已锁定项 |

AGENTS.md 草稿已转正，见仓库根目录 `AGENTS.md`（含最终决策：Tauri 双端、无 Tab 多窗口）。

**一句话方案：** 磁盘上的 `.md` 是唯一真相。打开后按块做即时渲染（IR）；未改过的块保存时原样写回（切片保真）；正在编辑的那一块用裸 CodeMirror 6 当源码框；壳是 Tauri 2，一个文档一个窗口。
