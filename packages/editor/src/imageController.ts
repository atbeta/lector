import { imagePipeline, listImages, replaceImageUrl, replaceImageAlt, type BlockView } from '@lector/core'
import {
  detectEnv,
  discardStagedImage,
  revealInFolder,
  runImageCommand,
  saveImage,
  stageImage,
} from '@lector/shell-web'
import { getSettings } from './settings.ts'
import { showPrompt } from './dialog.ts'
import { showInLightbox } from './lightbox.ts'
import { assetLocalPath } from './asset.ts'
import { docStem } from './paths.ts'
import { showToast, copyText } from './feedback.ts'
import { showContextMenu, type ContextMenuItem } from './contextMenu.ts'
import { t } from './i18n.ts'
import {
  fileToBase64,
  imageContentHash,
  imageDedupKey,
  imageMarkdown,
  splitUploadCommand,
  expandImageDir,
  findDedupImage,
  rememberImage,
  runImageIngest,
} from './imageInsert.ts'
import type { DocumentEditor } from './documentEditor.ts'

export type ImageInsertRef = { type: 'caret' } | { type: 'afterBlock'; blockId: string }

export function createImageController({ editor }: { editor: Pick<DocumentEditor, 'getSession' | 'focusBlock' | 'render' | 'operations' | 'insertImageMarkdownAtCaret'> }) {
  /** 图片上的菜单。 */
  /** 图片在正文里的归属：哪个块、块内第几张（按渲染 DOM 顺序，与 listImages 对齐）。 */
  function imageTarget(img: HTMLImageElement): { block: BlockView; index: number } | null {
    const blockEl = img.closest<HTMLElement>('.block')
    const id = blockEl?.dataset.blockId
    const block = id ? editor.getSession().blocks.find((b) => b.id === id) : undefined
    if (!block || !blockEl) return null
    const imgs = Array.from(blockEl.querySelectorAll<HTMLImageElement>('img'))
    const index = imgs.indexOf(img)
    if (index < 0) return null
    return { block, index }
  }

  /** 「编辑源码」：聚焦该块，把光标放到这张图的语法上（预览收起、露出 markdown）。 */
  function focusImageSource(block: BlockView, index: number): void {
    const node = listImages(block.raw)[index]
    if (!node) {
      editor.focusBlock(block.id)
      return
    }
    editor.focusBlock(block.id, { mode: 'pos', pos: node.start })
  }

  /**
   * 跑一次上传命令：成功给 URL，失败把原因一并交回。
   *
   * 这里不 toast：失败后的后果随走法不同（留副本的走法是「改用了本地路径」，
   * 不留副本的走法是「补落了一份副本」），得由调用方合成一句交代给用户。
   */
  async function tryUpload(absPath: string | null): Promise<{ url: string | null; error: string | null }> {
    const s = getSettings()
    const { command, preArgs } = splitUploadCommand(s.imageCommand)
    if (!command || !absPath) return { url: null, error: 'no command' }
    const res = await runImageCommand(
      command,
      [...preArgs, ...s.imageCommandArgs],
      absPath,
      s.imageCommandTimeoutMs,
    ).catch(() => null)
    if (res?.ok && res.url) return { url: res.url, error: null }
    return { url: null, error: res?.error ?? 'unknown' }
  }

  /** 手动上传：把这张图的本地文件传上去，用返回的 URL 替换它的地址。
   *  这是「不自动上传也能上传」的那条路——与设置里的自动上传开关无关。 */
  async function uploadImageAt(block: BlockView, index: number, absPath: string): Promise<void> {
    const { url, error } = await tryUpload(absPath)
    if (!url) {
      showToast(t('imageUploadFailed', { error: error ?? 'unknown' }))
      return
    }
    const next = replaceImageUrl(block.raw, index, url)
    if (next == null) {
      showToast(t('imageFailed'))
      return
    }
    const before = block.raw
    editor.operations.setBlockRaw(block, next)
    // 换 src 不经过 CM，得自己进撤销链（同任务勾选/表格写回）
    editor.operations.pushUndo(t('imageUndoUpload'), () => editor.operations.setBlockRaw(block, before))
    void editor.render()
    showToast(t('imageUploaded'))
  }

  /** 编辑图片描述（alt）：小输入框确认后只改 `![…]` 那一段，URL 不动。 */
  async function editImageAlt(block: BlockView, index: number): Promise<void> {
    const img = listImages(block.raw)[index]
    if (!img) return
    const next = await showPrompt({ title: t('imageEditAlt'), value: img.alt })
    if (next === null || next === img.alt) return
    const md = replaceImageAlt(block.raw, index, next)
    if (md == null) {
      showToast(t('imageFailed'))
      return
    }
    const before = block.raw
    editor.operations.setBlockRaw(block, md)
    editor.operations.pushUndo(t('imageUndoAlt'), () => editor.operations.setBlockRaw(block, before))
    void editor.render()
  }

  /** 替换图片文件：选新图 → 走同一条落盘链路 → 只换 URL 段，alt 保留。 */
  function replaceImageFile(block: BlockView, index: number): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void (async () => {
        try {
          const src = await persistImageBytes(file.name, file)
          if (!src) return
          const md = replaceImageUrl(block.raw, index, src)
          if (md == null) {
            showToast(t('imageFailed'))
            return
          }
          const before = block.raw
          editor.operations.setBlockRaw(block, md)
          editor.operations.pushUndo(t('imageUndoReplace'), () => editor.operations.setBlockRaw(block, before))
          void editor.render()
          showToast(t('imageReplaced'))
        } catch (err) {
          showToast(`${t('imageFailed')}：${String(err)}`)
        }
      })()
    })
    input.click()
  }

  /**
   * 图片动作菜单：只放「针对这一张图」能做的事。
   *
   * 点击图片的意图是「看一眼 / 换个地址 / 拿到它」，不是编辑源码——
   * 所以「查看原图」排第一，其余按可用性出现：外链图没有本地路径，就不给
   * 「在文件夹中显示 / 复制路径」；没配上传命令，就不给「上传到图床」。
   */
  function imageMenuItems(img: HTMLImageElement): ContextMenuItem[] {
    const target = imageTarget(img)
    const items: ContextMenuItem[] = [
      { label: t('imageView'), run: () => showInLightbox(img.src, img.alt) },
    ]
    if (target) {
      // mutates：三项都会改文档（描述写进 alt、替换写盘、编辑源码把块切进 CM），
      // 阅读档一律不出现——过滤在 documentMenus 的 forMode()
      items.push({ label: t('imageEditAlt'), mutates: true, run: () => void editImageAlt(target.block, target.index) })
      items.push({ label: t('imageReplace'), mutates: true, run: () => replaceImageFile(target.block, target.index) })
      items.push({ label: t('imageEditSource'), mutates: true, run: () => focusImageSource(target.block, target.index) })
      // 块级动作：图片块也是块，删除/插入段落与普通块共用同一套 operations
      // （mutates：阅读档不出现，过滤在 documentMenus 的 forMode()，与块菜单同一规矩）
      items.push({
        separatorBefore: true,
        label: t('imageDelete'),
        danger: true,
        mutates: true,
        run: () => editor.operations.deleteBlock(target.block.id),
      })
      items.push({
        label: t('menuInsertBefore'),
        mutates: true,
        run: () => editor.operations.insertParagraphBefore(target.block.id),
      })
      items.push({
        label: t('menuInsertAfter'),
        mutates: true,
        run: () => editor.operations.insertParagraphAfter(target.block.id),
      })
    }
    const local = assetLocalPath(img.src)
    if (local) {
      items.push({
        separatorBefore: true,
        label: t('menuReveal'),
        run: () => void revealInFolder(local).catch(() => showToast(t('openFailed'))),
      })
    }
    items.push({
      label: t('menuCopyImagePath'),
      run: () => void copyText(local ?? img.getAttribute('src') ?? '', t('menuCopied')),
    })
    // 上传项的条件只有两条：配了命令、这张图手上有本地文件。
    // 与「自动上传」开关**无关**——不自动上传正是手动上传存在的理由；
    // 已经指向图床的图（src 是 http(s)）没有本地文件，也就没什么可传的。
    if (target && local && imagePipeline(getSettings()).upload !== 'off') {
      items.push({
        separatorBefore: true,
        label: t('imageUpload'),
        // 上传会回写正文里的图片地址，属于改文档
        mutates: true,
        run: () => void uploadImageAt(target.block, target.index, local),
      })
    }
    return items
  }

  /**
   * 点击正文图片 → 弹图片动作菜单（锚在图片下沿，放不下会自动收进视口）。
   *
   * 用左键不是因为惯常，而是这里没有「选中图片」这个态：点图片最想要的是
   * 拿到针对它的几个动作。查看原图降为菜单第一项。
   */
  function mountImageActions(): void {
    document.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null
        if (!target || target.tagName !== 'IMG' || !target.closest('.reading-prose')) return
        // 阅读档：左键直接全屏看原图，和 mermaid 一致——阅读时点图的意思就是"我要看大图"，
        // 不该先弹一个以编辑动作为主的菜单。
        // 编辑档：左键给动作菜单（"编辑源码 / 替换图片"都在那里）。
        // 右键在任何档位都还是完整菜单（另有 contextmenu 绑定）。
        if (document.documentElement.dataset.mode === 'read') {
          e.preventDefault()
          e.stopPropagation()
          showInLightbox((target as HTMLImageElement).src, (target as HTMLImageElement).alt)
          return
        }
        e.preventDefault()
        e.stopPropagation()
        const r = (target as HTMLImageElement).getBoundingClientRect()
        showContextMenu(imageMenuItems(target as HTMLImageElement), r.left, r.bottom + 4)
      },
      true,
    )
  }

  const MAX_IMAGE_BYTES = 15 * 1024 * 1024

  /**
   * 图片字节 → 落盘 / 上传 → 返回可直接写进 `]()` 的 src。
   *
   * 走法由 core 的 imagePipeline() 裁决（要不要复制 × 要不要上传两根轴），
   * 动作由 imageInsert 的 runImageIngest() 执行；这里只做三件事：
   * 拿字节、查会话内去重、把结果写进正文并出提示。
   * 插入（粘贴/拖入）与「替换图片」共用这一条链路。
   */
  async function persistImageBytes(name: string, file: File): Promise<string | null> {
    if (file.size > MAX_IMAGE_BYTES) {
      showToast(t('imageTooLarge'))
      return null
    }
    if (detectEnv() !== 'shell' || !editor.getSession().source) {
      showToast(t('imageNeedFile'))
      return null
    }
    const bytes = await file.arrayBuffer()
    const plan = imagePipeline(getSettings())
    // 同一张图在本会话内粘 N 次只占一份磁盘 / 只传一次；换了走法（改目录、改上传）
    // 就是另一回事，键里带着管线，见 imageDedupKey。
    const key = imageDedupKey(await imageContentHash(bytes), plan)
    const existing = findDedupImage(key)
    if (existing) return existing

    const docPath = editor.getSession().source!.path
    const base64 = fileToBase64(bytes)
    const res = await runImageIngest(plan, name, base64, {
      copy: (n, b64) => saveImage(docPath, n, b64, expandImageDir(plan.copyDir, docStem(docPath)) ?? 'images'),
      stage: stageImage,
      upload: tryUpload,
      discard: discardStagedImage,
    })
    // 上传失败：正文落在哪儿就说哪儿（留副本 / 兜底补了一份），顺带把原因交代给用户
    if (!res.uploaded && res.error) {
      showToast(t('imageUploadKeptLocal', { path: res.src, error: res.error }))
    } else if (res.uploaded && !res.copied) {
      showToast(t('imageUploadedRemote'))
    }
    rememberImage(key, res.src)
    return res.src
  }

  async function ingestImageFile(file: File, name: string | null, insertRef?: ImageInsertRef | null) {
    if (!name) return
    try {
      const src = await persistImageBytes(name, file)
      if (src != null) insertImage(insertRef, imageMarkdown(src))
    } catch (err) {
      showToast(`${t('imageFailed')}：${String(err)}`)
    }
  }

  /** 按拖放/粘贴落点插图：光标处、某块之后、或文末。 */
  function insertImage(insertRef: ImageInsertRef | null | undefined, md: string) {
    if (insertRef?.type === 'afterBlock') {
      editor.operations.insertAfterBlock(insertRef.blockId, md)
      return
    }
    editor.insertImageMarkdownAtCaret(md)
  }

  return { imageMenuItems, mountImageActions, ingestImageFile }
}

export type ImageController = ReturnType<typeof createImageController>
