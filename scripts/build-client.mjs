/**
 * 生成 `client.js`。
 *
 * 为什么需要它：客户端是**单文件**模块（宿主按 `window.__ModuleLoader__.load`
 * 的 lazy-CJS 形式加载，factory 里只能 `require('react')` 这类基线模块，
 * 不能 require 相对路径），而 `lib/shared/*.mjs` 又必须与宿主侧共用同一份源码。
 *
 * 于是这里做一个最小内联：把共享模块的源码去掉 `export ` 前缀后填进模板的
 * `@@INLINE:xxx@@` 标记位置。不是打包器，没有依赖，也不做 tree-shaking。
 *
 * 用法：node scripts/build-client.mjs
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const TEMPLATE = join(root, 'src', 'client.template.js')
const OUT = join(root, 'client.js')
const PACKAGE_NAME = 'dsh-human-alert'

/** 内联来源：标记名 → 源文件。 */
const SOURCES = {
  defaults: join(root, 'lib', 'shared', 'defaults.mjs'),
  logbuf: join(root, 'lib', 'shared', 'logbuf.mjs'),
}

/**
 * 把 ESM 模块改写成"可在 factory 作用域里直接执行"的脚本：
 *  - 去掉 `export ` 前缀（声明变普通声明）
 *  - 若有 import 语句直接报错（共享模块必须零依赖）
 */
function toInlineScript(source, file) {
  const withoutExport = source.replace(/^export\s+/gm, '')
  const importLeft = withoutExport.match(/^\s*import\s[^\n]*$/m)
  if (importLeft !== null) {
    throw new Error(`${file} 含有 import 语句，共享模块必须零依赖：${importLeft[0].trim()}`)
  }
  if (/^export\s/m.test(withoutExport)) {
    throw new Error(`${file} 仍残留 export 语句，内联会破坏 factory 作用域`)
  }
  return withoutExport
}

/** 给内联片段加一层来源注释，方便在产物里追溯。 */
function block(name, code) {
  return [
    `// ──── 内联自 lib/shared/${name}.mjs（由 scripts/build-client.mjs 生成，勿手改）────`,
    code.trimEnd(),
    `// ──── lib/shared/${name}.mjs 结束 ────`,
  ].join('\n')
}

async function main() {
  let template = await readFile(TEMPLATE, 'utf8')

  for (const [name, file] of Object.entries(SOURCES)) {
    const marker = `/* @@INLINE:${name}@@ */`
    if (!template.includes(marker)) {
      throw new Error(`模板里找不到标记 ${marker}`)
    }
    const source = await readFile(file, 'utf8')
    template = template.replace(marker, block(name, toInlineScript(source, file)))
  }

  // 防御：避免模板里残留未替换的标记就产出半成品
  const leftover = template.match(/@@INLINE:[a-z]+@@/)
  if (leftover !== null) {
    throw new Error(`还有未替换的内联标记：${leftover[0]}`)
  }

  const output = [
    '/* 由 scripts/build-client.mjs 生成 —— 请修改 client/src/client.template.js 与 lib/shared/*.mjs 后重新构建 */',
    `window.__ModuleLoader__.load({id:"${PACKAGE_NAME}",factory:function(require){var module={exports:{}};`,
    template.trimEnd(),
    '',
    'return module.exports;}});',
    '',
  ].join('\n')

  // 产物必须是可被宿主加载的 CJS factory：做一次语法自检
  // eslint-disable-next-line no-new-func
  new Function(output.replace(/^window\.__ModuleLoader__\.load\(/, 'void ('))

  await writeFile(OUT, output, 'utf8')

  const bytes = Buffer.byteLength(output, 'utf8')
  console.log(`✓ 生成 ${OUT}（${bytes} 字节）`)
}

main().catch(error => {
  console.error('✗ 构建失败：', error.message)
  process.exitCode = 1
})
