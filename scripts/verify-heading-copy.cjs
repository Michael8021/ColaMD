#!/usr/bin/env node
// 先 npm run build，再 npx electron scripts/verify-heading-copy.cjs。
// 使用真正的 Electron 窗口和系统复制、粘贴；窗口由 offscreen-window.cjs 隐藏。
const { app, clipboard, ClipboardItem } = require('electron')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = process.argv.find(arg => arg.startsWith('--report='))?.slice(9)
const checks = []
let savedClipboard = []
let finishing = false

async function main() {
  const { assertBuildFresh } = await import('./build-freshness.mjs')
  const { verifyWorkdir } = await import('./verify-workdir.mjs')
  assertBuildFresh()
  const { dir, udd } = verifyWorkdir('heading-copy')
  const source = join(dir, 'source.md')
  const destination = join(dir, 'destination.md')
  const initial = '### 复制验收标题\n\n后续正文\n'
  const target = '粘贴目标\n\n'
  writeFileSync(source, initial)
  writeFileSync(destination, target)
  for (const name of ['home', 'userData', 'sessionData']) {
    const path = name === 'userData' ? udd : join(dir, name)
    mkdirSync(path, { recursive: true })
    app.setPath(name, path)
  }
  process.argv = [process.argv[0], __filename, source]
  await app.whenReady()
  savedClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(
    Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))),
  )))
  let started = false
  app.on('browser-window-created', (_event, win) => {
    if (started) return
    started = true
    win.webContents.once('did-finish-load', () => run(win, { source, destination, initial, target }).then(
      () => finish(0), error => { console.error(error); finish(1) },
    ))
  })
  require('./offscreen-window.cjs')
}

async function finish(code) {
  if (finishing) return
  finishing = true
  if (report) writeFileSync(report, JSON.stringify({ checks, passed: checks.filter(c => c.ok).length, code }, null, 2))
  clipboard.clear()
  try {
    if (savedClipboard.length) await clipboard.write(savedClipboard)
  } finally {
    console.log(`标题复制验收：${checks.filter(c => c.ok).length}/${checks.length} 通过`)
    app.exit(code)
  }
}

async function run(win, files) {
  const ev = expression => win.webContents.executeJavaScript(expression)
  const check = (name, fn) => {
    try { fn(); checks.push({ name, ok: true }) }
    catch (error) { checks.push({ name, ok: false, error: error.message }); console.error(`失败：${name}\n${error.message}`) }
  }
  const key = async (keyCode, modifiers = []) => {
    const command = { c: 'copy', v: 'paste', x: 'cut' }[keyCode]
    if (command) {
      if (command === 'copy' || command === 'cut') await clipboard.writeText('标题复制验收占位')
      win.webContents[command]()
    }
    else await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key:${JSON.stringify(keyCode)},code:${JSON.stringify('Key' + keyCode.toUpperCase())},
      metaKey:${modifiers.includes('meta')},ctrlKey:${modifiers.includes('control')},
      shiftKey:${modifiers.includes('shift')},bubbles:true,cancelable:true
    }))`)
    await delay(50)
  }
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 100; i++) {
    if (await ev(`document.querySelector('.cm-content')?.textContent.includes('复制验收标题')`)) break
    await delay(100)
  }
  await ev(`window.v = document.querySelector('.cm-content').cmTile.root.view; undefined`)
  assert.equal(await ev('v.state.doc.toString()'), files.initial, '临时夹具必须加载成功')
  const reset = async (doc, from, to, reverse = false) => {
    await ev(`(() => {
      v.setState(v.state.constructor.create({doc:${JSON.stringify(doc)},extensions:v.state.config.base}));
      v.dispatch({selection:{anchor:${reverse ? to : from},head:${reverse ? from : to}}});v.focus()
    })()`)
    await delay(25)
  }
  const copy = () => ev(`(() => {
    const before = v.state.doc.toString(), selection = v.state.selection.toJSON();
    const data = new DataTransfer();
    v.contentDOM.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));
    return {text:data.getData('text/plain'),html:data.getData('text/html'),
      unchanged:before===v.state.doc.toString()&&JSON.stringify(selection)===JSON.stringify(v.state.selection.toJSON())}
  })()`)
  const sample = async (name, doc, from, to, expected, level, reverse = false) => {
    await reset(doc, from, to, reverse)
    const copied = await copy()
    check(name, () => {
      assert.equal(copied.text, expected)
      assert.ok(copied.unchanged, '复制不能修改文档或选区')
      if (level) assert.ok(copied.html.includes(`<h${level}>`), copied.html)
    })
  }

  for (let level = 1; level <= 6; level++) {
    const prefix = '#'.repeat(level) + ' '
    const title = `级别${level}标题`
    const doc = `${prefix}${title}\n\n后续正文\n\n## 另一个标题\n末尾`
    const from = prefix.length, end = from + title.length, to = doc.indexOf('后续正文') + 4
    await sample(`H${level} 单独选完整标题按文字复制`, doc, from, end, title)
    await sample(`H${level} 单独选部分文字`, doc, from + 1, end - 1, title.slice(1, -1))
    await sample(`H${level} 跨块正向复制`, doc, from, to, doc.slice(0, to), level)
    await sample(`H${level} 跨块反向复制`, doc, from, to, doc.slice(0, to), level, true)
    await sample(`H${level} 从标题中间跨块不补前文`, doc, from + 1, to, doc.slice(from + 1, to), level)
    await sample(`H${level} 源码行首起选不重复标记`, doc, 0, to, doc.slice(0, to), level)
    await sample(`H${level} 从标记中间起选补完整前缀`, doc, 1, to, doc.slice(0, to), level)
    await sample(`H${level} 选中标题后换行`, doc, from, end + 1, doc.slice(0, end + 1), level)
    await sample(`H${level} 连续跨多个标题`, doc, from, doc.length, doc, level)
    // 用户在同一文件粘贴后，原始 Markdown 层级要完整，且一笔撤销/重做。
    await reset(doc, from, to)
    await key('c', [mod])
    const nativeText = await clipboard.readText()
    const items = await clipboard.read()
    const nativeHTML = items[0]?.types.includes('text/html') ? await (await items[0].getType('text/html')).text() : ''
    check(`H${level} 系统剪贴板包含 Markdown 与标题 HTML`, () => {
      assert.equal(nativeText, doc.slice(0, to))
      assert.ok(nativeHTML.includes(`<h${level}>`), nativeHTML)
    })
    await ev(`v.dispatch({selection:{anchor:v.state.doc.length}});v.focus()`)
    await key('v', [mod])
    const pasted = await ev('v.state.doc.toString()')
    check(`H${level} 粘贴源码完整`, () => assert.equal(pasted, doc + nativeText))
    await key('z', [mod])
    const undone = await ev('v.state.doc.toString()')
    check(`H${level} 撤销还原原文`, () => assert.equal(undone, doc))
    await key('z', [mod, 'shift'])
    const redone = await ev('v.state.doc.toString()')
    check(`H${level} 重做还原粘贴`, () => assert.equal(redone, pasted))
  }

  const special = [
    ['加粗', '### **加粗标题**', '加粗标题', 3],
    ['嵌套强调', '#### ***强调标题***', '强调标题', 4],
    ['删除线', '## ~~删除标题~~', '删除标题', 2],
    ['行内代码', '##### `代码标题`', '代码标题', 5],
    ['链接', '### [链接标题](https://example.com)', '链接标题', 3],
    ['高亮', '### ==高亮标题==', '高亮标题', 3],
    ['高亮嵌套加粗', '### ==**强调高亮**==', '强调高亮', 3],
    ['带结束标记', '### 末尾标记 ###', '末尾标记', 3],
    ['缩进三个空格', '   ## 缩进标题', '缩进标题', 2],
    ['多个分隔空格', '##   空格标题', '空格标题', 2],
    ['引用', '> ### 引用标题', '引用标题', 3],
    ['嵌套引用', '> > #### 嵌套标题', '嵌套标题', 4],
    ['无序列表', '- ### 列表标题', '列表标题', 3],
    ['有序列表', '3. ## 有序标题', '有序标题', 2],
    ['前有正文', '前置正文\n\n### 文中标题', '文中标题', 3],
    ['混合格式', '## **粗体** 与 *斜体*', '粗体', 2],
  ]
  for (const [name, heading, title, level] of special) {
    const doc = `${heading}\n\n后续正文`, from = doc.indexOf(title)
    const lineStart = doc.lastIndexOf('\n', from) + 1
    await sample(`${name} 跨块补齐原始前缀`, doc, from, doc.length, doc.slice(lineStart), level)
    await sample(`${name} 从正文中间开始不补`, doc, from + 1, doc.length, doc.slice(from + 1), level)
  }
  for (const [name, doc, text] of [
    ['围栏代码', '```md\n### 代码标题\n正文\n```', '代码标题'],
    ['缩进代码', '    ### 缩进代码\n    正文', '缩进代码'],
    ['转义井号', '\\### 转义标题\n\n正文', '转义标题'],
    ['七个井号', '####### 非标题\n\n正文', '非标题'],
    ['井号后无空格', '###不是标题\n\n正文', '不是标题'],
    ['解析器不识别 Tab 标题', '##\t制表文字\n\n正文', '制表文字'],
    ['Setext 一级', '下划线标题\n===\n\n正文', '下划线标题'],
    ['Setext 二级', '下划线标题\n---\n\n正文', '下划线标题'],
    ['属性区', '---\ntitle: 属性\n### YAML文字\n---\n\n正文', 'YAML文字'],
    ['普通正文', '正文文字\n\n### 后面的标题', '文字'],
    ['可见的引用链接括号', '### [引用文字][ref]\n\n后续正文\n\n[ref]: https://example.com', '引用文字'],
  ]) await sample(`${name} 不补不存在的标题前缀`, doc, doc.indexOf(text), doc.length, doc.slice(doc.indexOf(text)))

  const themes = ['light', 'dark', 'elegant', 'sepia', 'notion', 'bear', 'writer', 'solarized-dark', 'nord', 'gruvbox', 'dracula', 'midnight']
  for (const theme of themes) {
    await ev(`document.body.className=${JSON.stringify('theme-' + theme)}`)
    const doc = '### 主题标题\n\n后续正文'
    await sample(`${theme} 主题跨块复制`, doc, 4, doc.length, doc, 3)
  }
  const endDoc = '### 首标题\n\n正文\n\n###### 末标题'
  await sample('选区结束在另一个标题中间不扩展末端', endDoc, 4, endDoc.indexOf('末标题') + 1,
    endDoc.slice(0, endDoc.indexOf('末标题') + 1), 3)

  // 选区跨出视口时，应用异步补写系统剪贴板的 HTML，不能只测同步事件。
  const longDoc = '前置正文\n\n'.repeat(120) + '###### 长文标题\n\n' + '长文正文\n\n'.repeat(180) + '长文结束标记'
  const longFrom = longDoc.indexOf('长文标题'), longExpected = longDoc.slice(longDoc.indexOf('######'))
  await reset(longDoc, longFrom, longDoc.length)
  await key('c', [mod])
  let longText = '', longHTML = ''
  for (let i = 0; i < 80; i++) {
    longText = await clipboard.readText()
    const items = await clipboard.read()
    longHTML = items[0]?.types.includes('text/html') ? await (await items[0].getType('text/html')).text() : ''
    if (longText === longExpected && longHTML.includes('长文结束标记')) break
    await delay(50)
  }
  check('长文档异步复制补齐第一个标题', () => assert.equal(longText, longExpected))
  check('长文档异步复制 HTML 包含首标题与末段', () => {
    assert.ok(longHTML.includes('<h6>长文标题</h6>'))
    assert.ok(longHTML.includes('长文结束标记'))
  })
  const longAfter = await ev('v.state.doc.toString()')
  check('长文档复制未改写原文', () => assert.equal(longAfter, longDoc))

  // 剪切不参与补前缀：删掉的字与剪贴板的字必须一致，不能多删隐藏标记。
  const cutDoc = '### 剪切标题\n\n剪切正文'
  await reset(cutDoc, 4, cutDoc.length)
  await key('x', [mod])
  const cutText = await clipboard.readText()
  check('跨块剪切仍精确匹配原始选区', () => assert.equal(cutText, cutDoc.slice(4)))
  const cutLeft = await ev('v.state.doc.toString()')
  check('剪切没有额外删除标题标记', () => assert.equal(cutLeft, '### '))
  await key('z', [mod])
  const cutUndo = await ev('v.state.doc.toString()')
  check('剪切撤销还原原文', () => assert.equal(cutUndo, cutDoc))

  // 跨文件粘贴：真实 IPC 打开第二个临时文件，同时检查源文件没有被写入。
  await reset(files.initial, 4, files.initial.length)
  await delay(1200)
  const sourceBefore = readFileSync(files.source), sourceMtime = statSync(files.source).mtimeMs
  await key('c', [mod])
  const crossText = await clipboard.readText()
  win.webContents.send('file-opened', { path: files.destination, content: files.target })
  for (let i = 0; i < 80; i++) {
    if (await ev('v.state.doc.toString()') === files.target) break
    await delay(50)
  }
  assert.equal(await ev('v.state.doc.toString()'), files.target)
  await ev('v.dispatch({selection:{anchor:v.state.doc.length}});v.focus()')
  await key('v', [mod])
  const crossPasted = await ev('v.state.doc.toString()')
  check('跨文件粘贴保留第一个标题', () => assert.equal(crossPasted, files.target + crossText))
  await key('z', [mod])
  const crossUndo = await ev('v.state.doc.toString()')
  check('跨文件粘贴可独立撤销', () => assert.equal(crossUndo, files.target))
  await delay(1200)
  check('跨文件操作未改写源文件内容与 mtime', () => {
    assert.deepEqual(readFileSync(files.source), sourceBefore)
    assert.equal(statSync(files.source).mtimeMs, sourceMtime)
  })

  // 源码模式直接复制所选字节，不根据渲染标题扩展。
  await ev(`document.getElementById('source-toggle-btn').click();const ta=document.getElementById('source-editor');ta.value='### 源码标题\\n\\n正文';ta.focus();ta.setSelectionRange(4,ta.value.length)`)
  await key('c', [mod])
  const sourceText = await clipboard.readText()
  check('源码模式复制不补前缀', () => assert.equal(sourceText, '源码标题\n\n正文'))

  if (checks.some(check => !check.ok)) throw Error('标题复制验收有失败项')
}

const timeout = setTimeout(() => { console.error('标题复制验收超时'); finish(1) }, 90000)
timeout.unref()
main().catch(error => { console.error(error); finish(1) })
