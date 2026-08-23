# @lector/editor

IR 视图：未聚焦块自绘预览 DOM，聚焦块挂裸 CodeMirror 6 编该块源码。可用 Vite 单独打开验证手感（`input type=file` 打开本地 md + 下载保存），不依赖壳。

## 红线

- 禁止整页 CM 装饰；CM 实例只编焦点块，禁 `Decoration.replace` widget
- 预览不执行 md 内 HTML/script；HTML 块显示为源码
- 用户文案 i18n（zh-CN + en）从第一天做
