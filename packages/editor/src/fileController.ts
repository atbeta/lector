import { applyEncoding, appDisplayName } from '@lector/core'
import {
  detectEnv,
  pickAndRead,
  pickSavePath,
  read,
  save,
  watch,
  type SaveResult,
  bindDocument,
  recentList,
  recentClear,
  onOpen,
  onFileChanged,
  onCloseRequest,
  openWithApp,
  openWithDefault,
  revealInFolder,
} from '@lector/shell-web'
import { isAbsolutePath, baseName } from './paths.ts'
import { getSettings, setSettings } from './settings.ts'
import { pushRecentApp } from '@lector/core'
import { showToast } from './feedback.ts'
import { chooseConflict, confirmDiscard, showDialog } from './dialog.ts'
import { renderEmptyState as renderEmptyStateView, renderLoadingState as renderLoadingStateView } from './loadState.ts'
import { t } from './i18n.ts'
import type { DocumentEditor } from './documentEditor.ts'
import type { EditorChrome } from './editorChrome.ts'
import type { RecoveryController } from './recoveryController.ts'

const defaultFileIO = {
  detectEnv,
  pickAndRead,
  pickSavePath,
  read,
  save,
  watch,
  bindDocument,
  recentList,
  recentClear,
  onOpen,
  onFileChanged,
  onCloseRequest,
  openWithApp,
  openWithDefault,
  revealInFolder,
}
export type FileIO = typeof defaultFileIO

interface FileControllerDeps {
  editor: Pick<DocumentEditor, 'getSession' | 'getNormalizedText' | 'retargetSource' | 'markSaved' | 'resetDocument' | 'clearBlocks' | 'clearBlockElements' | 'markDirty' | 'loadSession' | 'acceptDiskMtime'>
  chrome: Pick<EditorChrome, 'elements' | 'setDocPresent'>
  recovery: Pick<RecoveryController, 'inspect' | 'hideRecoveryBar'>
  io?: FileIO
}

export function createFileController({ editor, chrome, recovery, io = defaultFileIO }: FileControllerDeps) {
  /**
   * 磁盘版本与本地改动冲突时的提示条（浮在顶栏下方，不插进正文流）。
   *
   * 两个动作对应两种意图，措辞要把后果说清楚：
   *   - 「加载磁盘版本」= 放弃我的未保存改动
   *   - 「保留我的改动」= 之后保存会覆盖磁盘上的版本
   * 不提供第三种「关掉不管」：那条路通向"下次保存时才发现冲突"，
   * 而那时用户已经想不起自己改了什么。
   */
  let externalBar: HTMLElement | null = null

  /**
   * 保存进行中：这段时间里 watcher 报的变更一律是我们自己写的，必须忽略。
   *
   * 曾出过的 bug：`write_file` 落盘后 watcher 立刻回调，而此刻 `persistToDisk`
   * 还停在 `await` 里、`dirty` 仍是 true，于是走进"外部修改 + 有未保存改动"分支，
   * 保存完还把那条提示条留在屏幕上——用户看到的是"明明是我自己保存的，怎么说被别人改了"。
   * dirty 与 mtime 的判据都晚于这次回调，只有这个窗口能挡住它。
   */
  let saveInFlight = false

  function hideExternalBar(): void {
    externalBar?.remove()
    externalBar = null
  }

  function showExternalChangeBar(mtimeMs: number): void {
    if (externalBar) return
    const bar = document.createElement('div')
    bar.className = 'recover-bar'
    bar.setAttribute('role', 'alert')
    const text = document.createElement('span')
    text.className = 'recover-text'
    text.textContent = t('externalChangedDirty')
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.className = 'btn btn-primary'
    reload.textContent = t('externalReload')
    reload.addEventListener('click', async () => {
      hideExternalBar()
      await reloadFromDisk()
      showToast(t('externalReloaded'))
    })
    const keep = document.createElement('button')
    keep.type = 'button'
    keep.className = 'btn'
    keep.textContent = t('externalKeep')
    keep.addEventListener('click', () => {
      // 采纳磁盘的 mtime 作为新基准：等于告诉保存流程「这个磁盘版本我知道」，
      // 于是保存会覆盖它而不是再弹一次冲突确认——用户刚做过这个选择。
      editor.acceptDiskMtime(mtimeMs)
      hideExternalBar()
    })
    bar.append(text, reload, keep)
    document.body.appendChild(bar)
    externalBar = bar
  }

  function loadSession(path: string, raw: string, mtimeMs = Date.now(), byteLen?: number) {
    editor.loadSession(path, raw, mtimeMs, byteLen)
    // 这份文件上次有没有留下未保存的草稿？有就提示，但**不自动改内容**——
    // 打开一个文件却看到和磁盘不一样的内容，是最不该发生的意外。
    // （大文件不会留草稿：recovery.ts 对 >512KB 的内容直接跳过。）
    recovery.inspect(path, raw)
    // 通知外框复位（顶栏的滚动分隔影）
    window.dispatchEvent(new Event('lector:doc-changed'))
    if (io.detectEnv() === 'shell') {
      void io.bindDocument(path)
      void io.watch(path)
    }
  }

  async function confirmOpenIfDirty(): Promise<boolean> {
    if (!editor.getSession().dirty) return true
    return confirmDiscard()
  }

  /**
   * 「打开文件」：**先选文件，再动当前文档**。
   *
   * 旧顺序是「先清屏 → 选文件」：点开对话框的瞬间当前文档就没了（标题变回 Lector、
   * 正文清空、侧栏下线），取消选择也回不来——脏文档还在这之前被确认丢弃过，
   * 于是用户看到的是「我什么都没选，文章没了」。这是数据丢失级的顺序错误，不是观感问题。
   *
   * 对话框本身是模态的，它就是「正在打开」的反馈，不需要先把屏幕擦干净来示意。
   * 选到文件之后才问「要不要丢弃未保存的修改」，被拒绝就原样留在原文档上。
   */
  let openInFlight = false
  async function openFromShellOrDialog() {
    // 双击/连点不该弹出两个对话框
    if (openInFlight) return
    openInFlight = true
    try {
      let picked: Awaited<ReturnType<typeof io.pickAndRead>> = null
      try {
        picked = await io.pickAndRead()
      } catch (err) {
        // 读失败：当前文档一个字都不动，只报一次
        console.error('[lector] open failed', err)
        showToast(`${t('openFailed')}：${String(err)}`)
        return
      }
      // 取消选择：原样退出。不换标题、不清正文、不出空态
      if (!picked) return
      // 这时才轮到「未保存的修改」——新文件已经拿在手里，用户知道自己要换掉什么
      if (!(await confirmOpenIfDirty())) return
      loadSession(picked.path, picked.content, picked.mtime_ms)
    } finally {
      openInFlight = false
    }
  }

    async function persistToDisk(force = false): Promise<boolean> {
      if (!editor.getSession().source) return false
    // 新建文档还没有磁盘身份（路径不是绝对路径，见 newDocument）→ 先另存为。
    // 不能在这里调 saveAsFlow()：它在预览环境会回头调 persistToDisk，直接成环。
    // 用"路径是否绝对"作判据：打开过的文件一定是绝对路径，新建文档用显示名占位。
    // 绝对路径的判定要含 UNC（`\\server\share`）——否则打开网络共享上的文件时，
    // 每次保存都会被当成"未命名"反复弹另存为。
    if (io.detectEnv() === 'shell' && !isAbsolutePath(editor.getSession().source!.path)) {
      let target: string | null = null
      try {
        target = await io.pickSavePath(editor.getSession().source!.path || t('untitledName'))
      } catch (err) {
        console.error('[lector] save-as dialog', err)
        return false
      }
      if (!target) return false
      // 换成真实路径后，下面走的是同一条写盘路径（含冲突检测），不另开分支
      editor.retargetSource(target)
      void io.bindDocument(target)
      void io.watch(target)
    }
    const normalized = editor.getNormalizedText()
    const finalText = applyEncoding(editor.getSession().source!, normalized)
    let res: SaveResult
    saveInFlight = true
    try {
      res = await io.save(editor.getSession().source!.path, finalText, editor.getSession().source!.mtimeMs, force)
    } catch (err) {
      // 壳「权限拒绝 / 磁盘满 / 文件被占用」等错误不包不能废——
      // 错误字符串原样透传过来（shell-web ADR-1 语义：reject 原样抛），会进 toString。
      // 这里只在原来吞掉 void() 路径上加一层人看的提示。
      console.error('[lector] save failed', err)
      showToast(`${t('saveFailed')}：${String(err)}`)
      return false
    } finally {
      saveInFlight = false
    }
    if (res.conflict) {
      const choice = await chooseConflict()
      if (choice === 'reload') {
        await reloadFromDisk()
        return false
      }
      if (choice === 'overwrite') return persistToDisk(true)
      return false
    }
    if (!res.ok) {
      showToast(t('saveFailed'))
      return false
    }
    // 写盘成功：把自己刚触发的「外部修改」提示条收掉（若是误报，它本就不该在）
    hideExternalBar()
    editor.markSaved(normalized, res.current_mtime_ms)
    showToast(t('saved'))
    return true
    }

    /**
    * 新建文档：与记事本一致，**在同一窗口换一份空文档**。
    * 红线不允许应用内 Tab，也不必开新窗口——"新建"对用户就是"我要开始写一份新的"。
    *
    * 有未保存改动时给三选一（保存 / 放弃 / 取消）：放弃不可撤销，不该一键吞掉。
    * 空文档后续由 loadSession 的空文档分支接管（进编辑档 + 光标入位）。
    */
  async function newDocument(): Promise<void> {
    if (editor.getSession().dirty) {
      const choice = await showDialog({
        title: t('newUnsavedTitle'),
        body: t('newUnsavedBody'),
        actions: [
          { id: 'cancel', label: t('cancelAction') },
          { id: 'discard', label: t('discardAction'), danger: true },
          { id: 'save', label: t('saveAction'), primary: true },
        ],
      })
      if (choice === null || choice === 'cancel') return
      // 保存失败（用户取消另存为 / 写盘出错）就不要继续替换文档
      if (choice === 'save' && !(await persistToDisk())) return
    }
    // 传显示名当占位路径：标题栏因此显示"未命名"，
    // 而 persistToDisk 看到"路径非绝对"就知道该弹另存为。
    loadSession(t('untitledName'), '')
  }

  /**
   * 关闭当前文档：回到首页（空态）。
   *
   * 为什么是「关文档」而不是「关窗口」：首页是「最近打开」的**唯一入口**——
   * 不关掉文档就再也翻不到它。窗口留着，用户可以接着从最近列表开下一篇；
   * 这与单文档多窗口的约定也一致（一个窗口一份文档，关掉只是腾空它）。
   * 有未保存改动先问（保存 / 放弃 / 取消），与新建同一套语义。
   */
  async function closeFile(): Promise<void> {
    if (!editor.getSession().source) return
    if (editor.getSession().dirty) {
      const choice = await showDialog({
        title: t('newUnsavedTitle'),
        body: t('closeUnsavedBody'),
        actions: [
          { id: 'cancel', label: t('cancelAction') },
          { id: 'discard', label: t('discardAction'), danger: true },
          { id: 'save', label: t('saveAction'), primary: true },
        ],
      })
      if (choice === null || choice === 'cancel') return
      if (choice === 'save' && !(await persistToDisk())) return
    }
    // 清掉文档身份与编辑器载体：之后所有按「有没有文档」分支的逻辑都回到空态，
    // 壳侧的绑定/监听因 Session 无 source 而自然失效；下次打开同一文件由
    // 壳的 open_path 重新聚焦本窗口（registry 里仍记着这个 label）。
    editor.resetDocument()
    hideExternalBar()
    recovery.hideRecoveryBar()
    renderEmptyState()
    // 必须放在 renderEmptyState 之后：它清空 blocks，状态行才会回到「没有文档」
    // 的空表；放前面读到的还是上一篇的字数。
    editor.markDirty()
  }

  /** 另存为：选新路径 → 强制写（系统对话框已确认覆盖）→ 会话切到新文件。 */
  async function saveAsFlow() {
    if (!editor.getSession().source) return
    if (io.detectEnv() !== 'shell') {
      await persistToDisk()
      return
    }
    // 同上：未编辑写原文，避免 CM 的换行规整污染字节
    const normalized = editor.getNormalizedText()
    const finalText = applyEncoding(editor.getSession().source!, normalized)
    const defaultName = baseName(editor.getSession().source!.path) || 'untitled.md'
    let target: string | null = null
    try {
      target = await io.pickSavePath(defaultName)
    } catch (err) {
      console.error('[lector] save-as dialog', err)
      return
    }
    if (!target) return
    saveInFlight = true
    try {
      const res = await io.save(target, finalText, 0, true)
      if (!res.ok) {
        showToast(t('saveFailed'))
        return
      }
      hideExternalBar()
      loadSession(target, finalText, res.current_mtime_ms ?? Date.now())
      showToast(t('saved'))
    } catch (err) {
      console.error('[lector] save-as failed', err)
      showToast(`${t('saveFailed')}：${String(err)}`)
    } finally {
      saveInFlight = false
    }
  }

  /** 当前文档的磁盘绝对路径；未命名占位路径返回 null（壳侧同样会拒绝）。 */
  function currentDiskPath(): string | null {
    const p = editor.getSession().source?.path
    if (!p) return null
    return isAbsolutePath(p) ? p : null
  }

  /** 菜单标签：配了外部应用就写明是哪个（剥掉 .exe 等扩展名），没配才说"默认应用"（标签不能撒谎）。 */
  function openWithLabel(): string {
    const app = getSettings().externalApp.trim()
    return app ? t('menuOpenWith', { app: appDisplayName(app) }) : t('menuOpenDefault')
  }

  /**
   * 用外部应用打开当前文件。
   * 配了「其他应用」就用它，没配就走系统默认——**菜单标签必须跟着变**
   * （见 documentMenus）：用户得知道会打开哪个程序，否则点了才知道是错的。
   */
  async function openDefaultApp(): Promise<void> {
    const p = currentDiskPath()
    if (!p) {
      showToast(t('menuNeedDiskFile'))
      return
    }
    const s = getSettings()
    const app = s.externalApp.trim()
    try {
      if (app) {
        await io.openWithApp(p, app, s.externalAppArgs)
        // 真正用过就把它提到"最近用过"最前：这个列表的语义是"用过"而不是"选过"——
        // 用几次才知道哪个顺手。纯顺序变化，界面不需要动。
        setSettings({ ...s, externalAppRecent: pushRecentApp(s.externalAppRecent, app) })
      } else await io.openWithDefault(p)
    } catch {
      showToast(t('openFailed'))
    }
  }

  /** 在系统文件管理器中显示当前文件。 */
  async function revealCurrent(): Promise<void> {
    const p = currentDiskPath()
    if (!p) {
      showToast(t('menuNeedDiskFile'))
      return
    }
    try {
      await io.revealInFolder(p)
    } catch {
      showToast(t('openFailed'))
    }
  }

  async function reloadFromDisk() {
  const src = editor.getSession().source
  if (!src) return
  // 有未保存改动先确认：手动重载的语义是「以磁盘为准」，但静默丢改动
  // 连外部变更监听都不如——那边脏了还会给选择。
  if (editor.getSession().dirty) {
  const choice = await showDialog({
  title: t('reloadConfirmTitle'),
  body: t('reloadConfirmBody'),
  actions: [
  { id: 'cancel', label: t('cancelAction') },
  { id: 'reload', label: t('reloadAction'), danger: true },
  ],
  })
  if (choice !== 'reload') return
  }
  try {
  const res = await io.read(src.path)
  loadSession(res.path, res.content, res.mtime_ms)
  // 成功也要说一声：磁盘没变化时重载后内容一模一样，没有反馈就像没响应。
  showToast(t('reloadedFromDisk'))
  } catch {
  showToast(t('reloadFailed'))
  }
  }

  function bindShellEvents() {
    if (io.detectEnv() !== 'shell') return
    // 壳把最终路径交给 web（双击 / 单实例转发）
    void io.onOpen(async (e) => {
      // 与「打开文件」同一条顺序：先把新文件读进来，再问要不要丢弃当前文档。
      // 反过来（先确认、后读取）在读取失败时会让用户白丢一次修改决定。
      let res: Awaited<ReturnType<typeof io.read>>
      try {
        res = await io.read(e.path)
      } catch {
        showToast(t('readFailed'))
        return
      }
      if (!(await confirmOpenIfDirty())) return
      loadSession(res.path, res.content, res.mtime_ms)
    })
    // 外部变更（watch 回调）
    //
    // 三种情况分开处理，因为「代价」完全不同：
    //   1. 自己刚保存完 —— 忽略。保存会让文件变化，watcher 也会响，
    //      没有 mtime 判据的话每次 ⌘S 都会触发一次假的「外部修改」。
    //   2. 正文干净 —— 直接换成磁盘版本**并说明**。可丢的东西为零，
    //      静默重载唯一的毛病是用户看到内容自己变了却不知为何。
    //   3. 正文有未保存改动 —— 绝不自动覆盖，给可操作的选择：
    //      这是唯一会丢东西的分支，一句 toast 既没说清丢了什么，
    //      也没给"我要哪个版本"的入口。
    void io.onFileChanged(async (e) => {
      const src = editor.getSession().source
      if (!src || e.path !== src.path) return
      // 自己刚写完盘引起的 watcher 回调：dirty/mtime 都还没更新，只有这个窗口能识别
      if (saveInFlight) return
      if (e.mtime_ms <= (src.mtimeMs ?? 0)) return
      if (!editor.getSession().dirty) {
        await reloadFromDisk()
        showToast(t('externalReloaded'))
        return
      }
      showExternalChangeBar(e.mtime_ms)
    })
  }

  // 关闭脏文档前的确认。壳里必须走 Tauri 的 onCloseRequested（窗口 X / 自绘关闭键 /
  // macOS 的 ⌘W 都经它）；beforeunload 在 WebView2 下拦不住，脏文档会被静默关掉。
  // 浏览器预览没有壳，退回 beforeunload 的浏览器原生提示（仅预览用）。
  function bindCloseGuard(): void {
    if (io.detectEnv() === 'shell') {
      void io.onCloseRequest(async () => {
        if (!getSettings().closeAlwaysConfirmsChanges || !editor.getSession().dirty || !editor.getSession().source) {
          return 'close'
        }
        const choice = await showDialog({
          title: t('newUnsavedTitle'),
          body: t('closeUnsavedBody'),
          actions: [
            { id: 'cancel', label: t('cancelAction') },
            { id: 'discard', label: t('discardAction'), danger: true },
            { id: 'save', label: t('saveAction'), primary: true },
          ],
        })
        if (choice === 'save') return (await persistToDisk()) ? 'close' : 'stay'
        if (choice === 'discard') return 'close'
        return 'stay'
      })
    } else {
      window.addEventListener('beforeunload', (e) => {
        if (getSettings().closeAlwaysConfirmsChanges && editor.getSession().dirty && editor.getSession().source) {
          e.preventDefault()
          e.returnValue = ''
        }
      })
    }
  }

  // 加载 / 空态已抽到 loadState.ts。这里提供 main.ts 的 facade,把所有
  // 用到的依赖(全局引用 + 打开回调)一次性注入,避免 loadState 知道 main.ts 的
  // 内部状态,反过来也避免主流程再散落两份 empty/loading 模板。
  const loadStateDeps = {
    contentEl: chrome.elements.contentEl,
    fileNameEl: chrome.elements.fileNameEl,
    blocksEl: { clear: () => editor.clearBlockElements() },
    onOpen: () => void openFromShellOrDialog(),
    onNew: () => void newDocument(),
    recentFiles: [] as string[],
    onOpenRecent: (path: string) => openRecent(path),
    onClearRecent: () => clearRecentList(),
  }

  /**
   * 清空「最近打开」：**不弹确认**。
   *
   * 确认框是给「不可逆且有代价」的动作（放弃未保存改动、覆盖冲突版本）准备的。
   * 最近列表只是个便利缓存：清掉后照样能从文件对话框再打开、重新出现，
   * 代价几乎为零——为它挡一道确认，是拿用户的每一次点击换一个不存在的风险。
   * 清完给一句 toast 说明结果就够了。
   */
  async function clearRecentList(): Promise<void> {
    await io.recentClear()
    loadStateDeps.recentFiles = []
    // 空态还在屏幕上就把列表就地拿掉，不重新拉取——刚清完又异步塞回来会显得「没清掉」。
    if (editor.getSession().blocks.length === 0) renderEmptyStateView(loadStateDeps)
    showToast(t('recentCleared'))
  }

  /**
   * 从「最近打开」里开一个：路径已经知道，所以只差读取与绑定。
   * 与 pickAndRead 之后那段走同一条路（读 → 绑定窗口 → 监听 → loadSession），
   * 不另开一条平行的打开路径——两条路径早晚会在脏检查、监听、标题上走出差异。
   */
  async function openRecent(path: string): Promise<void> {
    if (!(await confirmOpenIfDirty())) return
    try {
      const res = await io.read(path)
      void io.bindDocument(res.path)
      void io.watch(res.path)
      loadSession(res.path, res.content, res.mtime_ms)
    } catch (err) {
      // 文件被移动/删除是「最近打开」最常见的失败——必须说出来，不能静默什么都不发生
      console.error('[lector] open recent', err)
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
      showToast(t('openRecentFailed', { name }))
    }
  }

  function renderEmptyState(): void {
    editor.clearBlocks()
    chrome.setDocPresent(false)
    renderEmptyStateView(loadStateDeps)
    // 最近打开是异步来的（壳里读文件、预览里恒空），先渲染空态再补列表：
    // 首屏不该为一个次要区块等一次 IPC。
    void io.recentList().then((paths) => {
      // 期间可能已经打开了别的文件——那就别再往已经消失的空态里塞列表
      if (editor.getSession().blocks.length > 0) return
      loadStateDeps.recentFiles = paths.slice(0, 3)
      renderEmptyStateView(loadStateDeps)
    })
  }
  function renderLoadingState(): void {
    editor.clearBlocks()
    chrome.setDocPresent(false)
    renderLoadingStateView(loadStateDeps)
  }

  return {
    loadSession,
    openFromShellOrDialog,
    persistToDisk,
    newDocument,
    closeFile,
    saveAsFlow,
    currentDiskPath,
    openDefaultApp,
    openWithLabel,
    revealCurrent,
    reloadFromDisk,
    renderEmptyState,
    renderLoadingState,
    bindShellEvents,
    bindCloseGuard,
  }
}

export type FileController = ReturnType<typeof createFileController>
