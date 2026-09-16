import { listImages, replaceImageUrl, replaceImageAlt, type BlockView } from '@lector/core'
import { detectEnv, revealInFolder, saveImage, runImageCommand } from '@lector/shell-web'
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
  imageMarkdown,
  splitUploadCommand,
  expandImageDir,
  findDedupImage,
  rememberImage,
} from './imageInsert.ts'
import type { DocumentEditor } from './documentEditor.ts'

export type ImageInsertRef = { type: 'caret' } | { type: 'afterBlock'; blockId: string }

export function createImageController({ editor }: { editor: Pick<DocumentEditor, 'getSession' | 'focusBlock' | 'render' | 'operations' | 'insertImageMarkdownAtCaret'> }) {
  /** 图片上的菜单。 */
  /** 图片在正文里的归属：哪个块、块内第几张（按��染 DOM 顺序，与 listImages 对齐）。 */
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

  /** 上传到图床（仅命令模式）：跑用户命令拿到 URL，用它替换这张图的 src。 */
  async function uploadImageAt(block: BlockView, index: number, absPath: string): Promise<void> {
    const s = getSettings()
    const { command, preArgs } = splitUploadCommand(s.imageCommand)
    if (!command) return
    try {
      const res = await runImageCommand(command, [...preArgs, ...s.imageCommandArgs], absPath, s.imageCommandTimeoutMs)
      if (!res.ok || !res.url) {
        showToast(`${t('imageUploadFailed')}：${res.error ?? 'unknown'}`)
        return
      }
      const next = replaceImageUrl(block.raw, index, res.url)
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
    } catch (err) {
      showToast(`${t('imageUploadFailed')}：${String(err)}`)
    }
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
   * 所以「查看原图」排第一，其余按可用性出现（外链图没有本地路径，
   * 就不给「在文件夹中显示 / 复制路径」；没配图床命令就不给「上传」）。
   */
  function imageMenuItems(img: HTMLImageElement): ContextMenuItem[] {
    const target = imageTarget(img)
    const items: ContextMenuItem[] = [
      { label: t('imageView'), run: () => showInLightbox(img.src, img.alt) },
    ]
    if (target) {
      items.push({ label: t('imageEditAlt'), run: () => void editImageAlt(target.block, target.index) })
      items.push({ label: t('imageReplace'), run: () => replaceImageFile(target.block, target.index) })
      items.push({ label: t('imageEditSource'), run: () => focusImageSource(target.block, target.index) })
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
    const s = getSettings()
    if (target && local && s.imageMode === 'command' && s.imageCommand.trim()) {
      items.push({
        separatorBefore: true,
        label: t('imageUpload'),
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
   * 图片字节 → 落盘 → 返回可直接写进 `]()` 的 src。
   * 命令模式返回图床 URL（失败回退本地相对路径），其余模式返回相对路径。
   * 插入（粘贴/拖入）与「替换图片」共用这一条链路，模式逻辑只此一份。
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
    // 同一张图在本会话内粘 N 次只占一份磁盘：按内容 hash 复用上次返回的路径。
    // 跨会话的 map 会重置——按 hash 查 image-assets 目录里是下个迭代的事。
    const hash = await imageContentHash(bytes)
    const existing = findDedupImage(hash)
    if (existing) return existing
    const bytes_base64 = fileToBase64(bytes)

    // 模式 → 落盘子目录：images（旧行为）/ assets 模板 / command 时也先落 assets 副本。
    const s = getSettings()
    let local: { relative_path: string; abs_path: string | null }
    if (s.imageMode === 'command' || s.imageMode === 'assets') {
      const stem = docStem(editor.getSession().source!.path)
      const expanded = expandImageDir(s.imageAssetsDir, stem) ?? 'images'
      local = await saveImage(editor.getSession().source!.path, name, bytes_base64, expanded)
      if (s.imageMode === 'command') {
        // 命令模式：本地副本已在 assets 里，传图床拿 URL，失败静默回退本地。
        const { command, preArgs } = splitUploadCommand(s.imageCommand)
        if (command && local.abs_path) {
          const res = await runImageCommand(command, [...preArgs, ...s.imageCommandArgs], local.abs_path, s.imageCommandTimeoutMs).catch(() => null)
          if (res?.ok && res.url) {
            rememberImage(hash, res.url)
            return res.url
          }
          showToast(`${t('imageUploadFailed')}：${res?.error ?? 'unknown'}`)
        }
        rememberImage(hash, local.relative_path)
        return local.relative_path
      }
    } else {
      // 缺省 / images：保持老的 images/ 目录。
      local = await saveImage(editor.getSession().source!.path, name, bytes_base64, 'images')
    }
    rememberImage(hash, local.relative_path)
    return local.relative_path
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
