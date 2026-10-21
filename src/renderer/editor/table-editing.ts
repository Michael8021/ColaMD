import { Annotation, EditorSelection, EditorState, Prec, StateEffect, StateField, type ChangeSpec, type Line, type Range, type Transaction, type TransactionSpec } from '@codemirror/state'
import { BlockWrapper, Decoration, EditorView, ViewPlugin, WidgetType, keymap, type Rect, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { frontmatterRange } from './math-scan'
import { isChinese } from '../ui-language'
import { livePreviewField } from './live-preview'

export interface TableCell {
  /** 含两侧竖线的整格 */
  from: number
  to: number
  /** 竖线之间 */
  left: number
  right: number
  /** 去掉首尾空白后的内容 */
  start: number
  end: number
}

export interface TableRow {
  from: number
  to: number
  cells: TableCell[]
  trailing: boolean
}

export interface MarkdownTable {
  from: number
  to: number
  rows: TableRow[]
  delimiter: TableRow
  align: string[]
}

/** 数字与金额：不拆行，算最小列宽时按整段计 */
const NUMERIC = /^[+-]?\d[\d,.]*%?$/

const tableCache = new WeakMap<EditorState['doc'], Map<string, MarkdownTable>>()

function readRow(state: EditorState, node: SyntaxNode): TableRow {
  const text = state.sliceDoc(node.from, node.to)
  const pipes: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '|') pipes.push(i)
  }
  const leading = pipes[0] === 0
  const trailing = pipes.at(-1) === text.length - 1
  const dividers = pipes.slice(leading ? 1 : 0, trailing ? -1 : undefined)
  const starts = [0, ...dividers]
  const ends = [...dividers, text.length]
  const cells = starts.map((from, index) => {
    const to = ends[index]
    const left = from + (text[from] === '|' ? 1 : 0)
    const right = to - (index === ends.length - 1 && trailing ? 1 : 0)
    const value = text.slice(left, right)
    const start = left + (value.match(/^[ \t]*/)?.[0].length ?? 0)
    const end = Math.max(start, right - (value.match(/[ \t]*$/)?.[0].length ?? 0))
    return { from: node.from + from, to: node.from + to, left: node.from + left, right: node.from + right, start: node.from + start, end: node.from + end }
  })
  return { from: node.from, to: node.to, cells, trailing }
}

export function readTable(state: EditorState, node: SyntaxNode): MarkdownTable {
  const key = `${node.from}:${node.to}`
  let cache = tableCache.get(state.doc)
  const cached = cache?.get(key)
  if (cached) return cached
  const rows: TableRow[] = []
  let delimiter!: TableRow
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader' || child.name === 'TableRow') rows.push(readRow(state, child))
    else if (child.name === 'TableDelimiter') delimiter = readRow(state, child)
  }
  const align = delimiter.cells.map(cell => {
    const text = state.sliceDoc(cell.start, cell.end)
    return text.endsWith(':') ? (text.startsWith(':') ? 'center' : 'right') : 'left'
  })
  const table = { from: node.from, to: node.to, rows, delimiter, align }
  if (!cache) tableCache.set(state.doc, cache = new Map())
  cache.set(key, table)
  return table
}

/** 分隔符不参与表格布局，但选区仍需要它的坐标。用相邻格子的边界代替隐藏元素的空矩形。 */
class TableBoundary extends WidgetType {
  constructor(readonly column: number, readonly end = false) { super() }
  eq(other: TableBoundary): boolean { return this.column === other.column && this.end === other.end }
  toDOM(): HTMLElement { return document.createElement('span') }
  coordsAt(dom: HTMLElement): Rect | null {
    const cell = dom.closest('.cm-md-table-row')?.querySelector<HTMLElement>(`.cm-md-table-cell[data-column="${this.column}"]`)
    if (!cell) return null
    const rect = cell.getBoundingClientRect()
    const x = this.end ? rect.right : rect.left
    return { left: x, right: x, top: rect.top, bottom: rect.bottom }
  }
}

class EmptyTableCell extends WidgetType {
  constructor(readonly column: number, readonly align: string, readonly allowInput = true) { super() }
  eq(other: EmptyTableCell): boolean { return this.column === other.column && this.align === other.align && this.allowInput === other.allowInput }
  toDOM(view: EditorView): HTMLElement {
    const cell = document.createElement('span')
    cell.className = 'cm-md-table-cell'
    cell.dataset.column = String(this.column)
    cell.setAttribute('role', 'cell')
    cell.style.textAlign = this.align
    const input = document.createElement('span')
    input.className = 'cm-md-table-input'
    input.contentEditable = String(this.allowInput)
    input.setAttribute('role', 'textbox')
    input.setAttribute('aria-label', isChinese() ? '单元格' : 'Cell')
    let committed = false
    const commit = (focus = true) => {
      if (committed || !input.isConnected || !input.textContent) return
      committed = true
      const { from, to } = view.state.selection.main
      insertCellText(view, from, to, input.textContent)
      if (focus) view.focus()
    }
    input.addEventListener('input', event => { if (!(event as InputEvent).isComposing) commit() })
    input.addEventListener('compositionend', () => { queueMicrotask(commit) })
    input.addEventListener('blur', () => commit(false))
    input.addEventListener('keydown', event => {
      if (event.isComposing) return
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        view.focus()
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') moveVertical(view, event.key === 'ArrowUp' ? -1 : 1, event.shiftKey)
        else moveAcrossCell(view, event.key === 'ArrowLeft' ? -1 : 1)
      } else if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        commit()
        view.focus()
        if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey) {
          const { from, to } = view.state.selection.main
          insertCellText(view, from, to, '\n')
        } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') insertRow(view, !event.shiftKey)
        else navigate(view, event.shiftKey ? -1 : 1, event.key === 'Enter')
      } else if (event.metaKey || event.ctrlKey) view.focus()
    })
    cell.appendChild(input)
    return cell
  }
  ignoreEvent(event: Event): boolean {
    return (event instanceof KeyboardEvent && event.isComposing) || (event.type !== 'mousedown' && event.type !== 'keydown' && event.type !== 'paste')
  }
}

type DecorationRange = { from: number; to: number; deco: Decoration }

function eachTable(state: EditorState, visit: (node: SyntaxNode) => void): void {
  const front = state.doc.sliceString(0, 3) === '---' ? frontmatterRange(state.doc.toString()) : null
  syntaxTree(state).iterate({ enter: node => {
    if (front && node.name !== 'Document' && node.from >= front.from && node.from < front.to) return false
    if (node.name !== 'Table') return
    visit(node.node)
    return false
  } })
}

function tableWrappers(state: EditorState) {
  const wrappers: Range<BlockWrapper>[] = []
  eachTable(state, node => {
    const first = state.doc.lineAt(node.from).from
    const classes: string[] = []
    state.field(livePreviewField).between(first, first, (_from, _to, deco) => {
      classes.push(...(deco.spec.class ?? '').split(' ').filter((name: string) => name.startsWith('cm-md-page-') || name === 'cm-md-blockquote' || /^cm-md-li(?:-\d+)?$/.test(name)))
    })
    wrappers.push(BlockWrapper.create({ tagName: 'div', attributes: { class: `cm-md-table-widget ${classes.join(' ')}`, 'data-table-from': String(node.from), role: 'table' } }).range(first, node.to))
  })
  return BlockWrapper.set(wrappers, true)
}

function decorateRow(state: EditorState, row: TableRow, rowIndex: number, align: string[], last: boolean,
  ranges: DecorationRange[], prefixes: Range<Decoration>[]): void {
  const columns = align.length
  const editable = state.facet(EditorView.editable) && !state.readOnly
  const line = state.doc.lineAt(row.from)
  ranges.push({ from: line.from, to: line.from, deco: Decoration.line({
    class: `cm-md-table-row${rowIndex === 0 ? ' cm-md-table-header' : ''}${last ? ' cm-md-table-last' : ''}`,
    attributes: { 'data-table-row': String(rowIndex), role: 'row' },
  }) })
  if (line.from < row.from) prefixes.push(Decoration.replace({ widget: new TableBoundary(0) }).range(line.from, row.from))
  row.cells.forEach((cell, column) => {
    if (column >= columns) {
      ranges.push({ from: cell.from, to: cell.to, deco: Decoration.mark({ class: 'cm-md-table-marker' }) })
      return
    }
    if (cell.start === cell.end) {
      const widget = new EmptyTableCell(column, align[column], editable)
      ranges.push({ from: cell.from, to: cell.to, deco: cell.from < cell.to ? Decoration.replace({ widget }) : Decoration.widget({ widget, side: 1 }) })
      return
    }
    const numeric = NUMERIC.test(state.sliceDoc(cell.start, cell.end))
    ranges.push({ from: cell.from, to: cell.to, deco: Decoration.mark({ class: `cm-md-table-cell${numeric ? ' cm-md-table-number' : ''}`, attributes: { 'data-column': String(column), role: rowIndex === 0 ? 'columnheader' : 'cell', style: `text-align:${align[column]}` } }) })
    const { left, right } = cell
    if (left > cell.from) ranges.push({ from: cell.from, to: left, deco: Decoration.replace({ widget: new TableBoundary(column) }) })
    if (right < cell.to) ranges.push({ from: right, to: cell.to, deco: Decoration.replace({ widget: new TableBoundary(column, true) }) })
    if (cell.start > left) ranges.push({ from: left, to: cell.start, deco: Decoration.mark({ class: 'cm-md-table-padding' }) })
    if (cell.end < right) ranges.push({ from: cell.end, to: right, deco: Decoration.mark({ class: 'cm-md-table-padding' }) })
    const content = state.sliceDoc(cell.start, cell.end)
    for (const match of content.matchAll(/\\[\\|]/g)) {
      const from = cell.start + match.index!
      ranges.push({ from, to: from + 1, deco: Decoration.replace({}) })
    }
  })
  for (let column = row.cells.length; column < columns; column++) {
    ranges.push({ from: row.to, to: row.to, deco: Decoration.widget({ widget: new EmptyTableCell(column, align[column], editable), side: column + 1 }) })
  }
}

function tableDecorations(state: EditorState) {
  const ranges: DecorationRange[] = []
  const prefixes: Range<Decoration>[] = []
  eachTable(state, node => {
    const table = readTable(state, node)
    table.rows.forEach((row, index) => decorateRow(state, row, index, table.align, index === table.rows.length - 1, ranges, prefixes))
    const delimiter = state.doc.lineAt(table.delimiter.from)
    ranges.push({ from: delimiter.from, to: delimiter.from, deco: Decoration.line({ class: 'cm-md-table-delimiter' }) })
  })
  return { decorations: Decoration.set(ranges.map(range => range.deco.range(range.from, range.to)), true), prefixes: Decoration.set(prefixes, true), wrappers: tableWrappers(state) }
}

/** 只优化同一数据行里的普通文字编辑；结构变化和解析推进仍完整重建。 */
function changedTableRow(tr: Transaction): { before: SyntaxNode; after: SyntaxNode } | null {
  const edits: { from: number; to: number; next: number; plain: boolean }[] = []
  tr.changes.iterChanges((from, to, next, _end, inserted) => {
    edits.push({ from, to, next, plain: !/[|\\\r\n]/.test(tr.startState.sliceDoc(from, to) + inserted.toString()) })
  })
  if (edits.length !== 1 || !edits[0].plain) return null
  const { from, to, next } = edits[0]
  const rowAt = (state: EditorState, pos: number) => {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
    while (node && node.name !== 'TableRow' && node.name !== 'Table') node = node.parent
    return node?.name === 'TableRow' ? node : null
  }
  const before = rowAt(tr.startState, from), after = rowAt(tr.state, next)
  if (!before || !after || to > before.to || from < before.from || next < after.from) return null
  if (tr.changes.mapPos(before.parent!.from) !== after.parent!.from || tr.changes.mapPos(before.parent!.to) !== after.parent!.to) return null
  return { before, after }
}

const tableField = StateField.define<ReturnType<typeof tableDecorations>>({
  create: tableDecorations,
  update(value, tr) {
    if (tr.startState.facet(EditorView.editable) !== tr.state.facet(EditorView.editable) || tr.startState.readOnly !== tr.state.readOnly) return tableDecorations(tr.state)
    if (!tr.docChanged) return syntaxTree(tr.startState) !== syntaxTree(tr.state) ? tableDecorations(tr.state) : value
    const changed = changedTableRow(tr)
    if (!changed) return tableDecorations(tr.state)
    const from = tr.state.doc.lineAt(changed.after.from).from, to = changed.after.to
    const ranges: DecorationRange[] = [], prefixes: Range<Decoration>[] = []
    let index = 0
    const previous = tr.startState.doc.lineAt(changed.before.from).from
    value.decorations.between(previous, previous, (_from, _to, deco) => {
      if (deco.spec.attributes?.['data-table-row']) index = Number(deco.spec.attributes['data-table-row'])
    })
    const table = readTable(tr.startState, changed.before.parent!)
    decorateRow(tr.state, readRow(tr.state, changed.after), index, table.align, index === table.rows.length - 1, ranges, prefixes)
    const filter = (start: number) => start < from || start > to
    return {
      decorations: value.decorations.map(tr.changes).update({ filterFrom: from, filterTo: to, filter, add: ranges.map(range => range.deco.range(range.from, range.to)), sort: true }),
      prefixes: value.prefixes.map(tr.changes).update({ filterFrom: from, filterTo: to, filter, add: prefixes, sort: true }),
      wrappers: tableWrappers(tr.state),
    }
  },
  // 表格前缀的坐标优先于通用的引用、列表标记隐藏规则；单元格仍包在行内装饰外面
  provide: field => [EditorView.outerDecorations.from(field, value => value.decorations), Prec.high(EditorView.decorations.from(field, value => value.prefixes)), EditorView.blockWrappers.from(field, value => value.wrappers)],
})

let tableLayoutId = 0

const tableLayout = ViewPlugin.fromClass(class {
  private readonly id = String(++tableLayoutId)
  private readonly style = document.createElement('style')
  private readonly measure = document.createElement('div')
  private readonly canvas = document.createElement('canvas').getContext('2d')!
  private readonly metrics = new Map<string, { min: number; max: number }>()
  private readonly layouts = new WeakMap<MarkdownTable, { width: number; columns: number[] }>()
  private readonly rules = new Map<number, string>()
  private probes: { key: string; min: HTMLElement; max: HTMLElement }[] = []
  private signature = ''

  constructor(private readonly view: EditorView) {
    view.dom.dataset.tableLayout = this.id
    this.measure.className = 'cm-content'
    this.measure.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:max-content;max-width:none;padding:0'
    this.measure.setAttribute('aria-hidden', 'true')
    view.dom.append(this.style, this.measure)
    this.schedule()
  }

  update(update: ViewUpdate): void {
    const reconfigured = update.transactions.some(tr => tr.reconfigured)
    if (reconfigured) this.signature = ''
    if (update.docChanged) this.rules.clear()
    if (reconfigured || update.docChanged || update.viewportChanged || update.geometryChanged) this.schedule()
  }

  private content(cell: TableCell): HTMLElement {
    const { state } = this.view
    const marks: { from: number; to: number; deco: Decoration }[] = []
    state.field(livePreviewField).between(cell.start, cell.end, (from, to, deco) => {
      if (from < to && from < cell.end && to > cell.start) marks.push({ from, to, deco })
    })
    const root = document.createElement('span')
    const positions = [...new Set([cell.start, cell.end, ...marks.flatMap(mark => [Math.max(cell.start, mark.from), Math.min(cell.end, mark.to)])])].sort((a, b) => a - b)
    for (let i = 1; i < positions.length; i++) {
      const from = positions[i - 1], to = positions[i]
      const active = marks.filter(mark => mark.from <= from && mark.to >= to)
      const replacement = active.find(mark => !mark.deco.spec.class && !mark.deco.spec.tagName)
      if (replacement) {
        const widget = replacement.deco.spec.widget as WidgetType | undefined
        if (widget && from === replacement.from) {
          const source = state.sliceDoc(replacement.from, replacement.to)
          root.append('code' in widget || /^<br\s*\/?>$/i.test(source) ? widget.toDOM(this.view) : document.createTextNode(source))
        }
        continue
      }
      const span = document.createElement('span')
      span.className = active.map(mark => mark.deco.spec.class ?? '').join(' ')
      span.textContent = state.sliceDoc(from, to).replace(/\\([\\|])/g, '$1')
      root.appendChild(span)
    }
    return root
  }

  private schedule(): void {
    this.view.requestMeasure({ key: this, read: view => {
      for (const probe of this.probes) this.metrics.set(probe.key, { min: probe.min.getBoundingClientRect().width, max: probe.max.getBoundingClientRect().width })
      const sample = view.contentDOM.querySelector<HTMLElement>('.cm-md-table-cell')
      if (!sample) return null
      const style = getComputedStyle(sample)
      const signature = `${document.body.className}:${style.fontFamily}:${style.fontSize}:${style.letterSpacing}:${style.paddingLeft}:${style.paddingRight}:${style.minWidth}:${view.defaultCharacterWidth}`
      if (signature !== this.signature) {
        this.signature = signature
        this.metrics.clear()
        this.rules.clear()
      }
      const pending = new Map<string, { cell: TableCell; header: boolean; font: string }>()
      const tables = new Map<MarkdownTable, number>()
      view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table-row').forEach(row => {
        const table = tableAt(view.state, Number(row.closest<HTMLElement>('.cm-md-table-widget')!.dataset.tableFrom))
        if (!table || tables.has(table)) return
        const wrapper = row.closest<HTMLElement>('.cm-md-table-widget')!
        const wrapperStyle = getComputedStyle(wrapper)
        tables.set(table, wrapper.clientWidth - parseFloat(wrapperStyle.paddingLeft) - parseFloat(wrapperStyle.paddingRight))
      })
      const layouts: { table: MarkdownTable; width: number; columns: number[] }[] = []
      for (const [table, width] of tables) {
        const cached = this.layouts.get(table)
        if (cached?.width === width && this.rules.has(table.from)) continue
        const minimum = table.align.map(() => parseFloat(style.minWidth))
        const preferred = [...minimum]
        table.rows.forEach((row, index) => row.cells.slice(0, table.align.length).forEach((cell, column) => {
          const text = view.state.sliceDoc(cell.start, cell.end)
          const header = index === 0
          const key = `${header}:${text}`
          const font = `${header ? '600' : '400'} ${style.fontSize} ${style.fontFamily}`
          let metric = this.metrics.get(key)
          if (!metric && !/[\*_~`\[\]<>$\\&]/.test(text)) {
            this.canvas.font = font
            const measured = this.canvas.measureText(text).width + (parseFloat(style.letterSpacing) || 0) * text.length
            metric = { min: NUMERIC.test(text) ? measured : 0, max: measured }
            this.metrics.set(key, metric)
          }
          if (!metric) {
            pending.set(key, { cell, header, font })
            return
          }
          const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2
          minimum[column] = Math.max(minimum[column], metric.min + padding)
          preferred[column] = Math.max(preferred[column], metric.max + padding)
        }))
        if (pending.size) continue
        const free = Math.max(0, width - minimum.reduce((sum, value) => sum + value, 0))
        const flex = preferred.map((value, column) => value - minimum[column])
        const total = flex.reduce((sum, value) => sum + value, 0)
        layouts.push({ table, width, columns: minimum.map((value, column) => value + free * (total ? flex[column] / total : 1 / minimum.length)) })
      }
      return { doc: view.state.doc, layouts, pending: [...pending].map(([key, value]) => ({ key, ...value })) }
    }, write: plan => {
      this.measure.replaceChildren()
      this.probes = []
      if (!plan || plan.doc !== this.view.state.doc) return
      for (const layout of plan.layouts) {
        this.layouts.set(layout.table, layout)
        this.rules.set(layout.table.from, layout.columns.map((width, column) => `[data-table-layout="${this.id}"] [data-table-from="${layout.table.from}"] .cm-md-table-cell[data-column="${column}"]{width:${width}px}`).join('\n'))
      }
      const css = [...this.rules.values()].join('\n')
      if (this.style.textContent !== css) this.style.textContent = css
      for (const probe of plan.pending) {
        const row = document.createElement('div')
        row.className = `cm-md-table-row${probe.header ? ' cm-md-table-header' : ''}`
        row.style.display = 'block'
        const max = this.content(probe.cell)
        max.classList.add('cm-md-table-cell')
        max.style.cssText = `display:inline-block;width:max-content;min-width:0;padding:0;border:0;font:${probe.font}`
        const min = max.cloneNode(true) as HTMLElement
        min.style.width = 'min-content'
        row.append(min, max)
        this.measure.appendChild(row)
        this.probes.push({ key: probe.key, min, max })
      }
      if (this.probes.length) this.schedule()
    } })
  }

  destroy(): void {
    this.style.remove()
    this.measure.remove()
    delete this.view.dom.dataset.tableLayout
  }
})

function tableAt(state: EditorState, pos: number): MarkdownTable | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1)
  while (node && node.name !== 'Table') node = node.parent
  if (!node) {
    node = syntaxTree(state).resolveInner(pos, 1)
    while (node && node.name !== 'Table') node = node.parent
  }
  return node ? readTable(state, node) : null
}

const tableEdit = Annotation.define<boolean>()
const setVirtualCell = StateEffect.define<{ row: number; column: number }>()
const virtualCell = StateField.define<{ row: number; column: number } | null>({
  create: () => null,
  update(value, tr) {
    const effect = tr.effects.find(effect => effect.is(setVirtualCell))
    return effect ? effect.value : tr.docChanged || tr.selection ? null : value
  },
})

function currentCell(state: EditorState) {
  const table = tableAt(state, state.selection.main.head)
  if (!table) return null
  let row = table.rows.findIndex(row => state.selection.main.head <= row.to)
  if (row < 0) row = table.rows.length - 1
  const cells = table.rows[row].cells
  const hint = state.field(virtualCell, false)
  const found = cells.findIndex(cell => state.selection.main.head < cell.to || state.selection.main.head === cell.end)
  const column = hint?.row === table.rows[row].from ? hint.column
    : Math.min(table.align.length - 1, found < 0 ? cells.length - 1 : found)
  return { table, row, column, cell: cells[column] }
}

function selectCell(view: EditorView, table: MarkdownTable, row: number, column: number, select = true): void {
  const target = table.rows[row]
  const cell = target.cells[column]
  view.dispatch({
    selection: EditorSelection.single(cell?.start ?? target.to, select ? (cell?.end ?? target.to) : (cell?.start ?? target.to)),
    effects: setVirtualCell.of({ row: target.from, column }),
    scrollIntoView: true,
  })
  if (!cell || cell.start === cell.end) {
    view.focus()
    const focus = () => {
      const hint = view.state.field(virtualCell)
      if (hint?.row !== target.from || hint.column !== column || !view.dom.contains(document.activeElement)) return
      view.contentDOM.querySelector<HTMLElement>(`[data-table-from="${table.from}"] [data-table-row="${row}"] [data-column="${column}"] .cm-md-table-input`)?.focus()
    }
    focus()
    requestAnimationFrame(focus)
  }
}

function editTable(view: EditorView, table: MarkdownTable, changes: ChangeSpec, row: number, column: number): void {
  const next = view.state.update({ changes })
  const updated = tableAt(next.state, next.changes.mapPos(table.from))
  const target = updated?.rows[row]
  const anchor = target?.cells[column]?.end ?? next.changes.mapPos(view.state.selection.main.head)
  view.dispatch({ changes, selection: EditorSelection.create([EditorSelection.cursor(anchor, -1)]), annotations: tableEdit.of(true), userEvent: 'input', scrollIntoView: true })
  if (updated && target && (!target.cells[column] || target.cells[column].start === target.cells[column].end)) selectCell(view, updated, row, column, false)
}

function rowText(state: EditorState, table: MarkdownTable): string {
  const line = state.doc.lineAt(table.delimiter.from)
  const prefix = state.sliceDoc(line.from, table.delimiter.from)
  return `${prefix}| ${table.align.map(() => '').join(' | ')} |`
}

function insertRow(view: EditorView, below = true): boolean {
  const current = currentCell(view.state)
  if (!current || !view.state.facet(EditorView.editable) || view.state.readOnly) return false
  const { table, row, column } = current
  const after = below ? row : Math.max(0, row - 1)
  const from = after === 0 ? table.delimiter.to : table.rows[after].to
  editTable(view, table, { from, insert: `\n${rowText(view.state, table)}` }, after + 1, column)
  return true
}

/** 空行。引用里的空行只剩 `>`。 */
const blankLine = (text: string) => /^[\s>]*$/.test(text)

/** 行里正文开始的地方：跳过引用、列表与标题的标记，免得字打进被藏起来的标记前面。 */
const textStart = (line: Line) => line.from + /^[ \t>]*(?:(?:[-*+]|\d+[.)]|#{1,6})[ \t]+)?/.exec(line.text)![0].length

/**
 * 光标离开 [from, to] 这张表格的落点。
 *
 * 紧挨着表格下面的一行一打字就会被并进表格当一行，所以要落在隔着空行的地方：
 * 向下是下一块的开头，向上是上一块的末尾，和渲染后看到的「上一段 / 下一段」一致。
 * 表格贴着文档开头或结尾、外面没有这样的位置时补一个空段落，可撤销。
 */
function exitTable(state: EditorState, from: number, to: number, direction: number): TransactionSpec {
  const { doc } = state
  if (direction < 0) {
    const first = doc.lineAt(from)
    const above = first.number > 1 ? doc.line(first.number - 1) : null
    if (above && !blankLine(above.text)) return { selection: { anchor: above.to } }
    if (above && above.number > 1) return { selection: { anchor: doc.line(above.number - 1).to } }
    return { changes: { from: 0, insert: above ? '\n' : '\n\n' }, selection: { anchor: 0 } }
  }
  const last = doc.lineAt(to)
  const below = last.number < doc.lines ? doc.line(last.number + 1) : null
  if (below && !blankLine(below.text)) return { selection: { anchor: textStart(below) } }
  if (below && below.number < doc.lines) return { selection: { anchor: textStart(doc.line(below.number + 1)) } }
  const insert = below ? '\n' : '\n\n'
  return { changes: { from: doc.length, insert }, selection: { anchor: doc.length + insert.length } }
}

function leaveTable(view: EditorView, table: MarkdownTable, direction: number): void {
  const exit = exitTable(view.state, table.from, table.to, direction)
  view.dispatch({ ...exit, annotations: tableEdit.of(true), userEvent: exit.changes ? 'input' : 'select', scrollIntoView: true })
}

function navigate(view: EditorView, direction: number, vertical = false): boolean {
  const current = currentCell(view.state)
  if (!current) return false
  const { table, row, column } = current
  if (vertical && direction > 0 && row > 0 && row === table.rows.length - 1 && table.rows[row].cells.every(cell => cell.start === cell.end)) {
    // 空末行按 Enter：删掉这一行，再按向下离开的规则落脚，一步撤销
    const remove = { changes: { from: view.state.doc.lineAt(table.rows[row].from).from - 1, to: table.to } }
    const removed = view.state.update(remove).state
    const end = remove.changes.from
    view.dispatch(view.state.update(remove, { ...exitTable(removed, table.from, end, 1), sequential: true, annotations: tableEdit.of(true), userEvent: 'input', scrollIntoView: true }))
    return true
  }
  const index = row * table.align.length + column + (vertical ? direction * table.align.length : direction)
  if (index < 0) {
    leaveTable(view, table, -1)
  } else if (index >= table.rows.length * table.align.length) {
    return insertRow(view)
  } else {
    selectCell(view, table, Math.floor(index / table.align.length), index % table.align.length)
  }
  return true
}

function cellText(text: string): string {
  // 数清竖线前的反斜杠：偶数个（含零个）说明竖线没转义，补一个。按前一个字符判断会漏掉 `||` 的第二根
  return text.replace(/\r\n?|\n/g, '<br>').replace(/(\\*)\|/g, (match, slashes: string) => slashes.length % 2 ? match : `${slashes}\\|`)
}

/** 选区是否整个落在格里（不含两侧的竖线）。还没写进原文的格子只认空光标。 */
function withinCell(cell: TableCell | undefined, from: number, to: number): boolean {
  return cell ? from >= cell.left && to <= cell.right : from === to
}

function insertCellText(view: EditorView, from: number, to: number, text: string): boolean {
  const current = currentCell(view.state)
  if (!current || !view.state.facet(EditorView.editable) || view.state.readOnly) return false
  const { table, row, column, cell } = current
  if (cell) {
    if (!withinCell(cell, from, to)) return false
    if (cell.start === cell.end && cell.left < cell.right) {
      // 只有空格的格子：写成 `| 内容 |`，不把字贴在右边的竖线上
      const value = cellText(text)
      const insert = ` ${value}${view.state.sliceDoc(cell.right, cell.right + 1) === '|' ? ' ' : ''}`
      view.dispatch({ changes: { from: cell.left, to: cell.right, insert }, selection: { anchor: cell.left + 1 + value.length }, annotations: tableEdit.of(true), userEvent: 'input.type' })
      return true
    }
    const escaped = cellText(view.state.sliceDoc(cell.start, from) + text).slice(from - cell.start)
    if (escaped === text && cell.start !== cell.end) return false
    view.dispatch({ changes: { from, to, insert: escaped }, selection: { anchor: from + escaped.length }, annotations: tableEdit.of(true), userEvent: 'input.type' })
  } else {
    const target = table.rows[row]
    const trailing = target.trailing
    const values = Array.from({ length: table.align.length - target.cells.length }, (_, i) => i + target.cells.length === column ? cellText(text) : '')
    editTable(view, table, { from: target.to, insert: `${trailing ? '' : ' |'} ${values.join(' | ')} |` }, row, column)
  }
  return true
}

function deleteAtBoundary(view: EditorView, direction: number): boolean {
  const current = currentCell(view.state)
  if (!current) return false
  const range = view.state.selection.main
  return range.empty && (!current.cell || (direction < 0 ? range.head <= current.cell.start : range.head >= current.cell.end))
}

function deleteToCellEdge(view: EditorView, direction: number): boolean {
  const current = currentCell(view.state)
  if (!current || !view.state.selection.main.empty) return false
  if (!current.cell) return true
  const head = view.state.selection.main.head
  const edge = direction < 0 ? current.cell.start : current.cell.end
  view.dispatch({ changes: { from: Math.min(head, edge), to: Math.max(head, edge), insert: '' }, selection: { anchor: Math.min(head, edge) }, userEvent: 'delete' })
  return true
}

function moveAcrossCell(view: EditorView, direction: number): boolean {
  const current = currentCell(view.state)
  if (!current || !view.state.selection.main.empty) return false
  const { table, row, column, cell } = current
  if (cell && (direction < 0 ? view.state.selection.main.head > cell.start : view.state.selection.main.head < cell.end)) return false
  const index = row * table.align.length + column + direction
  if (index < 0 || index >= table.rows.length * table.align.length) {
    leaveTable(view, table, direction)
  } else {
    const r = Math.floor(index / table.align.length)
    const c = index % table.align.length
    const target = table.rows[r].cells[c]
    if (!target || target.start === target.end) selectCell(view, table, r, c, false)
    else view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(direction < 0 ? target.end : target.start, direction)]), scrollIntoView: true })
  }
  return true
}

function cellAtPoint(view: EditorView, event: Pick<MouseEvent, 'clientX' | 'clientY'>) {
  const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.cm-md-table-cell')
  const row = element?.closest<HTMLElement>('.cm-md-table-row')
  if (!element || !row) return null
  const table = tableAt(view.state, Number(row.closest<HTMLElement>('.cm-md-table-widget')!.dataset.tableFrom))
  const sourceRow = table?.rows[Number(row.dataset.tableRow)]
  if (!sourceRow) return null
  const cell = sourceRow.cells[Number(element.dataset.column)]
  if (!cell) return { pos: sourceRow.to, from: sourceRow.to, to: sourceRow.to }
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY)
  const range = caret ? null : document.caretRangeFromPoint?.(event.clientX, event.clientY)
  const node = caret?.offsetNode ?? range?.startContainer
  const offset = caret?.offset ?? range?.startOffset ?? 0
  const pos = node && view.contentDOM.contains(node) ? view.posAtDOM(node, offset) : cell.start
  const head = Math.max(cell.start, Math.min(cell.end, pos))
  return { pos: head, from: cell.start, to: cell.end, assoc: head === cell.end ? -1 : 1 }
}

function moveVertical(view: EditorView, direction: 1 | -1, extend = false): boolean {
  const current = currentCell(view.state)
  if (!current) return false
  const { table, row, column, cell } = current
  const range = view.state.selection.main
  const caret = view.coordsAtPos(range.head)
  const edge = cell && view.coordsAtPos(direction < 0 ? cell.start : cell.end, direction)
  const element = (r: number) => view.contentDOM.querySelector<HTMLElement>(`[data-table-from="${table.from}"] [data-table-row="${r}"] [data-column="${column}"]`)
  const own = element(row)
  const lineHeight = own ? Number.parseFloat(getComputedStyle(own).lineHeight) : 0
  let pos: number | null = null
  if (caret && edge && (direction < 0 ? caret.top > edge.top + lineHeight / 2 : caret.top < edge.top - lineHeight / 2)) {
    const point = cellAtPoint(view, { clientX: caret.left, clientY: (caret.top + caret.bottom) / 2 + direction * lineHeight })
    if (point && cell && point.pos >= cell.start && point.pos <= cell.end) pos = point.pos
  }
  if (pos === null || pos === range.head) {
    const next = row + direction
    if (next < 0 || next >= table.rows.length) {
      if (!extend) {
        leaveTable(view, table, direction)
        return true
      }
      pos = direction < 0 ? Math.max(0, view.state.doc.lineAt(table.from).from - 1) : Math.min(view.state.doc.length, table.to + 1)
    } else {
      const target = table.rows[next].cells[column]
      view.focus()
      if ((!target || target.start === target.end) && !extend) {
        selectCell(view, table, next, column, false)
        return true
      }
      const el = element(next)
      const box = el?.getBoundingClientRect()
      const style = el && getComputedStyle(el)
      const left = box && style ? box.left + Number.parseFloat(style.paddingLeft) : 0
      const right = box && style ? box.right - Number.parseFloat(style.paddingRight) : 0
      const height = style ? Number.parseFloat(style.lineHeight) : 0
      const y = box && style ? (direction > 0 ? box.top + Number.parseFloat(style.paddingTop) + height / 2 : box.bottom - Number.parseFloat(style.paddingBottom) - height / 2) : 0
      const point = box && cellAtPoint(view, { clientX: Math.max(left, Math.min(right, caret?.left ?? left)), clientY: y })
      pos = point?.pos ?? target?.start ?? table.rows[next].to
    }
  }
  view.dispatch({ selection: { anchor: extend ? range.anchor : pos, head: pos }, scrollIntoView: true })
  return true
}

export const tableEditing = [
  virtualCell,
  tableField,
  tableLayout,
  EditorState.transactionFilter.of(tr => {
    if (!tr.selection || !tr.newSelection.main.empty || tr.docChanged || tr.effects.some(effect => effect.is(setVirtualCell))) return tr
    const current = currentCell(tr.state)
    if (!current) return tr
    const { table, row, cell } = current
    const pos = tr.newSelection.main.head
    const anchor = cell ? Math.max(cell.start, Math.min(cell.end, pos)) : table.rows[row].to
    return anchor === pos ? tr : [tr, { selection: { anchor } }]
  }),
  EditorState.changeFilter.of(tr => {
    if (!tr.isUserEvent('delete') && !tr.isUserEvent('input')) return true
    if (tr.annotation(tableEdit)) return true
    const table = tableAt(tr.startState, tr.startState.selection.main.head)
    if (!table) return true
    const selection = tr.startState.selection.main
    if (selection.from <= table.from && selection.to >= table.to) return true
    if (selection.empty && tr.isUserEvent('delete')) {
      const cell = currentCell(tr.startState)?.cell
      const left = cell?.start ?? selection.head
      const right = cell?.end ?? selection.head
      let crossesCell = false
      tr.changes.iterChangedRanges((from, to) => { if (from < left || to > right) crossesCell = true })
      if (crossesCell) return [0, left, right, tr.startState.doc.length]
    }
    const protectedRanges: number[] = []
    table.rows.forEach((row, index) => {
      for (const cell of row.cells) {
        if (tr.startState.sliceDoc(cell.from, cell.from + 1) === '|') protectedRanges.push(cell.from, cell.from + 1)
      }
      if (row.trailing) protectedRanges.push(row.to - 1, row.to)
      if (index < table.rows.length - 1) protectedRanges.push(row.to, table.rows[index + 1].from)
      else if (table.rows.length === 1) protectedRanges.push(row.to, table.to)
    })
    let touchesStructure = false
    tr.changes.iterChangedRanges((from, to) => {
      for (let i = 0; i < protectedRanges.length; i += 2) {
        if (from < protectedRanges[i + 1] && to > protectedRanges[i]) touchesStructure = true
      }
    })
    return touchesStructure ? protectedRanges : true
  }),
  Prec.high(keymap.of([
    { key: 'Tab', run: view => navigate(view, 1) },
    { key: 'Shift-Tab', run: view => navigate(view, -1) },
    { key: 'Enter', run: view => navigate(view, 1, true) },
    { key: 'Mod-Enter', run: view => insertRow(view) },
    { key: 'Mod-Shift-Enter', run: view => insertRow(view, false) },
    { key: 'Shift-Enter', run: view => {
      if (!currentCell(view.state)) return false
      const { from, to } = view.state.selection.main
      return insertCellText(view, from, to, '\n')
    } },
    { key: 'Backspace', run: view => deleteAtBoundary(view, -1) },
    { key: 'Delete', run: view => deleteAtBoundary(view, 1) },
    { mac: 'Alt-Backspace', win: 'Ctrl-Backspace', linux: 'Ctrl-Backspace', run: view => deleteAtBoundary(view, -1) },
    { mac: 'Alt-Delete', win: 'Ctrl-Delete', linux: 'Ctrl-Delete', run: view => deleteAtBoundary(view, 1) },
    { mac: 'Mod-Backspace', run: view => deleteToCellEdge(view, -1) },
    { mac: 'Mod-Delete', run: view => deleteToCellEdge(view, 1) },
    { key: 'ArrowLeft', run: view => moveAcrossCell(view, -1) },
    { key: 'ArrowRight', run: view => moveAcrossCell(view, 1) },
    { key: 'ArrowUp', run: view => moveVertical(view, -1) },
    { key: 'ArrowDown', run: view => moveVertical(view, 1) },
    { key: 'Shift-ArrowUp', run: view => moveVertical(view, -1, true) },
    { key: 'Shift-ArrowDown', run: view => moveVertical(view, 1, true) },
  ])),
  EditorView.inputHandler.of((view, from, to, text) => view.composing ? false : insertCellText(view, from, to, text)),
  EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey) return null
    const point = cellAtPoint(view, event)
    if (!point) return null
    let anchor = point.pos
    let initial = view.state.selection
    const start = event.detail >= 3 ? point : event.detail === 2 ? view.state.wordAt(anchor) : null
    return {
      get(current, extend, multiple) {
        const target = cellAtPoint(view, current)
        let head = target?.pos ?? view.posAtCoords({ x: current.clientX, y: current.clientY }) ?? anchor
        let from = extend ? initial.main.anchor : anchor
        if (start) {
          const end = event.detail >= 3 ? target : view.state.wordAt(head)
          from = head < anchor ? start.to : start.from
          head = head < anchor ? (end?.from ?? head) : (end?.to ?? head)
        }
        const range = EditorSelection.range(from, head, undefined, undefined, target?.assoc)
        return multiple ? initial.addRange(range) : EditorSelection.create([range])
      },
      update(update) {
        anchor = update.changes.mapPos(anchor)
        initial = initial.map(update.changes)
      },
    }
  }),
  EditorView.domEventHandlers({
    beforeinput(event, view) {
      if (event.isComposing || !event.data || !/[\n|]/.test(event.data)) return false
      const { from, to } = view.state.selection.main
      if (!insertCellText(view, from, to, event.data)) return false
      event.preventDefault()
      return true
    },
    mousedown(event, view) {
      if (event.button !== 0 || !(event.target instanceof HTMLElement)) return false
      const cell = event.target.closest<HTMLElement>('.cm-md-table-cell')
      const row = cell?.closest<HTMLElement>('.cm-md-table-row')
      if (!cell || !row) return false
      const table = tableAt(view.state, Number(row.closest<HTMLElement>('.cm-md-table-widget')!.dataset.tableFrom))
      if (!table) return false
      const rowIndex = Number(row.dataset.tableRow)
      const column = Number(cell.dataset.column)
      const target = table.rows[rowIndex].cells[column]
      if (target && target.start !== target.end) return false
      event.preventDefault()
      if (target) {
        const anchor = Math.max(target.start, Math.min(target.end, view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? target.start))
        view.dispatch({ selection: { anchor }, effects: setVirtualCell.of({ row: table.rows[rowIndex].from, column }) })
      } else selectCell(view, table, rowIndex, column, false)
      const input = cell.querySelector<HTMLElement>('.cm-md-table-input')
      if (input) input.focus()
      else view.focus()
      return true
    },
    paste(event, view) {
      const current = currentCell(view.state)
      const text = event.clipboardData?.getData('text/plain')
      if (!current || text === undefined || !view.state.facet(EditorView.editable) || view.state.readOnly) return false
      if (!text.includes('\t')) {
        const { from, to } = view.state.selection.main
        if (!insertCellText(view, from, to, text)) return false
        view.focus()
        event.preventDefault()
        return true
      }
      // 选区伸到格外（从正文拖进表格、全选）时不当表格数据展开，交给常规粘贴
      const { from, to } = view.state.selection.main
      if (!withinCell(current.cell, from, to)) return false
      const { table, row, column } = current
      const values = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(line => line.split('\t').map(cellText))
      const columns = Math.max(table.align.length, column + Math.max(...values.map(row => row.length)))
      const changes: ChangeSpec[] = []
      const rows = [...table.rows, table.delimiter]
      for (const target of rows) {
        const index = table.rows.indexOf(target)
        for (let c = 0; c < Math.min(target.cells.length, table.align.length); c++) {
          const value = values[index - row]?.[c - column]
          if (index >= row && c >= column && value !== undefined) changes.push({ from: target.cells[c].start, to: target.cells[c].end, insert: value })
        }
        if (target.cells.length < columns) {
          const extra = Array.from({ length: columns - target.cells.length }, (_, i) => {
            const c = i + target.cells.length
            return index < 0 ? '---' : values[index - row]?.[c - column] ?? ''
          })
          const trailing = target.trailing
          changes.push({ from: target.to, insert: `${trailing ? '' : ' |'} ${extra.join(' | ')} |` })
        }
      }
      const prefix = view.state.sliceDoc(view.state.doc.lineAt(table.delimiter.from).from, table.delimiter.from)
      let added = ''
      for (let r = table.rows.length; r < row + values.length; r++) {
        added += `\n${prefix}| ${Array.from({ length: columns }, (_, c) => values[r - row]?.[c - column] ?? '').join(' | ')} |`
      }
      if (added) changes.push({ from: table.to, insert: added })
      editTable(view, table, changes, row + values.length - 1, column + values.at(-1)!.length - 1)
      view.focus()
      event.preventDefault()
      return true
    },
  }),
]
