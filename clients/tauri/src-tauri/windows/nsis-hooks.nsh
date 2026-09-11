; Lector — NSIS 安装钩子。
;
; Tauri 官方不支持给「已关联的文件类型」指定图标。bundle.fileAssociations 写的
; 类键用的是配置里的 name（这里即 "Markdown"），路径为
;   HKCU\Software\Classes\Markdown\...（installMode=currentUser 时，见 SHCTX）
; 它建了 DefaultIcon 子键但值是空的，资源管理器于是退化用白纸图标。
; 这里在 POSTINSTALL 补上 DefaultIcon 的默认值，指向本应用 exe 的图标索引 0。
;
; ⚠ 类名必须与 tauri.conf.json 的 bundle.fileAssociations[].name 一致。
;   CI（.github/workflows/build-windows.yml）会做比对，改一处必须改另一处；
;   并且有一次「静默安装 + 读注册表」的实测，写错类名会直接红。
!define LECTOR_FILE_CLASS "Markdown"

!macro LectorRegisterDefaultIcon
  ReadRegStr $R0 SHCTX "Software\Classes\${LECTOR_FILE_CLASS}\shell\open\command" ""
  ${If} $R0 == ""
    ; 类键不是本安装器写的（可能被别家接管），不抢。
    DetailPrint "Lector: ${LECTOR_FILE_CLASS} not owned by this install, skipping icon"
  ${Else}
    WriteRegStr SHCTX "Software\Classes\${LECTOR_FILE_CLASS}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
    ; 通知 shell 刷新图标缓存，装完立刻见效，不必重启资源管理器。
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend

!macro LectorUnregisterDefaultIcon
  ; 只删图标值，不动类键本身：类键与 .md 关联的增删由安装器自身的关联逻辑负责。
  DeleteRegValue SHCTX "Software\Classes\${LECTOR_FILE_CLASS}\DefaultIcon" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro LectorRegisterDefaultIcon
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LectorUnregisterDefaultIcon
!macroend
