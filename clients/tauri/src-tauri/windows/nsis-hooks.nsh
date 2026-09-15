; Lector — NSIS 安装钩子。
;
; 这里只做一件官方不支持的事：给已关联的文件类型写默认图标。
;
; Tauri 的 bundle.fileAssociations 会建类键（这里即 "Markdown"，路径
; HKCU\Software\Classes\Markdown，installMode=currentUser 时 hive 由 SHCTX 决定），
; 也建了 DefaultIcon 子键，但默认值是空的——资源管理器于是退化用白纸图标，
; .md 跟「未知类型」长得一模一样。
;
; 图标刻意不用应用图标：应用图标是满幅的深色圆角方块，当文档图标用太重，
; 在一堆文件里也认不出「这是一份文档」。改用随包发的 markdown.ico
; （浅色纸张 + 折角 + Lector 标记），由 bundle.resources 落到安装目录。
;
; ⚠ 三处必须一致，CI 会静态比对（.github/workflows/ci.yml）：
;     1. 这里的类名 == tauri.conf.json 的 fileAssociations[].name
;     2. 这里的 dest == tauri.conf.json 的 bundle.resources 的落点
;     3. 被指向的图标文件真的在仓库里
;   另外 build-windows.yml 会真装一遍，断言 DefaultIcon 指向这个 .ico 且文件存在。
!define LECTOR_FILE_CLASS "Markdown"
; 落点相对 $INSTDIR；与 bundle.resources 的 "icons/markdown.ico" -> "resources/markdown.ico" 对应
!define LECTOR_FILE_ICON "$INSTDIR\resources\markdown.ico"

!macro LectorRegisterDefaultIcon
  ReadRegStr $R0 SHCTX "Software\Classes\${LECTOR_FILE_CLASS}\shell\open\command" ""
  ${If} $R0 == ""
    ; 类键不是本安装器写的（可能被别家接管），不抢。
    DetailPrint "Lector: ${LECTOR_FILE_CLASS} not owned by this install, skipping icon"
  ${Else}
    ${If} ${FileExists} "${LECTOR_FILE_ICON}"
      WriteRegStr SHCTX "Software\Classes\${LECTOR_FILE_CLASS}\DefaultIcon" "" "${LECTOR_FILE_ICON},0"
      DetailPrint "Lector: ${LECTOR_FILE_CLASS} icon -> ${LECTOR_FILE_ICON}"
    ${Else}
      ; 资源没落到位：退回 exe 自带的应用图标。难看，但总好过白纸。
      WriteRegStr SHCTX "Software\Classes\${LECTOR_FILE_CLASS}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
      DetailPrint "Lector: ${LECTOR_FILE_ICON} missing, falling back to the exe icon"
    ${EndIf}
    ; 通知 shell 刷新图标缓存，装完立刻见效，不必重启资源管理器。
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend

!macro LectorUnregisterDefaultIcon
  ; 只删图标值，不动类键本身：类键与 .md 关联的增删由安装器自身的关联逻辑负责
  ; （markdown.ico 本身也由安装器按 resources 清单在卸载时删掉）。
  DeleteRegValue SHCTX "Software\Classes\${LECTOR_FILE_CLASS}\DefaultIcon" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro LectorRegisterDefaultIcon
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LectorUnregisterDefaultIcon
!macroend
