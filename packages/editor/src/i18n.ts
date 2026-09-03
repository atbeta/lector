// 用户文案：zh-CN + en。按浏览器语言选一套，缺键回退中文。

export type Locale = 'zh-CN' | 'en'

const zh = {
  appName: 'Lector',
  openFile: '打开文件',
  emptyTitle: 'Lector',
  emptyHint: '打开一个 Markdown 文件开始阅读。',
  openAria: '打开',
  saveAria: '保存',
  outlineAria: '大纲',
  findAria: '查找',
  themeAria: '切换主题',
  settingsAria: '设置',
  dirtyTitle: '有未保存修改',
  outlineLabel: '大纲',
  outlineEmpty: '暂无标题',
  saved: '已保存',
  saveFailed: '保存失败',
  openFailed: '打开失败',
  readFailed: '读取失败',
  reloadFailed: '重新加载失败',
  diskChanged: '磁盘文件已变化',
  discardTitle: '未保存的修改',
  discardBody: '打开新文件将丢失当前未保存的修改。',
  discardConfirm: '丢弃并打开',
  cancel: '取消',
  conflictTitle: '磁盘已变化',
  conflictBody: '文件在磁盘上已被其他程序修改。',
  conflictOverwrite: '覆盖磁盘',
  conflictReload: '重新加载',
  settingsTitle: '设置',
  appearance: '外观',
  theme: '主题',
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  readingFont: '阅读字体',
  fontSystem: '系统',
  fontSerif: '衬线',
  fontSize: '正文字号',
  lineHeight: '行高',
  readingWidth: '阅读列宽',
  editing: '编辑',
  autoPairs: '自生成对符号',
  confirmClose: '关闭脏文档前确认',
  showWhitespace: '显示空白字符',
  resetDefaults: '恢复默认',
  done: '完成',
  findPlaceholder: '查找',
  replacePlaceholder: '替换为',
  findPrev: '上一个',
  findNext: '下一个',
  replaceAll: '全部替换',
  close: '关闭',
  noResults: '无结果',
  matchCount: '{n} 处',
  imageNeedFile: '请先打开一个磁盘上的 Markdown 文件，再粘贴或拖入图片。',
  imageFailed: '图片保存失败',
  imageTooLarge: '图片超过 15MB，未写入。',
} as const

const en: Record<keyof typeof zh, string> = {
  appName: 'Lector',
  openFile: 'Open file',
  emptyTitle: 'Lector',
  emptyHint: 'Open a Markdown file to start reading.',
  openAria: 'Open',
  saveAria: 'Save',
  outlineAria: 'Outline',
  findAria: 'Find',
  themeAria: 'Toggle theme',
  settingsAria: 'Settings',
  dirtyTitle: 'Unsaved changes',
  outlineLabel: 'Outline',
  outlineEmpty: 'No headings',
  saved: 'Saved',
  saveFailed: 'Save failed',
  openFailed: 'Open failed',
  readFailed: 'Read failed',
  reloadFailed: 'Reload failed',
  diskChanged: 'File changed on disk',
  discardTitle: 'Unsaved changes',
  discardBody: 'Opening another file will discard unsaved changes.',
  discardConfirm: 'Discard and open',
  cancel: 'Cancel',
  conflictTitle: 'File changed on disk',
  conflictBody: 'This file was modified by another program.',
  conflictOverwrite: 'Overwrite',
  conflictReload: 'Reload',
  settingsTitle: 'Settings',
  appearance: 'Appearance',
  theme: 'Theme',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  readingFont: 'Reading font',
  fontSystem: 'System',
  fontSerif: 'Serif',
  fontSize: 'Font size',
  lineHeight: 'Line height',
  readingWidth: 'Column width',
  editing: 'Editing',
  autoPairs: 'Auto-pair characters',
  confirmClose: 'Confirm before closing dirty files',
  showWhitespace: 'Show whitespace',
  resetDefaults: 'Reset defaults',
  done: 'Done',
  findPlaceholder: 'Find',
  replacePlaceholder: 'Replace with',
  findPrev: 'Previous',
  findNext: 'Next',
  replaceAll: 'Replace all',
  close: 'Close',
  noResults: 'No results',
  matchCount: '{n} matches',
  imageNeedFile: 'Open a Markdown file on disk before pasting or dropping images.',
  imageFailed: 'Could not save image',
  imageTooLarge: 'Image is larger than 15MB and was not saved.',
}

export type MessageKey = keyof typeof zh

function detectLocale(): Locale {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'zh-CN'
  return lang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

let locale: Locale = detectLocale()

export function getLocale(): Locale {
  return locale
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const table = locale === 'en' ? en : zh
  let s: string = table[key] ?? zh[key]
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v))
    }
  }
  return s
}
