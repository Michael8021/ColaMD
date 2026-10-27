// 真实 Electron 按键与鼠标验收；复制会写系统剪贴板，运行前后需保存并恢复。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp } from './verify-workdir.mjs'

assertBuildFresh()
const root = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync('/tmp/colamd-inline-math-')
const output = process.env.COLAMD_MATH_OUTPUT
if (output) mkdirSync(output, { recursive: true })
const file = join(directory, 'caret.md')
writeFileSync(file, '光标验证\n')
const launcher = join(directory, 'launch.cjs')
writeFileSync(launcher, `globalThis.__mathElectron=require('electron');const {app}=globalThis.__mathElectron;const {mkdirSync}=require('fs');mkdirSync(${JSON.stringify(directory+'/home')},{recursive:true});app.setPath('home',${JSON.stringify(directory+'/home')});app.on('browser-window-created',(_event,win)=>{win.setSize(1000,760);win.webContents.setBackgroundThrottling(false)});require(${JSON.stringify(join(root, 'dist/main/index.js'))})`)
const port = 10100 + Math.floor(Math.random() * 200)
const electron = createRequire(import.meta.url)('electron')
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [launcher, file, `--user-data-dir=${directory}/profile`, `--remote-debugging-port=${port}`, `--inspect=${port+1000}`], { cwd: root, env: environment, stdio: 'ignore' })
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let socket, mainSocket, sequence = 0, passed = 0
const failures = [], runtimeErrors = [], pending = new Map()
const check = (name, valid, detail) => {
  if (valid) { passed++; console.log(`PASS ${name}`) }
  else { failures.push({ name, detail }); console.log(`FAIL ${name} ${JSON.stringify(detail)}`) }
}
try {
  let page
  for (let attempt = 0; attempt < 150 && !page; attempt++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.type === 'page') } catch {}
    if (!page) await pause(100)
  }
  assert(page, 'Electron 未启动')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params)
    if (!message.id) return
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (!request) return
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 30000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const mainTarget = (await (await fetch(`http://127.0.0.1:${port+1000}/json/list`)).json()).find(target=>target.type==='node')
  mainSocket = new WebSocket(mainTarget.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{mainSocket.addEventListener('open',resolve);mainSocket.addEventListener('error',reject)})
  const mainEval = expression => new Promise((resolve,reject)=>{
    const id=++sequence
    const timer=setTimeout(()=>{mainSocket.removeEventListener('message',receive);reject(new Error('主进程调试超时'))},30000)
    const receive=event=>{const m=JSON.parse(event.data);if(m.id!==id)return;clearTimeout(timer);mainSocket.removeEventListener('message',receive);if(m.error||m.result.exceptionDetails)reject(new Error(JSON.stringify(m)));else resolve(m.result.result.value)}
    mainSocket.addEventListener('message',receive)
    mainSocket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}))
  })
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let attempt = 0; attempt < 100 && !(await evaluate(`!!document.querySelector('#editor .cm-content')`)); attempt++) await pause(100)
  await evaluate(`window.v=document.querySelector('#editor .cm-content').cmTile.root.view; v.focus()`)
  for(let attempt=0;attempt<100 && !(await evaluate(`v.state.doc.toString()==='光标验证\\n'`));attempt++)await pause(100)
  assert(await evaluate(`v.state.doc.toString()==='光标验证\\n'`),'初始磁盘夹具尚未载入')
  const key = async (name, modifiers = 0) => {
    const codes = { Enter: 13, Tab: 9, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, z: 90, Backspace: 8, Delete: 46 }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: codes[name], modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, modifiers })
    await pause(60)
  }
  const mod = process.platform === 'darwin' ? 4 : 2
  const setDoc = async text => {
    await evaluate(`v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(text)}},selection:{anchor:0}});v.focus();v.scrollDOM.scrollTop=0`)
    await pause(220)
  }
  const select = async (text, offset = text.length, length = 0) => {
    await evaluate(`(()=>{const anchor=v.state.doc.toString().indexOf(${JSON.stringify(text)})+${offset};v.dispatch({selection:{anchor,head:anchor+${length}}});v.focus()})()`)
    await pause(100)
  }
  const settle = async () => {
    await evaluate(`v.requestMeasure();v.coordsAtPos(v.state.selection.main.head)`)
    await pause(70)
  }
  const clickPoint = async (point, modifiers = 0) => {
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1, modifiers })
    await settle()
  }
  const snapshot = () => evaluate(`(()=>{const s=v.state.selection.main,c=v.dom.querySelector('.cm-cursor')?.getBoundingClientRect();let glyph=null;const walker=document.createTreeWalker(v.contentDOM,NodeFilter.SHOW_TEXT);for(let n;n=walker.nextNode();){if(n.parentElement.closest('.cm-md-math'))continue;const start=v.posAtDOM(n,0),end=start+n.length;if(s.head>=start&&s.head<=end){const r=document.createRange();r.setStart(n,s.head-start);r.collapse(true);const b=r.getBoundingClientRect();if(b.height){glyph={left:b.left,top:b.top,bottom:b.bottom};break}}}return {head:s.head,anchor:s.anchor,doc:v.state.doc.toString(),widgets:v.contentDOM.querySelectorAll('.cm-md-math-inline').length,sources:v.contentDOM.querySelectorAll('.cm-md-math-source').length,markers:[...v.contentDOM.querySelectorAll('.cm-md-marker')].map(e=>({text:e.textContent,color:getComputedStyle(e).color})),caret:c&&{left:c.left,top:c.top,bottom:c.bottom},glyph,scroll:v.scrollDOM.scrollTop}})()`)
  const inspect = async (name, expectedHead, expanded, total = 1) => {
    await settle()
    const result = await snapshot()
    check(name + ' 源码位置', result.head === expectedHead, result)
    check(name + ' 替换状态', result.sources === (expanded ? 1 : 0) && result.widgets === total - (expanded ? 1 : 0), result)
    check(name + ' 实际光标贴住文字', result.caret && result.glyph && Math.abs(result.caret.left-result.glyph.left)<=2 && Math.abs(result.caret.top-result.glyph.top)<=5, result)
    if(expanded) check(name + ' 定界符暗显',result.markers.length===2 && result.markers.every(m=>m.text==='$') && result.markers[0].color!==await evaluate('getComputedStyle(v.contentDOM).color'),result)
  }
  const screenshot = async name => {
    if (!output) return
    await pause(80)
    const image = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `${name}.png`), Buffer.from(image.data, 'base64'))
  }
  const formula = '$E=mc^2$'
  const cases = [
    ['正文', '上行 abcdefghijklmnop\nabc '+formula+' def\n下行 abcdefghijklmnop\n'],
    ['列表', '- abc '+formula+' def\n- 后项\n'],
    ['引用', '> abc '+formula+' def\n> 后行\n'],
    ['标题', '## abc '+formula+' def\n\n后文\n'],
  ]
  // 合并工作树自动增加同一套格内行为，单独 main 分支不依赖表格重构。
  await setDoc('| A | B |\n|---|---|\n| abc '+formula+' def | other |\n| next | value |\n\n后文\n')
  const tableEditing = await evaluate(`!!v.contentDOM.querySelector('.cm-md-table-cell')`)
  if(tableEditing) cases.push(['表格', '| A | B |\n|---|---|\n| abc '+formula+' def | other |\n| next | value |\n\n后文\n'])
  for (const [label, text] of cases) {
    await setDoc(text)
    const from=text.indexOf(formula), to=from+formula.length
    await select(formula, -1)
    await inspect(label+' 公式前空格', from-1, false)
    await key('ArrowRight')
    await inspect(label+' 起点保持渲染', from, false)
    await screenshot(label+'-01-boundary')
    for(let position=from+1;position<to;position++) {
      await key('ArrowRight')
      await inspect(label+' 右移'+(position-from),position,true)
      await screenshot(label+'-02-right-'+(position-from))
    }
    await key('ArrowRight')
    await inspect(label+' 右离开',to,false)
    await screenshot(label+'-03-exit-right')
    for(let position=to-1;position>from;position--) {
      await key('ArrowLeft')
      await inspect(label+' 左移'+(position-from),position,true)
      await screenshot(label+'-04-left-'+(position-from))
    }
    await screenshot(label+'-04-left-before-exit')
    await key('ArrowLeft')
    await inspect(label+' 左离开',from,false)
    await screenshot(label+'-05-exit-left')
    await key('ArrowRight',8)
    let selected=await snapshot()
    check(label+' Shift右覆盖完整原子',selected.anchor===from && selected.head===to && selected.widgets===1 && selected.sources===0,selected)
    check(label+' 选区复制源码',await evaluate('v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)')===formula)
    await mainEval(`__mathElectron.BrowserWindow.getAllWindows()[0].webContents.copy()`)
    let copied=''
    for(let attempt=0;attempt<20;attempt++) {copied=await mainEval(`__mathElectron.clipboard.readText()`);if(copied===formula)break;await pause(50)}
    check(label+' 真实复制得到公式源码',copied===formula,{copied})
    await screenshot(label+'-06-shift-select')
    await select(formula)
    await key('ArrowLeft',8)
    selected=await snapshot()
    check(label+' Shift左覆盖完整原子',selected.anchor===to && selected.head===from && selected.widgets===1 && selected.sources===0,selected)
    for(const [keyName,offset,expected] of [['Backspace',formula.length,to-1],['Delete',0,from+1]]) {
      await select(formula,offset)
      await key(keyName)
      check(label+' '+keyName+' 首次不删文档',(await snapshot()).doc===text)
      await inspect(label+' '+keyName+' 首次进入',expected,true)
      await screenshot(label+'-07-'+keyName)
      await key(keyName)
      check(label+' '+keyName+' 第二次按字删除',(await snapshot()).doc.length===text.length-1,await snapshot())
      await key('z',mod)
      check(label+' 删除撤销恢复原文',(await snapshot()).doc===text,await snapshot())
    }
    await setDoc(text)
    for(const ratio of [0.1,0.5,0.9]) {
      await select(formula,0)
      const point=await evaluate(`(()=>{const r=v.contentDOM.querySelector('.cm-md-math-inline').getBoundingClientRect();return {x:r.left+r.width*${ratio},y:(r.top+r.bottom)/2}})()`)
      await clickPoint(point)
      const expected=from+1+Math.round(ratio*(formula.length-2))
      await inspect(label+' 鼠标比例'+ratio,expected,true)
      await screenshot(label+'-08-click-'+ratio)
    }
    await select(formula,-1)
    const shiftPoint=await evaluate(`(()=>{const r=v.contentDOM.querySelector('.cm-md-math-inline').getBoundingClientRect();return {x:r.left+r.width*0.95,y:(r.top+r.bottom)/2}})()`)
    await clickPoint(shiftPoint,8)
    await screenshot(label+'-08-shift-click')
    const shifted=await snapshot()
    check(label+' Shift点击保留跨公式选区',shifted.anchor===from-1 && shifted.head===to && shifted.widgets===1,shifted)
    for(const offset of [-1,formula.length+1]) {
      await select(formula,offset)
      const point=await evaluate(`(()=>{const s=v.state.selection.main,r=v.coordsAtPos(s.head);return {x:r.left,y:(r.top+r.bottom)/2}})()`)
      await clickPoint(point)
      check(label+' 本体外点击不展开'+offset,(await snapshot()).widgets===1 && (await snapshot()).sources===0,await snapshot())
      await screenshot(label+'-08-outside-'+offset)
    }
    await select(formula,2,2)
    check(label+' 内部选区展开',(await snapshot()).sources===1,await snapshot())
    await screenshot(label+'-08-inside-selection')
    await select(formula,-1,formula.length+2)
    check(label+' 跨节点选区渲染',(await snapshot()).widgets===1,await snapshot())
    await screenshot(label+'-08-cross-selection')
    // 真实组字生命周期，结束后再检查普通导航，不靠固定定时器假装结束输入法。
    await select(formula,2)
    await send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5})
    await screenshot(label+'-09-ime-composing')
    await send('Input.insertText',{text:'中文'})
    await send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0})
    await settle()
    const edited=await snapshot()
    check(label+' 组字提交源码和落点',edited.doc===text.slice(0,from+2)+'中文'+text.slice(from+2) && edited.head===from+4,edited)
    check(label+' 组字结束仍展开',edited.sources===1 && !await evaluate('v.composing'),edited)
    await key('z',mod)
    check(label+' 组字一次撤销',(await snapshot()).doc===text,await snapshot())
    await screenshot(label+'-09-ime-undo')
    await key('z',mod|8)
    check(label+' 组字重做',(await snapshot()).doc===edited.doc && (await snapshot()).head===edited.head,await snapshot())
    await screenshot(label+'-09-ime-redo')
    await select('def',0)
    check(label+' 编辑后离开恢复渲染',(await snapshot()).widgets===1,await snapshot())
    await setDoc(text)
    await select(formula,3)
    for(const mode of ['source','render']) {
      const point=await evaluate(`(()=>{const r=document.getElementById('source-toggle-btn').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      await clickPoint(point)
      await pause(120)
      const position=await evaluate(mode==='source'?`document.getElementById('source-editor').selectionStart`:'v.state.selection.main.head')
      check(label+' 源码切换'+mode+'保留光标',position===from+3,{position})
      if(mode==='render')await inspect(label+' 切回渲染仍可编辑',from+3,true)
      await screenshot(label+'-10-mode-'+mode)
    }
    // 直接走产品已有清洁 HTML 与打印生命周期入口。
    const html=await evaluate('window.__colamdExportDocumentHTML()')
    check(label+' 清洁HTML始终渲染',html.includes('katex')&&!html.includes('cm-md-math-source')&&!html.includes('$E=mc^2$'),{html})
    await evaluate('window.__colamdPrintExport.enter()')
    await settle()
    check(label+' 打印态始终渲染',(await snapshot()).widgets===1 && (await snapshot()).sources===0,await snapshot())
    await screenshot(label+'-11-print')
    await evaluate('window.__colamdPrintExport.exit()')
    await inspect(label+' 导出结束恢复内部编辑',from+3,true)
  }
  // 上下移动落到公式横向范围，必须按原子区间落在两侧。
  for(const keyName of ['ArrowDown','ArrowUp']) {
    const text='abcdefghijklmnopqrstuv\nabc '+formula+' def\nabcdefghijklmnopqrstuv\n'
    await setDoc(text)
    await select('abcdefghijklmnopqrstuv',keyName==='ArrowDown'?7:0)
    if(keyName==='ArrowUp')await evaluate(`v.dispatch({selection:{anchor:v.state.doc.line(3).from+7}})`)
    await key(keyName)
    const state=await snapshot(),from=text.indexOf(formula),to=from+formula.length
    check(keyName+' 原子范围不落入公式内部',!(state.head>from&&state.head<to)&&state.widgets===1,state)
    await screenshot('vertical-'+keyName)
  }
  // 同格/同行的其它公式不因当前公式编辑而展开，普通 Markdown 标记仍隐藏。
  await setDoc('abc $x$ 与 $a^2+b^2$ **粗体** [链接](https://example.com) def\n')
  await select('$x$',1)
  check('只展开当前公式',(await snapshot()).widgets===1 && (await snapshot()).sources===1,await snapshot())
  check('其他Markdown标记仍隐藏',!await evaluate(`v.contentDOM.textContent.includes('**')||v.contentDOM.textContent.includes('https://example.com')`))
  await screenshot('only-current-math')
  // LaTeX 和双美元行内定界符也遵循同一节点规则。
  for(const raw of ['\\(x=1\\)','$$x=1$$']) {
    await setDoc('abc '+raw+' def\n');await select(raw,0);await key('ArrowRight')
    const s=await snapshot()
    check(raw+' 进入完整开定界符之后',s.head===6 && s.sources===1,s)
    await select('def',0)
    check(raw+' 离开恢复渲染',(await snapshot()).widgets===1,await snapshot())
  }
  if(tableEditing) {
    const text='| A | B |\n|---|---|\n| abc '+formula+' def | other |\n| next | value |\n\n后文\n'
    await setDoc(text);await select(formula,2)
    await key('Tab')
    await screenshot('table-tab-next-cell')
    check('表格公式内 Tab 到下一格',await evaluate(`v.state.doc.sliceString(v.state.selection.main.from,v.state.selection.main.to)==='other'`),await snapshot())
    await key('ArrowDown')
    await screenshot('table-down-next-row')
    check('表格下一格 ↓ 保持列',await evaluate(`v.state.doc.lineAt(v.state.selection.main.head).text.includes('value')`),await snapshot())
    await key('ArrowUp')
    await screenshot('table-up-original-row')
    check('表格 ↑ 返回原行',await evaluate(`v.state.doc.lineAt(v.state.selection.main.head).text.includes('other')`),await snapshot())
    const scrolledText=Array.from({length:24},(_,i)=>'前文'+i+'正文正文正文正文正文正文。\n\n').join('')+text
    await setDoc(scrolledText)
    await select(formula,3)
    await evaluate(`v.dispatch({selection:v.state.selection,scrollIntoView:true})`)
    await settle()
    await evaluate(`(()=>{const r=v.coordsAtPos(v.state.selection.main.head),viewport=v.scrollDOM.getBoundingClientRect();v.scrollDOM.scrollTop+=(r.top+r.bottom)/2-(viewport.top+viewport.height/2);v.requestMeasure()})()`)
    await settle()
    const scroll=(await snapshot()).scroll
    check('表格列宽测试已有非零滚动',scroll>100,{scroll})
    await send('Input.insertText',{text:'abcdefghijklmnop'.repeat(5)})
    await settle()
    check('表格列宽变化不滚动跳变',Math.abs((await snapshot()).scroll-scroll)<=2,await snapshot())
    await screenshot('table-width-edit')
    await key('z',mod)
    check('格内公式输入撤销不破坏表格',(await snapshot()).doc===scrolledText && await evaluate(`v.contentDOM.querySelectorAll('.cm-md-table-cell').length===6`),await snapshot())
    await screenshot('table-width-undo')
    const beforeResize=await snapshot()
    const beforeWidth=await evaluate(`v.contentDOM.querySelector('.cm-md-table-cell').getBoundingClientRect().width`)
    await mainEval(`__mathElectron.BrowserWindow.getAllWindows()[0].setSize(820,760,false)`)
    await settle();await pause(150)
    const resized=await snapshot(),afterWidth=await evaluate(`v.contentDOM.querySelector('.cm-md-table-cell').getBoundingClientRect().width`)
    check('表格缩窗确实改变列宽',Math.abs(afterWidth-beforeWidth)>10,{beforeWidth,afterWidth})
    check('表格列宽重测保持视口',Math.abs(resized.scroll-beforeResize.scroll)<=2,{before:beforeResize.scroll,after:resized.scroll})
    check('表格列宽重测后光标贴住字形',resized.caret&&resized.glyph&&Math.abs(resized.caret.left-resized.glyph.left)<=2&&Math.abs(resized.caret.top-resized.glyph.top)<=5,resized)
    await screenshot('table-width-resize')
    await mainEval(`__mathElectron.BrowserWindow.getAllWindows()[0].setSize(1000,760,false)`)
    await settle()
  }
  await setDoc('abc $a**b**$ def\n')
  await select('$a**b**$',2)
  check('公式内部Markdown字符全部可编辑',await evaluate(`v.contentDOM.querySelector('.cm-md-math-source').textContent==='$a**b**$'`),await snapshot())
  for(const theme of ['light','dark']) {
    await evaluate(`for(const name of [...document.body.classList])if(name.startsWith('theme-'))document.body.classList.remove(name);document.body.classList.add('theme-${theme}')`)
    await setDoc('abc '+formula+' def\n');await select(formula,0)
    await screenshot(theme+'-rendered')
    await key('ArrowRight')
    await inspect(theme+'主题进入公式',5,true)
    await screenshot(theme+'-source')
    await select('def',0)
    check(theme+'主题离开恢复渲染',(await snapshot()).widgets===1,await snapshot())
    await screenshot(theme+'-restored')
  }
  check('运行时无异常',!runtimeErrors.length,runtimeErrors)
  const result={passed,failures,runtimeErrors,tableEditing}
  if(output)writeFileSync(join(output,'results.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result,null,2))
  assert.equal(failures.length,0,`${failures.length} 项公式检查失败`)
} finally {
  mainSocket?.close()
  socket?.close()
  for(const request of pending.values())clearTimeout(request.timer)
  child.kill('SIGTERM')
  stopVerifyApp(`${directory}/profile`)
  rmSync(directory,{recursive:true,force:true})
}
