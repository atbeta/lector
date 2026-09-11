; Lector — NSIS 安装钩子。
;
; Tauri 官方不支持给「已关联的文件类型」指定图标：bundle.fileAssociations 只写
; ProgID 与 OpenWithProgids，不写 DefaultIcon，资源管理器于是退化用通用图标。
; 这里在 POSTINSTALL 补 HKCR\<ProgID>\DefaultIcon，指向本应用 exe 的图标索引 0。
;
; 本文件的 ProgID 列表来自 tauri.conf.json 的 bundle.fileAssociations；
; CI 有一步 hash 比对，改了一处必须同步另一处（见 .github/workflows/build-windows.yml）。
;
; 注意：installMode=currentUser 时写 HKCU 即可，无需管理员权限。

!macro LectorRegisterDefaultIcon
  ReadRegStr $R0 SHCTX "Software\Classes\com.lector.reader.md\shell\open\command" ""
  ${If} $R0 == ""
    ; 不是本安装器写的 ProgID（可能被别家接管），不抢。
    DetailPrint "Lector: md ProgID not owned by this install, skipping icon"
  ${Else}
    WriteRegStr SHCTX "Software\Classes\com.lector.reader.md\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
    WriteRegStr SHCTX "Software\Classes\com.lector.reader.markdown\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
    WriteRegStr SHCTX "Software\Classes\com.lector.reader.txt\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
    ; 通知 shell 刷新图标缓存，装完立刻见效，不必重启资源管理器。
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend

!macro LectorUnregisterDefaultIcon
  ; 只删图标值，不动 ProgID 本身：ProgID 的增删由安装器自己的关联逻辑负责。
  DeleteRegValue SHCTX "Software\Classes\com.lector.reader.md\DefaultIcon" ""
  DeleteRegValue SHCTX "Software\Classes\com.lector.reader.markdown\DefaultIcon" ""
  DeleteRegValue SHCTX "Software\Classes\com.lector.reader.txt\DefaultIcon" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro LectorRegisterDefaultIcon
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LectorUnregisterDefaultIcon
!macroend
