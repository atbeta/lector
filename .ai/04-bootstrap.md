# Lector 第一周

仓库 `~/Projects/lector` 已建仓（骨架 + 本文档）。按这个开。

## 已锁定（不要再选型）

- 独立仓库，不挂 NoteFast workspace
- 文件是真相；无文档管理；**无应用内 Tab，单进程多窗口**
- 内核 = **源码切片 IR**；CM 只编焦点块（裸 CM，无 replace widget）
- 解析 = micromark / mdast；保存默认不整篇 stringify
- 壳 = **Tauri 2 双端**（macOS + Windows）；Win 关联图标走 NSIS 注册表补丁
- 运行时 = Bun + TypeScript
- v1 语法：CommonMark + frontmatter；GFM 表/任务列表可以同一周后半加，不要挡「打开-保存恒等」

## 仓库形态（已建）

```
lector/
  AGENTS.md                 # 已按最终决策写好
  .ai/                      # 立项包（本目录）
  package.json              # bun workspaces: packages/*
  packages/core/
  packages/editor/
  packages/shell-web/
  clients/tauri/
  testdata/                 # 真实 md 夹具（Typora 导出、GFM 表、中文、CRLF）
```

## Day 1 — core 黄金测试

先写测试再写解析。夹具至少：

1. 纯中文三段 + 空行  
2. 带 `# 标题` 与 ATX  
3. frontmatter  
4. CRLF 文件  
5. 未改保存后 `readFile` 字节相等（含末尾换行）  
6. 只改第二段，第一/三段字节不变  

实现：`parseBlocks(text) → BlockView[]` + `serialize(blocks)`。  
命令：`bun test`。没有 UI 也可以交。

## Day 2 — editor 最小 IR

- Vite：未聚焦预览、点击聚焦挂 CM  
- 点另一块失焦并标 dirty  
- 浏览器里 `input type=file` 打开本地 md，下载保存（验证手感）  
- 先不要壳

## Day 3 — 图与相对路径

- 预览解析相对图（先用 object URL + 用户选目录，或 Vite 开发时写死）  
- 粘贴截图 → 写 `images/`（浏览器里可先 skip，留给壳）

## Day 4 — Tauri 壳（macOS 先行）

- 文件关联、Open/Save、把路径和文件内容交给 web  
- 双击 md：窗口起来就 open，无首页  
- 单进程多窗口：路径表去重，重复打开聚焦已有窗口  
- 对标成功标准：已在跑时再双击

## Day 5 — Windows 验证

- 同样文件关联 + NSIS `DefaultIcon` 注册表补丁  
- argv / 单实例：第二个实例把路径丢给第一个进程，由它开新窗口，不要双开抢文件

## 稍后（不要第一周膨胀）

- GFM 表（预览 + 焦点块当源码编，不必上表格控件）  
- 任务列表点击  
- 大纲浮窗（阅读优先，第二周最优先项）  
- 查找  
- 「送到 NoteFast」  
- 主题深色  
- 导出 PDF

## 质量门

- `bun test` + `bun run typecheck`  
- 源码注释中文；**用户文案**一开始就 zh-CN / en 两套，避免以后补  
- 不提交 testdata 里别人的私密笔记

## 风险（开工就盯）

| 风险 | 对策 |
|---|---|
| mdast `position` 盖不全（漏空行） | 黄金测试 + 空隙合成 `unknown` 块 |
| 列表当一块太大，CM 里体验差 | 先整表一块；用户抱怨再拆 item |
| WebView 自定义协议与拖图 | 第一周就做 baseDir 沙箱，不要用 `file://` 裸开 |
| 壳比编辑器还重 | 禁止拷 NoteFast engine |
| 想加侧栏文件夹 / Tab / AI 功能 | 打回 brief（SoloMD 殷鉴） |
