// Mermaid 语法画成 SVG，由 Pele 渲染（Obsidian 那个渲染库，MIT，无运行时依赖）。
//
// Pele 是同步的，所以这里没有沙箱 iframe，也没有超时重置那一套：整个文件只剩一个
// promise，用来懒加载——没写图表的文档不该为它付启动成本。
//
// 配色不在这里挑。Pele 生成的 SVG 里写的是 `var(--pele-*)`，在它落进的那个文档里取值，
// 所以换主题不用重画（映射见 themes/editor-preview.css 的 `.cm-md-mermaid`）。唯一的例外
// 是 Word 导出：SVG 要塞进 `<img>` 的 data URL，那是个独立文档，主题的变量到不了，
// 只能把一套浅色值内联进根元素。

// 图里文字的字体族：**测量和绘制必须是同一个**，否则 CJK 标签会被量窄、裁掉右半边
// （#94）。也刻意不跟着正文的字体设置走：用户选的是写作的字体，图不该跟着变。
const DIAGRAM_FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
const DIAGRAM_MONO_FONT = "'SF Mono', 'Fira Code', Menlo, Consolas, monospace"

// Word 导出是一张白纸，不管应用现在是什么主题。这套值就是应用自己的浅色主题
// （base.css 的 `:root, body.theme-light`）加上同一套百分比推出来的，所以上纸的图和
// 界面上浅色主题下的图长得一样。刻意**不**沿用引擎的默认色：那是别人的取值，变了
// 我们也看不见。
const PRINT_PALETTE: Record<string, string> = {
  '--pele-bg': '#ffffff',
  '--pele-fg': '#24292f',
  '--pele-muted': '#656d76',
  '--pele-line': '#24292f',
  '--pele-surface': '#d8d8da',
  '--pele-surface-alt': '#c2c3c5',
  '--pele-border': '#9c9fa1',
  '--pele-accent': '#0969da',
}

let pele: Promise<typeof import('pele/lazy')> | null = null

function loadPele(): Promise<typeof import('pele/lazy')> {
  pele ??= import('pele/lazy')
  return pele
}

// 把浅色值写进根元素的行内样式。要写在 Pele 自己那串前面：它那串里是
// `--_bg: var(--pele-bg)` 这种取值语句，得先有定义。
function withPrintPalette(svg: string): string {
  const declarations = Object.entries(PRINT_PALETTE)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  const tagEnd = svg.indexOf('>')
  if (tagEnd < 0) return svg
  const tag = svg.slice(0, tagEnd)
  const patched = tag.includes(' style="')
    ? tag.replace(' style="', ` style="${declarations};`)
    : `${tag} style="${declarations}"`
  return patched + svg.slice(tagEnd)
}

/**
 * 画一张图。`print` 给的是要离开这个文档的 SVG（Word 导出），配色内联进去。
 * 画不出来就 reject，调用方把代码块原样留着：宁可难看，不吞用户的字。
 *
 * 走 `pele/lazy`：它认图表类型，只把那一种的分块拉进来。全量入口是 677KB，
 * 一篇只画了一个流程图的笔记不该为甘特图和雷达图付内存。
 */
export async function renderMermaid(code: string, options: { print?: boolean } = {}): Promise<string> {
  const { renderAsync } = await loadPele()
  const { svg } = await renderAsync(code, {
    fontFamily: DIAGRAM_FONT,
    fontFamilyMono: DIAGRAM_MONO_FONT,
  })
  return options.print ? withPrintPalette(svg) : svg
}
