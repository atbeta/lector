Windows 版（x64）。装完即带 `.md` / `.markdown` / `.txt` 文件关联与图标。

- `Lector_<版本>_x64-setup.exe` —— 安装器，无需管理员权限，可静默安装（`/S`）
- `lector-portable.zip` —— 免安装，解压即用；内含 `.md` 图标与关联脚本，双击 `register-file-assoc.cmd` 即建立关联（`unregister-file-assoc.cmd` 取消）
- `SHA256SUMS.txt` —— 校验和，Windows 上核对：`certutil -hashfile <文件> SHA256`

macOS 版暂不提供：签名与公证还没做，先不发未签名的包。

文件是你的，编辑器不碰它：打开 = 读，保存 = 写回同一路径，没改过的段落字节级不变。
