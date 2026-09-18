import { expect, test } from 'bun:test'
import { resolvedAppName } from '../src/appInfo.ts'

// 壳侧 app_info 在测试环境拿不到（返回 null），这里守的是**同步兜底**：
// 菜单标签是同步渲染的，查不到真名时必须回退到路径基名，而不是空串。
test('resolvedAppName：未查到真名时回退到路径基名（去可执行扩展名）', () => {
  expect(resolvedAppName('/Applications/NoteFast.app')).toBe('NoteFast')
  expect(resolvedAppName('C:\\Apps\\NoteFast\\NoteFast.exe')).toBe('NoteFast')
  expect(resolvedAppName('/usr/local/bin/notefast')).toBe('notefast')
})
