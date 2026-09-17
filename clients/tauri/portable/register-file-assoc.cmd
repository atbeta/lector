@echo off
setlocal
rem ============================================================
rem  Lector 便携版 —— 注册 .md 文件关联
rem  双击运行即可：自动探测本目录，无需改任何路径。
rem  只写当前用户注册表（HKCU），不需要管理员权限。
rem  卸载关联请运行 unregister-file-assoc.cmd。
rem  编码注意：仓库里本文件是 UTF-8，但打包时 CI 会转成 GBK(936)——
rem  cmd 按系统码页（中文 Windows = CP936）解析脚本，UTF-8 中文会被
rem  拆断成碎片命令；不要在仓库里直接存 GBK，也不要加 chcp 65001。
rem ============================================================

set "EXE=%~dp0lector.exe"
set "ICON=%~dp0resources\markdown.ico"

if not exist "%EXE%" (
  echo [错误] 未找到 %EXE%
  echo 请把本脚本放在 lector.exe 同目录下再运行。
  pause
  exit /b 1
)
if not exist "%ICON%" (
  echo [提示] 未找到 %ICON%，关联仍会创建，但 .md 图标用 exe 默认图标。
)

rem 独立 ProgID：与 NSIS 安装器的 Markdown 类键互不干扰，谁后注册谁生效
reg add "HKCU\Software\Classes\Lector.Portable.Markdown" /ve /d "Markdown 文档 (Lector 便携版)" /f >nul
reg add "HKCU\Software\Classes\Lector.Portable.Markdown\DefaultIcon" /ve /d "%ICON%" /f >nul
reg add "HKCU\Software\Classes\Lector.Portable.Markdown\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul

rem .md 指向便携版 ProgID
reg add "HKCU\Software\Classes\.md" /ve /d "Lector.Portable.Markdown" /f >nul

echo [完成] .md 已关联到本目录的 Lector 便携版。
echo 若资源管理器图标未立即刷新，按 F5 或重新打开文件夹窗口。
pause
