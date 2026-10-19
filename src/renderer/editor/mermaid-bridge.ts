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
import { isChinese } from '../ui-language'
import type { Zoom } from 'pele/lazy'

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

// ─── 图上的缩放（#129） ──────────────────────────────────────────────────────

// SVG 的 `max-width: 100%` 会把画不下的图压窄，压到多窄都是看不清。Pele 的
// enableZoom 只在图**确实画不下**的时候才启用，还给了控件和 Ctrl/⌘+滚轮：够宽的图
// 不会平白多出一排按钮，单滚轮也照旧滚文档（它只认 Ctrl/⌘+滚轮，不抢页面滚动）。
//
// 每张图一个 ResizeObserver，所以 widget 被拆掉时必须 destroy，否则观察器会一直
// 挂着一块已经不在的 DOM。
interface DiagramZoom {
  zoom: Zoom | null
}

const zooms = new WeakMap<HTMLElement, DiagramZoom>()
const zoomHosts = new Set<HTMLElement>()

/** 现在是「放大」状态吗？放得下与放大态下的手势规则不一样。 */
function isZoomed(record: DiagramZoom): boolean {
  return !!record.zoom && record.zoom.scale > record.zoom.fit * 1.001
}

/** 这张图现在是不是被放大了（放大态下拖图是挪图，不是选字）。 */
export function isDiagramZoomed(host: HTMLElement): boolean {
  const record = zooms.get(host)
  return !!record && isZoomed(record)
}

/** 图挂上去了，给它装上缩放。图本身画得下的时候什么都看不见。 */
export function attachDiagramZoom(host: HTMLElement): void {
  if (zooms.has(host)) return
  const record: DiagramZoom = { zoom: null }
  zooms.set(host, record)
  zoomHosts.add(host)
  void loadPele().then(({ enableZoom }) => {
    // 引擎是懒加载的，回来时这块 DOM 可能已经被换掉了
    if (!host.isConnected) return
    record.zoom = enableZoom(host, {
      labels: isChinese()
        ? { zoomIn: '放大', zoomOut: '缩小', reset: '还原到适合宽度' }
        : { zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Reset zoom' },
    })
  })
}

/** widget 没了，连观察器一起收掉。 */
export function detachDiagramZoom(host: HTMLElement): void {
  const record = zooms.get(host)
  if (!record) return
  zooms.delete(host)
  zoomHosts.delete(host)
  record.zoom?.destroy()
}

/**
 * 导出（PNG / PDF）拿的是屏幕上这份 DOM 的序列化结果，缩放会跟着一起出去：用户放大看图
 * 之后导出，纸上就是一角被裁掉的图，右上角还多一排缩放按钮。所以序列化之前把视口还原、
 * 把控件藏起来，序列化完立刻恢复（同步的，屏幕上不会闪）。
 */
export function withDiagramZoomPaused<T>(run: () => T): T {
  const hidden: { element: HTMLElement; display: string }[] = []
  for (const host of zoomHosts) {
    zooms.get(host)?.zoom?.reset()
    const controls = host.querySelector<HTMLElement>('.pele-zoom')
    if (controls && controls.style.display !== 'none') {
      hidden.push({ element: controls, display: controls.style.display })
      controls.style.display = 'none'
    }
  }
  try {
    return run()
  } finally {
    for (const item of hidden) item.element.style.display = item.display
  }
}
