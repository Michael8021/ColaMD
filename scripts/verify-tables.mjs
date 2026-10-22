import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

assertBuildFresh()
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const electron = createRequire(import.meta.url)('electron')
const { dir, udd } = verifyWorkdir('tables')
const file = join(dir, 'tables.md')
const fixture = '# 单元格编辑\n\n| 名称 | 内容 | 数量 |\n| :--- | :---: | ---: |\n| 苹果 | **加粗**和 `代码` | 123 |\n|| 空格子 | |\n| 缺省 |\n\n表格后的正文。\n'
writeFileSync(file, fixture)
const port = 9940 + Math.floor(Math.random() * 10)
const inspect = port + 1000
const child = spawn(electron, ['scripts/offscreen-window.cjs', file, `--user-data-dir=${udd}`, `--remote-debugging-port=${port}`, `--inspect=${inspect}`], { cwd: ROOT, stdio: 'ignore' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let ws, mainWS, passed = 0
const errors = []
const check = (name, value, detail = '') => {
  assert(value, `${name}: ${detail}`)
  passed++
  console.log(`PASS ${name}`)
}
try {
  let page
  for (let i = 0; i < 150; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page') } catch {}
    if (page) break
    await sleep(100)
  }
  assert(page, '测试窗口未启动')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(arg=>arg.description || arg.value))
    if (!message.id) return
    const request = pending.get(message.id)
    pending.delete(message.id)
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  let mainTarget
  for (let i = 0; i < 100 && !mainTarget; i++) {
    try { mainTarget = (await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json()).find(target => target.type === 'node') } catch {}
    if (!mainTarget) await sleep(100)
  }
  assert(mainTarget, '主进程调试连接未启动')
  mainWS = new WebSocket(mainTarget.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { mainWS.addEventListener('open', resolve); mainWS.addEventListener('error', reject) })
  const mainEval = async expression => {
    const requestId = ++id
    const reply = new Promise(resolve => {
      const receive = event => {
        const message = JSON.parse(event.data)
        if (message.id !== requestId) return
        mainWS.removeEventListener('message', receive)
        resolve(message)
      }
      mainWS.addEventListener('message', receive)
    })
    mainWS.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    const response = await reply
    assert(!response.error && !response.result.exceptionDetails, JSON.stringify(response))
    return response.result.result?.value
  }
  const ELECTRON = "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')"
  const sendToWindow = (channel, payload) => mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].webContents.send(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`)
  const setTheme = async (name, css) => {
    // 走菜单/自定义主题实际使用的 IPC，验证 applyTheme 的完整通知路径。
    await sendToWindow('set-theme', name)
    if (css !== undefined) await sendToWindow('set-custom-css', css)
    await sleep(150)
  }
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`!!document.querySelector('.cm-md-table-header')`)) break
    await sleep(100)
  }
  await evaluate(`window.v = document.querySelector('#editor .cm-content').cmTile.root.view; v.focus()`)
  const doc = () => evaluate('v.state.doc.toString()')
  const key = async (key, modifiers = 0) => {
    const codes = { Tab: 9, Enter: 13, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, z: 90, a: 65, Home: 36, End: 35 }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: codes[key], modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers })
    await sleep(30)
  }
  const MOD = process.platform === 'darwin' ? 4 : 2
  const setDoc = async text => {
    await evaluate(`v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(text)}},selection:{anchor:0}})`)
    await sleep(150)
  }
  const select = async (text, offset = 0, length = 0) => evaluate(`(() => {
    const anchor = v.state.doc.toString().indexOf(${JSON.stringify(text)}) + ${offset}
    v.dispatch({selection:{anchor,head:anchor+${length}}});v.focus()
  })()`)
  const clickCell = async (row, column, fraction = 0) => {
    const box = await evaluate(`(() => {
      const cell = document.querySelectorAll('.cm-md-table-row')[${row}].querySelectorAll('.cm-md-table-cell')[${column}]
      cell.scrollIntoView({block:'center'})
      const r=cell.getBoundingClientRect();return {x:r.left+Math.max(14,r.width*${fraction}),y:r.top+18}
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 })
    await sleep(50)
  }
  const type = text => send('Input.insertText', { text })
  const paste = text => evaluate(`(() => {const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});v.contentDOM.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`)
  const exportHTML = () => evaluate('window.__colamdExportDocumentHTML()')
  const head = () => evaluate('v.state.selection.main.head')

  check('打开表格不修改原文', await doc() === fixture, JSON.stringify({doc:await doc(), errors}))
  check('表格按原有对齐方式显示', await evaluate(`Array.from(document.querySelectorAll('.cm-md-table-header .cm-md-table-cell')).map(c=>getComputedStyle(c).textAlign).join(',')`) === 'left,center,right')
  const selectionFixture = '段落。\n\n| 名称 | 数量 | 说明 |\n| :--- | ---: | :--- |\n| 苹果 | 12 | **加粗** 与 `代码` |\n|  | 3 | 空格子 |\n\n> 引用开头\n>\n> | 日期 | 事项 |\n> | --- | --- |\n> | 周一 | 整理 |\n>\n> 引用结尾\n\n结尾。\n'
  const themes = ['light', 'dark', 'elegant', 'sepia', 'notion', 'bear', 'writer', 'solarized-dark', 'nord', 'gruvbox', 'dracula', 'midnight']
  await setDoc(selectionFixture)
  for (const [theme, css] of [...themes.map(theme => [theme]),
    ['custom:large', '.cm-content { font-family: Georgia, serif; font-size: 25px; line-height: 1.8; }'],
    ['custom:small', '.cm-content { font-family: monospace; font-size: 15px; line-height: 1.5; }']]) {
    await setTheme(theme, css)
    await evaluate(`v.dispatch({selection:{anchor:${selectionFixture.indexOf('日期')},head:${selectionFixture.indexOf('整理') + 2}}}); v.focus()`)
    await sleep(80)
    const selectionBounds = await evaluate(`(() => {
    const table = document.querySelector('.cm-md-table-widget.cm-md-blockquote:has(.cm-md-table-row)')
    const first = table.querySelector('.cm-md-table-header').getBoundingClientRect()
    const last = table.querySelector('.cm-md-table-last').getBoundingClientRect()
    const pieces = [...document.querySelectorAll('.cm-selectionBackground')].map(piece => piece.getBoundingClientRect())
    return { top: Math.min(...pieces.map(piece => piece.top)), first: first.top,
      bottom: Math.max(...pieces.map(piece => piece.bottom)), last: last.bottom, count: pieces.length }
  })()`)
    check(`${theme} 切换后引用表格选区保持在首末行内`, selectionBounds.count > 0 && selectionBounds.top >= selectionBounds.first - 1 && selectionBounds.bottom <= selectionBounds.last + 1, JSON.stringify(selectionBounds))
  }
  check('绘制表格选区保持原文', await doc() === selectionFixture)
  await setTheme('elegant')
  await setDoc(fixture)
  const geometry = await evaluate(`Array.from(document.querySelectorAll('.cm-md-table-cell')).map(c=>({x:c.getBoundingClientRect().x,w:c.getBoundingClientRect().width}))`)
  const drag = await evaluate(`(() => {const row=document.querySelector('.cm-md-table-header').getBoundingClientRect();return {x1:row.left+6,x2:row.right-6,y:row.top+row.height/2}})()`)
  for (const legacy of [false, true]) {
    if (legacy) await evaluate(`window.caretMethod = document.caretPositionFromPoint; document.caretPositionFromPoint = undefined`)
    await send('Input.dispatchMouseEvent', {type:'mousePressed',x:drag.x1,y:drag.y,button:'left',clickCount:1})
    for (let i=1;i<=8;i++) await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:drag.x1+(drag.x2-drag.x1)*i/8,y:drag.y,button:'left',buttons:1})
    await send('Input.dispatchMouseEvent', {type:'mouseReleased',x:drag.x2,y:drag.y,button:'left',clickCount:1})
    check(legacy ? '旧版光标 API 仍支持跨格拖选' : '从留白拖选可以跨过多个单元格', await evaluate(`getSelection().toString().includes('名称') && getSelection().toString().includes('数量')`), await evaluate('getSelection().toString()'))
    if (legacy) await evaluate(`document.caretPositionFromPoint = window.caretMethod`)
  }
  const wordBox = await evaluate(`(() => {const r=document.querySelector('.cm-md-table-header .cm-md-table-cell').getBoundingClientRect();return {x:r.left+24,y:r.top+18}})()`)
  for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent', {type,...wordBox,button:'left',clickCount:2})
  check('双击单元格可以选词', await evaluate(`v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)`) === '名称')
  check('拖选和选词保持原文', await doc() === fixture)
  await clickCell(1, 0)
  check('点击后保持表格形状', await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 4)
  await type('新')
  check('点击哪一格就编辑哪一格', (await doc()).includes('| 新苹果 | **加粗**和 `代码` | 123 |'), await doc())
  await key('z', MOD)
  check('单元格编辑可撤销', await doc() === fixture)
  await key('z', MOD | 8)
  check('单元格编辑可重做', (await doc()).includes('新苹果'))
  await key('z', MOD)
  const afterClick = await evaluate(`Array.from(document.querySelectorAll('.cm-md-table-cell')).map(c=>({x:c.getBoundingClientRect().x,w:c.getBoundingClientRect().width}))`)
  check('点击和编辑不引起列宽跳动', JSON.stringify(geometry) === JSON.stringify(afterClick))

  await select('苹果', 2)
  await key('Tab')
  check('Tab 选中下一格内容', await evaluate('v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)') === '**加粗**和 `代码`')
  await key('Tab', 8)
  check('Shift+Tab 返回上一格', await evaluate('v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)') === '苹果')
  await select('苹果', 2)
  await key('ArrowRight')
  check('右方向键跨过分隔符', await evaluate('v.state.selection.main.head') === fixture.indexOf('**加粗**'))
  await key('ArrowLeft')
  check('左方向键返回上一格末尾', await evaluate('v.state.selection.main.head') === fixture.indexOf('苹果') + 2)
  await select('123', 1)
  await key('ArrowDown')
  check('下方向键保持当前列', await evaluate('v.state.selection.main.head') === fixture.indexOf('|| 空格子 | |') + '|| 空格子 | |'.length - 1, await evaluate('v.state.selection.main.head'))
  await key('ArrowUp')
  const up = await evaluate('v.state.selection.main.head')
  check('上方向键返回原来的列', up >= fixture.indexOf('123') && up <= fixture.indexOf('123') + 3, up)
  await select('苹果')
  await key('Backspace')
  await select('苹果', 2)
  await key('Delete')
  check('单元格边界删除不破坏表格', await doc() === fixture)

  await select('空格子')
  await key('Enter', MOD)
  check('快捷键在当前行下方新增一行', (await doc()).includes('|| 空格子 | |\n|  |  |  |\n| 缺省 |'))
  await key('z', MOD)
  check('新增一行可一步撤销', await doc() === fixture)
  await select('空格子')
  await key('Enter', 8)
  check('Shift+Enter 在单元格中换行', (await doc()).includes('<br>空格子'))
  check('HTML 导出保留单元格换行', (await exportHTML()).includes('<br>空格子'))
  await key('z', MOD)

  await clickCell(2, 0)
  await type('空白')
  check('紧邻竖线的空单元格可以输入', (await doc()).includes('|空白| 空格子 | |'))
  await key('z', MOD)
  await clickCell(3, 2)
  check('点击缺省单元格不补写原文', await doc() === fixture)
  await type('补全')
  check('缺省单元格第一次输入才补齐', (await doc()).includes('| 缺省 |  | 补全 |'))
  await key('z', MOD)
  check('补齐单元格可一步撤销', await doc() === fixture)

  for (const [name, row, column] of [['空单元格', 2, 0], ['缺省单元格', 3, 2]]) {
    await clickCell(row, column)
    await send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await sleep(60)
    await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await sleep(60)
    await send('Input.insertText', { text: '中文' }); await sleep(100)
    const value = await doc()
    check(`${name}支持中文组合输入`, (name === '空单元格' ? value.includes('|中文| 空格子 | |') : value.includes('| 缺省 |  | 中文 |')) && !value.includes('zhong'), value)
    await key('z', MOD)
    check(`${name}中文输入一步撤销`, await doc() === fixture)
  }

  await clickCell(3, 2)
  await send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await sleep(60)
  await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await sleep(100)
  check('取消缺省格子的输入不改写原文', await doc() === fixture)
  await select('123')
  await key('Backspace', 1)
  check('按词删除不跨入上一格', await doc() === fixture, await doc())
  await select('123', 3)
  await key('Backspace', MOD)
  check('删到行首只清空当前格', (await doc()).includes('| 苹果 | **加粗**和 `代码` |  |'), await doc())
  await key('z', MOD)
  await select('苹果', 2)
  for (const text of [' ', 'test', ' ', 'word']) await type(text)
  check('连续输入空格和单词不丢字', (await doc()).includes('苹果 test word'), await doc())
  await key('z', MOD)
  await clickCell(3, 2)
  await key('Tab')
  await type('末尾')
  check('末格按 Tab 新增行并可继续输入', (await doc()).includes('|  |  | 末尾 |'), await doc())
  await key('z', MOD)
  await key('z', MOD)
  check('末尾增行和编辑可撤销', await doc() === fixture)

  const emptyCases = '| 姓名 | 城市 | 邮箱 | 备注 |\n|---|---|---|---|\n|  | 香港 |  | 等待 |\n||上海|||\n| 缺省 |\n'
  for (const theme of themes) {
    await setDoc(emptyCases)
    await setTheme(theme)
    check(`${theme} 空格子没有嵌套单元格`, await evaluate(`document.querySelectorAll('.cm-md-table-row').length === 4 && document.querySelectorAll('.cm-md-table-cell').length === 16 && !document.querySelector('.cm-md-table-cell .cm-md-table-cell')`))
    for (const [row, column] of [[1, 0], [2, 2], [3, 3]]) {
      await clickCell(row, column)
      check(`${theme} 第 ${row} 行第 ${column} 格可以显示输入光标`, await evaluate(`(() => {
        const input = document.activeElement
        const range = getSelection().getRangeAt(0)
        const rect = input.getBoundingClientRect()
        const cursor = getComputedStyle(input).caretColor
        return input.classList.contains('cm-md-table-input') && input.isContentEditable && range.startContainer === input && rect.width > 0 && rect.height > 0 && cursor !== 'transparent' && getComputedStyle(document.querySelector('.cm-cursorLayer')).display === 'none'
      })()`))
    }
    check(`${theme} 空行高度与普通行一致`, await evaluate(`(() => { const rows = document.querySelectorAll('.cm-md-table-row'); return Math.abs(rows[1].offsetHeight - rows[2].offsetHeight) < 2 && Math.abs(rows[1].offsetHeight - rows[3].offsetHeight) < 2 })()`))
    check(`${theme} 点击空格子保持原文`, await doc() === emptyCases)
    // 选区层在 z-index -2：表头底色画在行上会把它盖住，只能画在更低的伪元素上
    check(`${theme} 表头底色不盖住选区`, await evaluate(`(() => {
      const header = document.querySelector('.cm-md-table-header')
      const layer = getComputedStyle(header, '::after')
      const selection = getComputedStyle(document.querySelector('.cm-selectionLayer'))
      return getComputedStyle(header).backgroundColor === 'rgba(0, 0, 0, 0)' && Number(layer.zIndex) < Number(selection.zIndex) && layer.backgroundColor !== 'rgba(0, 0, 0, 0)'
    })()`))
  }
  await setTheme('elegant')
  await clickCell(2, 2)
  await key('ArrowRight')
  check('空格子内右方向键进入相邻空格', await evaluate(`document.activeElement.closest('.cm-md-table-cell').dataset.column === '3'`))
  await key('ArrowUp')
  check('空格子内上方向键进入上一行同列', await evaluate('v.state.selection.main.head') >= emptyCases.indexOf('等待') && await evaluate('v.state.selection.main.head') <= emptyCases.indexOf('等待') + 2)
  await clickCell(2, 2)
  await key('Enter', 8)
  check('空格子内 Shift+Enter 插入格内换行', (await doc()).includes('||上海|<br>||'), await doc())
  await key('z', MOD)
  check('空格子换行可撤销', await doc() === emptyCases)
  const layoutCases = '正文。\n\n## 标题\n\n| 场景 | 示例 | 说明 |\n|---|---|---|\n| 换行 | 第一行<br>第二行<br>第三行 | 三行对齐 |\n| 长英文 | document_export_configuration_preview | 自动折行 |\n'
  await setDoc(layoutCases)
  check('换行的三行首字对齐且长英文没有额外空行', await evaluate(`(() => {
    const first = word => { const walker = document.createTreeWalker(v.contentDOM, NodeFilter.SHOW_TEXT); let node; while(node = walker.nextNode()) { const at = node.textContent.indexOf(word); if(at < 0) continue; const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 1); return { rect:range.getBoundingClientRect(), cell:node.parentElement.closest('.cm-md-table-cell') } } }
    const lines = ['第一行', '第二行', '第三行'].map(first)
    const english = first('document_export')
    return Math.max(...lines.map(line => line.rect.left)) - Math.min(...lines.map(line => line.rect.left)) < 1 && english.rect.top - english.cell.getBoundingClientRect().top < parseFloat(getComputedStyle(english.cell).lineHeight)
  })()`))
  const compact = '|名称|值|\n|---|---|\n|宽度|1280|\n'
  await setDoc(compact)
  const endPoint = await evaluate(`(() => { const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('.cm-md-table-row')[1].querySelector('.cm-md-table-cell')); const r = range.getBoundingClientRect(); return {x:r.right + 2,y:r.top + r.height / 2} })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', {type, ...endPoint, button:'left', clickCount:1})
  await sleep(80)
  check('紧凑表格末字后的光标仍在当前格', await evaluate(`(() => { const cell = document.querySelectorAll('.cm-md-table-row')[1].querySelector('.cm-md-table-cell').getBoundingClientRect(); const caret = document.querySelector('.cm-cursor').getBoundingClientRect(); return v.state.selection.main.head === ${compact.indexOf('宽度') + 2} && caret.left >= cell.left && caret.right <= cell.right && caret.top >= cell.top && caret.bottom <= cell.bottom })()`))
  await type('改')
  check('紧凑表格末字后输入仍属于当前格', await doc() === compact.replace('宽度', '宽度改'))
  await setDoc('> 引用正文\n>\n> | A | B |\n> |---|---|\n> | x | y |\n>\n> 引用结尾\n')
  check('引用表格的边框与正文保持相同缩进', await evaluate(`(() => { const table = document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)'); const quote = document.querySelector('.cm-md-blockquote'); const first = table.querySelector('.cm-md-table-cell').getBoundingClientRect(); const box = table.getBoundingClientRect(); const style = getComputedStyle(table); return table.classList.contains('cm-md-blockquote') && style.borderLeftWidth === getComputedStyle(quote).borderLeftWidth && first.left >= box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) })()`))
  check('引用正文前后的表格仍导出为表格', (await exportHTML()).includes('<blockquote><table>'))
  check('引用竖线在表格上下不断开', await evaluate(`(() => {
    const table = document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').getBoundingClientRect()
    const lines = [...document.querySelectorAll('.cm-content > .cm-line.cm-md-blockquote')].map(line => line.getBoundingClientRect())
    const above = lines.filter(line => line.bottom <= table.top + 1).at(-1)
    const below = lines.find(line => line.top >= table.bottom - 1)
    return Math.abs(table.top - above.bottom) < 1 && Math.abs(below.top - table.bottom) < 1
  })()`))
  await setDoc('| 模块 | 负责人 | 进度 | 日期 | 预算 | 说明 |\n|---|---|---|---|---|---|\n| 表格编辑 | 小林 | 进行中 | 2026-10-23 | 12,800.00 | 这是一段比较长的说明，用来观察列宽是否会给长文字留出足够的空间，避免每行只显示几个字。 |\n')
  check('按内容分配列宽，长说明比短内容更宽', await evaluate(`(() => { const cells = document.querySelectorAll('.cm-md-table-header .cm-md-table-cell'); return cells[5].offsetWidth > cells[0].offsetWidth * 2 && cells[5].offsetWidth > 200 && document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').offsetWidth <= v.contentDOM.clientWidth })()`))
  const amounts = '| 编号 | 地区 | 产品 | 数量 | 金额（元） | 备注 |\n| :---: | :---: | :--- | ---: | ---: | :--- |\n| 156 | 深圳 | 测试记录 | 26 | 19,258.20 | 这条记录比较长，用来观察多行内容的行高，以及在长表格中连续输入时是否顺畅。 |\n| 157 | 杭州 | 设计稿 | 33 | 19,381.65 | 可以直接修改 |\n| 158 | 成都 | 文档模板 | 40 | 19,505.10 | 可以直接修改 |\n| 159 | 南京 | 图表素材 | 47 | 19,628.55 | 可以直接修改 |\n| 160 | 台北 | 接口说明 | 54 | 19,752.00 | 可以直接修改 |\n'
  for (const theme of ['light', 'elegant', 'nord']) {
    await setDoc(amounts)
    await setTheme(theme)
    for (const width of ['780px', '540px']) {
      await evaluate(`v.contentDOM.style.width = '${width}'; v.contentDOM.style.maxWidth = '100%'`)
      check(`${theme} ${width} 数字金额和短地名不拆行，首行不向下偏移`, await evaluate(`Array.from(document.querySelectorAll('.cm-md-table-row')).slice(1).every(row => [0, 1, 3, 4].every(column => {
        const cell = row.querySelectorAll('.cm-md-table-cell')[column]
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode()) && !node.textContent.trim()) {}
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        const style = getComputedStyle(cell)
        return rect.height <= parseFloat(style.lineHeight) && rect.top - cell.getBoundingClientRect().top < parseFloat(style.lineHeight)
          && style.textAlign === (column <= 1 ? 'center' : 'right')
          && rect.left >= cell.getBoundingClientRect().left && rect.right <= cell.getBoundingClientRect().right
      }))`))
      check(`${theme} ${width} 表格保持文档宽度`, await evaluate(`document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').offsetWidth <= v.contentDOM.clientWidth`))
    }
    await evaluate(`v.contentDOM.style.width = ''; v.contentDOM.style.maxWidth = ''`)
    await select('19,381.65', '19,381.65'.length)
    await type('1')
    check(`${theme} 金额末尾可编辑`, await doc() === amounts.replace('19,381.65', '19,381.651'))
    await key('z', MOD)
    check(`${theme} 金额编辑可撤销`, await doc() === amounts)
    check(`${theme} 导出保留金额和对齐`, (await exportHTML()).includes('<td style="text-align:right">19,381.65</td>'))
  }
  await setDoc('| 内容 | 备注 |\n|---|---|\n| ' + 'long_identifier_'.repeat(20) + ' | 自动折行 |\n')
  check('长英文仍能换行，表格不撑出文档', await evaluate(`(() => { const cell = document.querySelectorAll('.cm-md-table-row')[1].querySelector('.cm-md-table-cell'); return cell.offsetHeight > parseFloat(getComputedStyle(cell).lineHeight) * 2 && document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').offsetWidth <= v.contentDOM.clientWidth })()`))
  await setDoc('| 公式 | 说明 |\n|---|---|\n| $E=mc^2$ | 行内公式 |\n')
  check('表格内现有行内公式正常渲染并导出', await evaluate(`!!document.querySelector('.cm-md-table-cell .katex')`) && (await exportHTML()).includes('katex'))
  const multiple = '| A | B |\n|---|---:|\n| first | 123 |\n|  | empty |\n\n> | C | D |\n> |---|---|\n> | quoted | tail |\n'
  await setDoc(multiple)
  const tableSnapshot = () => evaluate(`JSON.stringify([...v.contentDOM.querySelectorAll('.cm-md-table-row')].map(row => ({
    table: row.closest('.cm-md-table-widget').dataset.tableFrom, row: row.dataset.tableRow,
    cells: [...row.querySelectorAll('.cm-md-table-cell')].map(cell => [cell.textContent, cell.dataset.column, cell.className, getComputedStyle(cell).textAlign])
  })))`)
  for (const [word, text] of [['first', '**bold**'], ['123', 'word'], ['quoted', '引用文字']]) {
    await select(word, 0, word.length)
    await type(text)
    await sleep(100)
    const edited = await doc(), partial = await tableSnapshot()
    await setDoc(edited)
    check(`${word} 局部更新与完整重建的单元格和后续表格位置一致`, await tableSnapshot() === partial)
  }
  await setDoc(fixture)

  await select('苹果', 2)
  await type('|测试')
  check('输入竖线自动转义', (await doc()).includes('苹果\\|测试'))
  check('转义竖线不会增加列数', await evaluate(`document.querySelectorAll('.cm-md-table-row')[1].querySelectorAll('.cm-md-table-cell').length`) === 3)
  await key('z', MOD)
  await select('苹果', 2)
  await paste('`a || b`')
  check('粘贴连续竖线全部转义', (await doc()).includes('苹果`a \\|\\| b`') && await evaluate(`document.querySelectorAll('.cm-md-table-row')[1].querySelectorAll('.cm-md-table-cell').length`) === 3, await doc())
  await key('z', MOD)
  await select('苹果', 0, 2)
  await paste('第一行\n第二行')
  check('多行粘贴保留在单元格内', (await doc()).includes('第一行<br>第二行'), await doc())
  await key('z', MOD)
  // 反斜杠和字面竖线：按看到的字编辑，不改变分格
  const S = '\\'
  const rowCells = row => evaluate(`Array.from(document.querySelectorAll('.cm-md-table-row')[${row}].querySelectorAll('.cm-md-table-cell')).map(c => c.textContent.trim())`)
  const exportCells = async () => [...(await exportHTML()).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(match => match[1])
  const cursor = (pos, assoc = 0, userEvent) => evaluate(`(() => { const S = v.state.selection.constructor; v.dispatch({selection:S.create([S.cursor(${pos},${assoc})]),userEvent:${JSON.stringify(userEvent)}}); v.focus() })()`)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const compactSlash = '|A|B|\n|---|---|\n|x|y|\n'
  const compactTyped = `|A|B|\n|---|---|\n|x${S}${S}|y|\n`
  await setDoc(compactSlash)
  await cursor(compactSlash.indexOf('x') + 1, -1)
  await type(S)
  check('紧凑格尾输入反斜杠不转义右侧竖线', await doc() === compactTyped && same(await rowCells(1), [`x${S}`, 'y']), JSON.stringify([await doc(), await rowCells(1)]))
  check('格尾反斜杠导出仍是两格', same(await exportCells(), [`x${S}`, 'y']), await exportHTML())
  await key('z', MOD)
  check('格尾反斜杠一步撤销', await doc() === compactSlash, await doc())
  await key('z', MOD | 8)
  check('格尾反斜杠可重做', await doc() === compactTyped, await doc())
  await setDoc(compactSlash)
  const compactEnd = await evaluate(`(() => { const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('.cm-md-table-row')[1].querySelector('.cm-md-table-cell')); const r = range.getBoundingClientRect(); return {x: r.right + 2, y: r.top + r.height / 2} })()`)
  for (const kind of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: kind, ...compactEnd, button: 'left', clickCount: 1 })
  await sleep(50)
  await type(S)
  check('点击紧凑格尾后输入反斜杠保持两格', await doc() === compactTyped, await doc())

  const escapedPipe = `|A|B|\n|---|---|\n|a${S}|b|c|\n`
  for (const [name, offset] of [['转义竖线前', 0], ['点在转义符和竖线之间后', 1]]) {
    await setDoc(escapedPipe)
    await cursor(escapedPipe.indexOf(`a${S}|`) + 1 + offset, 0, 'select.pointer')
    if (offset) check('点击不停在隐藏的转义符后', await head() === escapedPipe.indexOf(`${S}|`), await head())
    await type(S)
    check(`${name}输入反斜杠保留后面的格子`, await doc() === `|A|B|\n|---|---|\n|a${S}${S}${S}|b|c|\n` && same(await rowCells(1), [`a${S}|b`, 'c']), JSON.stringify([await doc(), await rowCells(1)]))
  }
  check('转义竖线前的反斜杠导出保留字面竖线和后面的格子', same(await exportCells(), [`a${S}|b`, 'c']), await exportHTML())

  const literal = `| A | B |\n|---|---|\n| a${S}|b | c |\n`
  const removed = '| A | B |\n|---|---|\n| ab | c |\n'
  await setDoc(literal)
  await cursor(literal.indexOf('|b') + 1)
  await key('Backspace')
  check('Backspace 删除字面竖线时连同转义符', await doc() === removed && same(await rowCells(1), ['ab', 'c']), await doc())
  await key('z', MOD)
  check('删除字面竖线一步撤销', await doc() === literal, await doc())
  await key('z', MOD | 8)
  check('删除字面竖线可重做', await doc() === removed, await doc())
  await setDoc(literal)
  await cursor(literal.indexOf(`${S}|`))
  await key('Delete')
  check('Delete 删除字面竖线时连同转义符', await doc() === removed, await doc())
  await setDoc(literal)
  await select(`${S}|`, 0, 1)
  await key('Delete')
  check('只选中隐藏的转义符删除时整对删除', await doc() === removed, await doc())
  await setDoc(literal)
  await select('|b', 0, 1)
  await key('Backspace')
  check('选中字面竖线删除时连同转义符', await doc() === removed, await doc())
  await setDoc(literal)
  await select('|b', 0, 1)
  const cut = await evaluate(`(() => { const data = new DataTransfer(); v.contentDOM.dispatchEvent(new ClipboardEvent('cut', {clipboardData: data, bubbles: true, cancelable: true})); return data.getData('text/plain') })()`)
  check('剪切字面竖线时连同转义符', await doc() === removed && cut.includes('|'), JSON.stringify([await doc(), cut]))
  await key('z', MOD)
  check('剪切字面竖线一步撤销', await doc() === literal, await doc())

  await setDoc(literal)
  await cursor(literal.indexOf(`a${S}|`) + 1)
  await key('ArrowRight')
  check('右方向键一步跨过字面竖线', await head() === literal.indexOf('|b') + 1, await head())
  await key('ArrowLeft')
  check('左方向键一步退回字面竖线前', await head() === literal.indexOf(`${S}|`), await head())

  const slashes = `| A | B |\n|---|---|\n| a${S.repeat(4)}b | c |\n`
  await setDoc(slashes)
  await cursor(slashes.indexOf('a') + 3)
  await key('Backspace')
  check('连续反斜杠一次删掉一个', await doc() === `| A | B |\n|---|---|\n| a${S}${S}b | c |\n` && same(await rowCells(1), [`a${S}b`, 'c']), await doc())

  const lone = `|A|B|\n|---|---|\n|x${S}a|y|\n`
  await setDoc(lone)
  await cursor(lone.indexOf('a|') + 1, -1)
  await key('Backspace')
  check('删掉落单反斜杠后的字不转义右侧竖线', await doc() === compactTyped && same(await rowCells(1), [`x${S}`, 'y']), await doc())

  const loneBefore = `| A | B |\n|---|---|\n| ${S}a | b |\n`
  await setDoc(loneBefore)
  await cursor(loneBefore.indexOf(`${S}a`) + 1)
  await type('|')
  check('落单反斜杠后输入竖线两个字都保留', await doc() === `| A | B |\n|---|---|\n| ${S}${S}${S}|a | b |\n` && same(await rowCells(1), [`${S}|a`, 'b']), await doc())

  const loneEnd = `| A | B |\n|---|---|\n| x${S} | y |\n`
  await setDoc(loneEnd)
  await cursor(loneEnd.indexOf(`x${S}`) + 2)
  await key('Enter', 8)
  check('落单反斜杠后换行仍是格内换行', await doc() === `| A | B |\n|---|---|\n| x${S}${S}<br> | y |\n` && (await exportCells())[0] === `x${S}<br>`, JSON.stringify([await doc(), await exportHTML()]))

  const breakCell = '| A | B |\n|---|---|\n| a<br>b | c |\n'
  await setDoc(breakCell)
  await cursor(breakCell.indexOf('<br>'))
  await type(S)
  check('格内换行前输入反斜杠不转义换行', await doc() === `| A | B |\n|---|---|\n| a${S}${S}<br>b | c |\n`, await doc())

  await setDoc(compactSlash)
  await select('x')
  await paste(`p${S}\tq${S}`)
  check('多格粘贴以反斜杠结尾不转义竖线', await doc() === `|A|B|\n|---|---|\n|p${S}${S}|q${S}${S}|\n` && same(await rowCells(1), [`p${S}`, `q${S}`]), await doc())
  await setDoc(fixture)

  // 同一行跨格复制：富文本口味是选中的这几格组成的一行表格，没选到的字不补进去
  const copyRow = '| 名称 | 数量 | 备注 |\n|---|---:|---|\n| 苹果 | 12 |  |\n'
  const copyEvent = () => evaluate(`(() => { const data = new DataTransfer(); v.contentDOM.dispatchEvent(new ClipboardEvent('copy', {clipboardData: data, bubbles: true, cancelable: true})); return {plain: data.getData('text/plain'), html: data.getData('text/html')} })()`)
  await setDoc(copyRow)
  await select('果 | 12', 0, '果 | 12'.length)
  let copied = await copyEvent()
  check('跨格复制的纯文本仍是原文', copied.plain === '果 | 12', JSON.stringify(copied))
  check('跨格复制的富文本是一行表格且不补未选的字', copied.html === '<table><tbody><tr><td style="text-align:left">果</td><td style="text-align:right">12</td></tr></tbody></table>', copied.html)
  await select('名称 | 数', 0, '名称 | 数'.length)
  copied = await copyEvent()
  check('表头跨格复制保留表头', copied.html === '<table><thead><tr><th style="text-align:left">名称</th><th style="text-align:right">数</th></tr></thead></table>', copied.html)
  await select('果', 0, copyRow.lastIndexOf('|') - copyRow.indexOf('果'))
  copied = await copyEvent()
  check('跨到空格子的复制保留空格子', copied.html === '<table><tbody><tr><td style="text-align:left">果</td><td style="text-align:right">12</td><td style="text-align:left"></td></tr></tbody></table>', copied.html)
  await select('苹果', 1, 1)
  copied = await copyEvent()
  check('单格内复制仍是文字', /^<p>.*果.*<\/p>$/.test(copied.html) && !/<t[dhr]|<table/.test(copied.html) && !copied.html.includes('苹'), copied.html)
  await mainEval(`(async () => { const { clipboard, ClipboardItem } = ${ELECTRON}; globalThis.__tablesClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))) })()`)
  try {
    await select('果 | 12', 0, '果 | 12'.length)
    await evaluate(`document.execCommand('copy')`)
    const system = await mainEval(`(async () => { const items = await ${ELECTRON}.clipboard.read(); const get = async type => { const item = items.find(item => item.types.includes(type)); return item ? (await item.getType(type)).text() : '' }; return { text: await get('text/plain'), html: await get('text/html') } })()`)
    check('系统剪贴板拿到原文和一行表格', system.text === '果 | 12' && system.html.includes('<td style="text-align:left">果</td><td style="text-align:right">12</td>'), JSON.stringify(system))
    await setDoc('正文\n')
    await select('正文', 2)
    await mainEval(`${ELECTRON}.BrowserWindow.getAllWindows()[0].webContents.paste()`)
    await sleep(200)
    check('系统粘贴回编辑器得到原文', await doc() === '正文果 | 12\n', await doc())
  } finally {
    await mainEval(`(async () => { const { clipboard } = ${ELECTRON}; clipboard.clear(); if (globalThis.__tablesClipboard.length) await clipboard.write(globalThis.__tablesClipboard) })()`)
  }
  await setDoc(fixture)
  await select('苹果')
  await send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await sleep(60)
  await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await sleep(60)
  await send('Input.insertText', { text: '中文' }); await sleep(100)
  check('中文输入法组合只写入最终文字', (await doc()).includes('中文苹果') && !(await doc()).includes('zhong'), await doc())
  await key('z', MOD)
  check('中文输入可以撤销', await doc() === fixture)

  await select('苹果')
  await paste('甲\t乙\t丙\t丁\n一\t二\t三\t四\n五\t六\t七\t八\n九\t十\t十一\t十二')
  const pasted = await doc()
  check('粘贴表格数据自动扩展行列', pasted.includes('| 甲 | 乙 | 丙 | 丁 |') && pasted.includes('| 九 | 十 | 十一 | 十二 |'))
  check('扩列保留原表头和对齐', pasted.includes('| 名称 | 内容 | 数量 |  |') && pasted.includes('| :--- | :---: | ---: | --- |'))
  await key('z', MOD)
  check('多行多列粘贴一步撤销', await doc() === fixture)
  await evaluate(`(() => { const d = v.state.doc.toString(); v.dispatch({ selection: { anchor: d.indexOf('单元格编辑'), head: d.indexOf('苹果') + 1 } }); v.focus() })()`)
  await paste('x\ty')
  check('选区伸到表格外时不按表格数据展开', !(await doc()).includes('| x | y |') && (await doc()).includes('x\ty'), await doc())
  await key('z', MOD)
  check('伸到表格外的粘贴可撤销', await doc() === fixture, await doc())

  for (const [name, source] of [
    ['无外侧竖线', 'A | B\n--- | ---\nx | y\n'],
    ['缩进表格', '  | A | B |\n  |---|---|\n  | x | y |\n'],
    ['引用中的表格', '> | A | B |\n> |---|---|\n> | x | y |\n'],
    ['列表中的表格', '- | A | B |\n  |---|---|\n  | x | y |\n'],
    ['仅有表头', '| A | B |\n|---|---|\n'],
    ['紧凑表格', '|A|B|\n|---|---|\n|x|y|\n'],
    ['转义竖线', '| A | B |\n|---|---|\n| x | y\\| |\n'],
    ['末尾转义竖线', 'A | B\n--- | ---\nx | y\\|\n'],
  ]) {
    await setDoc(source)
    const original = await doc()
    check(`${name}保持原文和列数`, original === source && await evaluate(`document.querySelector('.cm-md-table-header').querySelectorAll('.cm-md-table-cell').length`) === 2)
    await select(source.includes('x') ? 'x' : 'A')
    await key('Enter', MOD)
    const edited = await doc()
    check(`${name}支持增行`, edited.split('\n').length === source.split('\n').length + 1 && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === (source.includes('x') ? 3 : 2))
    await key('z', MOD)
    check(`${name}增行可撤销`, await doc() === original)
    const html = await exportHTML()
    if (name.includes('转义竖线')) check(`${name}显示字面竖线`, html.includes('y|'), html)
    if (source.includes('x')) {
      await select('x')
      await send('Input.imeSetComposition', {text:'zhong', selectionStart:5, selectionEnd:5}); await sleep(60)
      await send('Input.imeSetComposition', {text:'中文', selectionStart:2, selectionEnd:2}); await sleep(60)
      await send('Input.insertText', {text:'中文'}); await sleep(60)
      check(`${name}支持中文输入`, await doc() === source.replace('x', '中文x'), await doc())
      await key('z', MOD)
      check(`${name}中文输入可撤销`, await doc() === source)
    }
    check(`${name}导出保留表格`, html.includes('<table>') && (name !== '引用中的表格' || html.includes('<blockquote><table>')) && (name !== '列表中的表格' || html.includes('<ul><li><table>')))
  }
  const wrapped = '# 多行单元格\n\n| A | B |\n|---|---|\n| first<br>second | last |\n| next | data |\n'
  await setDoc(wrapped)
  await select('first', 2)
  await key('ArrowDown')
  const secondLine = await evaluate('v.state.selection.main.head')
  check('下方向键先移动到格内下一行', secondLine >= wrapped.indexOf('second') && secondLine <= wrapped.indexOf('second') + 6, secondLine)
  await key('ArrowDown')
  const nextRow = await evaluate('v.state.selection.main.head')
  check('格内末行下移进入下一格', nextRow >= wrapped.indexOf('next') && nextRow <= wrapped.indexOf('next') + 4, nextRow)
  await key('ArrowUp')
  const previous = await evaluate('v.state.selection.main.head')
  check('上移进入上一格的最后一行', previous >= wrapped.indexOf('second') && previous <= wrapped.indexOf('second') + 6, previous)
  check('上下移动不改变多行单元格', await doc() === wrapped)
  // 表格后紧挨着的一行会被并进表格，离开时要落到隔着空行的正文上
  const between = '前文\n\n| A | B |\n|---|---|\n| text | value |\n\n## 后文\n'
  await setDoc(between)
  await select('value', 5)
  await key('ArrowDown')
  await type('新')
  check('下方向键离开表格落到下一块正文', await doc() === between.replace('## 后文', '## 新后文') && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 2, await doc())
  await setDoc(between)
  await select('A', 1)
  await key('ArrowUp')
  await type('新')
  check('上方向键离开表格落到上一段末尾', await doc() === between.replace('前文', '前文新'), await doc())
  await setDoc(between)
  await select('value', 5)
  await key('Enter', MOD)
  await key('Enter')
  check('空末行按 Enter 删掉空行', await doc() === between, await doc())
  await type('新')
  check('空末行按 Enter 后输入的是正文', await doc() === between.replace('## 后文', '## 新后文'), await doc())
  await key('z', MOD)
  await key('z', MOD)
  await key('z', MOD)
  check('离开表格的几步都可撤销', await doc() === between, await doc())
  const quoted = '> | A | B |\n> |---|---|\n> | x | y |\n>\n> 引用结尾\n'
  await setDoc(quoted)
  await select('y', 1)
  await key('ArrowDown')
  await type('新')
  check('引用里的表格向下离开落在引用正文前', await doc() === quoted.replace('引用结尾', '新引用结尾'), await doc())
  const spaced = '| A | B |\n|---|---|\n|  | x |\n'
  await setDoc(spaced)
  await clickCell(1, 0)
  await type('空')
  check('只有空格的格子输入后两侧各留一个空格', await doc() === '| A | B |\n|---|---|\n| 空 | x |\n', await doc())
  await key('z', MOD)
  check('空格格子的输入一步撤销', await doc() === spaced, await doc())
  const noNewline = '| A | B |\n|---|---|\n| text | value |'
  await setDoc(noNewline)
  await select('text')
  await key('Enter')
  await key('Enter')
  check('表格末尾空行按 Enter 回到正文', await doc() === noNewline + '\n\n', await doc())
  await type('正文')
  check('无结尾换行的表格后也能继续写作', await doc() === noNewline + '\n\n正文', await doc())
  // 文档以表格开头或结尾时，外面没有能落脚的行：方向键离开要补出空段落，否则光标被夹回格子里
  await setDoc(noNewline)
  await sleep(600)
  await select('value', 5)
  await key('ArrowDown')
  check('文末表格按下方向键离开并留出空行', await doc() === noNewline + '\n\n' && await head() === noNewline.length + 2, await doc())
  await type('正文')
  check('离开文末表格后输入的是正文', await doc() === noNewline + '\n\n正文' && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 2, await doc())
  await setDoc(noNewline + '\n')
  await sleep(600)
  await select('value', 5)
  await key('ArrowRight')
  check('结尾只有换行时右方向键离开表格补一个空行', await doc() === noNewline + '\n\n' && await head() === noNewline.length + 2, await doc())
  await setDoc(noNewline + '\n')
  await sleep(600)
  await select('A')
  await key('ArrowUp')
  check('文首表格按上方向键离开并留出空行', await doc() === '\n\n' + noNewline + '\n' && await head() === 0, await doc())
  await key('z', MOD)
  check('离开表格补的空行可撤销', await doc() === noNewline + '\n', await doc())
  const longTable = '# 长表格\n\n| A | B |\n|---|---|\n' + Array.from({length:1200}, (_,i)=>`| row-${i} | 内容-${i} |`).join('\n') + '\n'
  await setDoc(longTable)
  await evaluate(`v.scrollDOM.scrollTop=v.scrollDOM.scrollHeight`)
  for (let i=0;i<60 && !await evaluate(`v.contentDOM.textContent.includes('row-1199')`);i++) await sleep(50)
  check('长表格滚动到底部仍然渲染', await evaluate(`v.contentDOM.textContent.includes('row-1199') && !!document.querySelector('.cm-md-table-last .cm-md-table-cell')`))
  check('长表格只渲染视口附近的单元格', await evaluate(`document.querySelectorAll('.cm-md-table-cell').length < 2400`))
  check('长表格虚拟占位保持表格布局', await evaluate(`([...v.contentDOM.querySelectorAll('.cm-md-table-widget:has(> .cm-gap)')]).every(table => getComputedStyle(table).display === 'table')`))
  await evaluate(`v.scrollDOM.scrollTop=0`)
  for (let i=0;i<60 && !await evaluate(`!!document.querySelector('.cm-md-table-header')`);i++) await sleep(50)
  check('长表格往返滚动不改写原文', await doc() === longTable)
  const scrolling = '| 场景 | 示例 | 备注 |\n|---|---|---|\n| 换行 | 第一行<br>第二行<br>第三行 | 说明 |\n| 长英文 | document_export_configuration_preview | 比较长的备注内容用于分配列宽 |\n\n' + '表格之间的正文。\n\n'.repeat(40)
    + '| 编号 | 地区 | 产品 | 数量 | 金额（元） | 备注 |\n| :---: | :---: | :--- | ---: | ---: | :--- |\n'
    + Array.from({ length: 160 }, (_, i) => `| ${i + 1} | 杭州 | 文档模板 | ${i + 8} | ${(i * 123.45).toFixed(2)} | ${i % 13 ? '可以直接修改' : '这是一段较长的备注，用于检查内容滚出视口时各列是否仍然保持原来的宽度。'} |`).join('\n')
    + '\n\n' + '表格之后的正文。\n\n'.repeat(40)
  for (const theme of ['light', 'elegant', 'nord']) {
    await setTheme(theme)
    await setDoc(scrolling)
    const widths = await evaluate(`(async () => {
      const previous = new Map(); let delta = 0, samples = 0
      const sample = () => document.querySelectorAll('#editor .cm-content .cm-md-table-widget').forEach(table => {
        const rect = table.getBoundingClientRect()
        const row = table.querySelector('.cm-md-table-row')
        if (!row || rect.bottom < 36 || rect.top > innerHeight) return
        const current = Array.from(row.querySelectorAll('.cm-md-table-cell')).map(cell => cell.getBoundingClientRect().width)
        const last = previous.get(table.dataset.tableFrom)
        if (last) current.forEach((width, column) => { delta = Math.max(delta, Math.abs(width - last[column])) })
        previous.set(table.dataset.tableFrom, current); samples++
      })
      const bottom = v.scrollDOM.scrollHeight - v.scrollDOM.clientHeight
      for (const direction of [1, -1]) for (let offset = 0; offset <= bottom; offset += 280) {
        v.scrollDOM.scrollTop = direction > 0 ? offset : bottom - offset
        sample(); await new Promise(resolve => requestAnimationFrame(resolve)); sample()
      }
      return {delta, samples, tables:previous.size}
    })()`)
    check(`${theme} 表格滚出再滚回视口时列宽稳定`, widths.delta < 1 && widths.tables === 2 && widths.samples > 20, JSON.stringify(widths))
    check(`${theme} 滚动保持源码与虚拟渲染`, await doc() === scrolling && await evaluate(`document.querySelectorAll('#editor .cm-content .cm-md-table-cell').length < 160 * 6`))
  }
  await setDoc(fixture)
  const out = await exportHTML()
  check('HTML 导出为语义表格并保留格式', /<table><thead>/.test(out) && out.includes('<strong>加粗</strong>') && out.includes('<code>代码</code>') && !out.includes('cm-md-table-marker'))
  await evaluate(`document.getElementById('source-toggle-btn').click()`)
  check('源码模式包含原始表格', await evaluate(`document.getElementById('source-editor').value`) === fixture)
  await evaluate(`document.getElementById('source-toggle-btn').click()`)
  check('退出源码模式恢复可编辑表格', await doc() === fixture && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 4)
  await evaluate(`document.body.classList.add('presenting')`)
  check('放映保持表格列布局和页码', await evaluate(`getComputedStyle(document.querySelector('.cm-md-table-header')).display === 'table-row' && document.querySelector('.cm-md-table-widget:has(.cm-md-table-row)').classList.contains('cm-md-page-0')`))
  await evaluate(`document.body.classList.remove('presenting')`)
  await evaluate('window.__colamdPrintExport.enter()')
  check('图片和 PDF 布局仍保留表格', await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 4)
  await evaluate('window.__colamdPrintExport.exit()')
  check('导出不改变原文', await doc() === fixture)
  await sleep(1200)
  const second = join(dir, 'other.md')
  const otherText = '# 另一篇文档\n\n| X | Y |\n|---|---|\n| 独立 | 内容 |\n'
  writeFileSync(second, otherText)
  const originalTime = statSync(file).mtimeMs
  await evaluate(`document.querySelector('.tab-new-btn').click()`); await sleep(150)
  await evaluate(`window.electronAPI.openSibling(${JSON.stringify(second)})`)
  for (let i = 0; i < 50 && !(await doc()).includes('独立'); i++) await sleep(100)
  await select('独立', 2)
  await type('改')
  await sleep(1200)
  check('另一标签的编辑只保存到它自己的文件', readFileSync(second, 'utf8').includes('独立改') && readFileSync(file, 'utf8') === fixture && statSync(file).mtimeMs === originalTime)
  await evaluate(`Array.from(document.querySelectorAll('.tab-entry')).find(tab=>tab.textContent.includes('tables')).click()`)
  await sleep(150)
  check('切回原标签保留表格与内容', await doc() === fixture && await evaluate(`document.querySelectorAll('.cm-md-table-row').length`) === 4)
  await key('z', MOD)
  check('撤销不会带入另一标签的内容', !(await doc()).includes('独立改') && readFileSync(second, 'utf8').includes('独立改'))
  await setDoc(fixture)
  check('运行时没有异常', errors.length === 0, JSON.stringify(errors))
  await sleep(1200)
  check('自动保存与缓冲区一致', readFileSync(file, 'utf8') === fixture)
  console.log(`\n${passed} 项表格检查通过`)
} finally {
  ws?.close()
  mainWS?.close()
  child.kill('SIGTERM')
  stopVerifyApp(udd)
}
