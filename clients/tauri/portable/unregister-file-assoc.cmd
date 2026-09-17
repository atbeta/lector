@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  Lector 便携版 —— 移除 .md 文件关联
rem  只清理当前用户注册表（HKCU），不需要管理员权限。
rem ============================================================

rem 仅当 .md 仍指向便携版 ProgID 时才摘除，避免误伤用户后来设置的其它程序
set "CUR="
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Classes\.md" /ve 2^>nul') do set "CUR=%%b"
if /i "%CUR%"=="Lector.Portable.Markdown" (
  reg delete "HKCU\Software\Classes\.md" /ve /f >nul
) else (
  echo [提示] .md 当前指向 "%CUR%"，不是 Lector 便携版，未改动。
)

reg delete "HKCU\Software\Classes\Lector.Portable.Markdown" /f >nul 2>&1

echo [完成] 已移除 Lector 便携版的 .md 关联。
pause
