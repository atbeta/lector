#!/usr/bin/env bash
set -euo pipefail

# 组装拖拽安装式 DMG（Lector.app + Applications 快捷方式）。
# 用法：./tools/make-macos-dmg.sh <Lector.app> <输出.dmg>
# DMG 内的 .app 应已公证 + 钉章；DMG 本身还要再公证（Gatekeeper 查最外层容器）。
# 不走 Finder 摆盘：CI 无 GUI 会话，布局脚本只会空转。

APP="${1:?用法: make-macos-dmg.sh <app路径> <dmg路径>}"
OUT="${2:?用法: make-macos-dmg.sh <app路径> <dmg路径>}"
VOLNAME="Lector"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
echo "dmg → $OUT"
