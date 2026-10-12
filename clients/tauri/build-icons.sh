#!/usr/bin/env bash
# 重新生成 src-tauri/icons/ 下的全部图标（仅 macOS）。
#
# 源稿（clients/tauri/ 下）：
#   app-icon.svg        满幅稿，32px 及以上 + 全部 PNG
#   app-icon-small.svg  16px 网格手摆像素稿，给 16/20/24（对比字形在 32px 以下会糊）
#   app-icon-macos.svg  内缩超椭圆 + 烘焙阴影，给 icon.icns
#   file-icon.svg / file-icon-32.svg / file-icon-small.svg  文档图标同理分档
#   Lector.icon/        Icon Composer 包，actool 编译成 Assets.car（macOS 26+ Liquid Glass）
#
# 依赖：rsvg-convert、magick、iconutil、xcrun actool（actool 需要完整 Xcode）。
set -euo pipefail

cd "$(dirname "$0")"
ICONS=src-tauri/icons

if [ "$(uname -s)" != "Darwin" ]; then
  echo "错误：本脚本只能在 macOS 上运行（iconutil / actool）" >&2
  exit 1
fi

for tool in rsvg-convert magick iconutil; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "错误：找不到 $tool" >&2
    exit 1
  fi
done
if ! xcrun --find actool >/dev/null 2>&1; then
  echo "错误：找不到 actool（需要完整 Xcode，仅有 CLT 不够）" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 每个尺寸直接从对应 SVG 渲，不让 magick 重采样
render() {
  rsvg-convert -w "$2" -h "$2" "$1" -o "$3"
}

# .ico 打包器：magick 写 ico 只会存 BMP 条目，体积虚胖；
# 改成把 rsvg 出的 PNG 字节原样内嵌（Vista+ 所有尺寸都支持 PNG 条目）。
cat > "$TMP/pack-ico.js" <<'EOF'
// 用法：bun pack-ico.js <out.ico> <a.png> [b.png ...]
import { readFileSync, writeFileSync } from 'node:fs';
const [out, ...files] = process.argv.slice(2);
const imgs = files.map((f) => readFileSync(f));
const dir = Buffer.alloc(6 + 16 * imgs.length);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type=icon
dir.writeUInt16LE(imgs.length, 4);
let off = dir.length;
imgs.forEach((img, i) => {
  // 宽高直接读 PNG IHDR（偏移 16/20，大端）
  const w = img.readUInt32BE(16);
  const h = img.readUInt32BE(20);
  const p = 6 + 16 * i;
  dir.writeUInt8(w >= 256 ? 0 : w, p); // 0 表示 256
  dir.writeUInt8(h >= 256 ? 0 : h, p + 1);
  dir.writeUInt8(0, p + 2); // colorCount
  dir.writeUInt8(0, p + 3); // reserved
  dir.writeUInt16LE(1, p + 4); // planes
  dir.writeUInt16LE(32, p + 6); // bitCount
  dir.writeUInt32LE(img.length, p + 8);
  dir.writeUInt32LE(off, p + 12);
  off += img.length;
});
writeFileSync(out, Buffer.concat([dir, ...imgs]));
EOF
pack_ico() {
  local out=$1
  shift
  bun "$TMP/pack-ico.js" "$out" "$@"
}

# ---------- icon.ico（应用图标） ----------
# 16/20/24 用手摆像素的小稿，其余用满幅稿
for s in 16 20 24; do
  render app-icon-small.svg "$s" "$TMP/app-$s.png"
done
for s in 32 48 64 256; do
  render app-icon.svg "$s" "$TMP/app-$s.png"
done
pack_ico "$ICONS/icon.ico" \
  "$TMP/app-16.png" "$TMP/app-20.png" "$TMP/app-24.png" \
  "$TMP/app-32.png" "$TMP/app-48.png" "$TMP/app-64.png" "$TMP/app-256.png"

# ---------- markdown.ico（关联文件图标） ----------
for s in 16 20 24; do
  render file-icon-small.svg "$s" "$TMP/file-$s.png"
done
render file-icon-32.svg 32 "$TMP/file-32.png"
for s in 48 64 256; do
  render file-icon.svg "$s" "$TMP/file-$s.png"
done
pack_ico "$ICONS/markdown.ico" \
  "$TMP/file-16.png" "$TMP/file-20.png" "$TMP/file-24.png" \
  "$TMP/file-32.png" "$TMP/file-48.png" "$TMP/file-64.png" "$TMP/file-256.png"

# ---------- 各档 PNG（全部从满幅稿渲，尺寸与现有一致） ----------
render app-icon.svg 32  "$ICONS/32x32.png"
render app-icon.svg 64  "$ICONS/64x64.png"
render app-icon.svg 128 "$ICONS/128x128.png"
render app-icon.svg 256 "$ICONS/128x128@2x.png"
render app-icon.svg 512 "$ICONS/icon.png"
render app-icon.svg 30  "$ICONS/Square30x30Logo.png"
render app-icon.svg 44  "$ICONS/Square44x44Logo.png"
render app-icon.svg 71  "$ICONS/Square71x71Logo.png"
render app-icon.svg 89  "$ICONS/Square89x89Logo.png"
render app-icon.svg 107 "$ICONS/Square107x107Logo.png"
render app-icon.svg 142 "$ICONS/Square142x142Logo.png"
render app-icon.svg 150 "$ICONS/Square150x150Logo.png"
render app-icon.svg 284 "$ICONS/Square284x284Logo.png"
render app-icon.svg 310 "$ICONS/Square310x310Logo.png"
render app-icon.svg 50  "$ICONS/StoreLogo.png"

# ---------- icon.icns（macOS 内缩稿） ----------
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
render app-icon-macos.svg 16   "$ICONSET/icon_16x16.png"
render app-icon-macos.svg 32   "$ICONSET/icon_16x16@2x.png"
render app-icon-macos.svg 32   "$ICONSET/icon_32x32.png"
render app-icon-macos.svg 64   "$ICONSET/icon_32x32@2x.png"
render app-icon-macos.svg 128  "$ICONSET/icon_128x128.png"
render app-icon-macos.svg 256  "$ICONSET/icon_128x128@2x.png"
render app-icon-macos.svg 256  "$ICONSET/icon_256x256.png"
render app-icon-macos.svg 512  "$ICONSET/icon_256x256@2x.png"
render app-icon-macos.svg 512  "$ICONSET/icon_512x512.png"
render app-icon-macos.svg 1024 "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$ICONS/icon.icns"

# ---------- Assets.car（macOS 26+ Liquid Glass，Icon Composer 包） ----------
# actool 要求输出目录预先存在
mkdir -p "$TMP/actool-out"
xcrun actool "$PWD/Lector.icon" \
  --compile "$TMP/actool-out" \
  --platform macosx \
  --minimum-deployment-target 10.15 \
  --target-device mac \
  --app-icon Lector \
  --output-partial-info-plist "$TMP/actool-out/partial.plist" \
  --warnings --errors
cp "$TMP/actool-out/Assets.car" "$ICONS/Assets.car"

echo "完成：$ICONS/ 已更新（icon.ico / markdown.ico / *.png / icon.icns / Assets.car）"
