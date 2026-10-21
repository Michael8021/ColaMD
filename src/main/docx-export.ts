import { nativeImage } from 'electron'
import { basename, dirname, extname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
// 这三个必须在 package.json 里**直接声明**。
// 曾经它们只是 @milkdown/* 的传递依赖，靠 npm 的依赖提升侥幸能 load：构建期发现不了
// （主进程的依赖是外部化的，vite 不解析它们），一执行 npm install 删掉 milkdown，
// Word 导出就会在运行时「模块找不到」（2026-10-06 换内核后的清理里查出来的）。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import {
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx'

interface MarkdownNode {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  start?: number
  url?: string
  alt?: string
  children?: MarkdownNode[]
}

export interface DocxExportInput {
  content: string
  sourcePath: string | null
  // Diagrams the renderer drew for this export, keyed by the name the rewritten
  // Markdown points at (`![示意图](colamd-diagram-1.png)`). They arrive as PNG
  // data URLs because they exist only in memory.
  images?: Record<string, string>
}

function headingForDepth(depth: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  const headings = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ]
  return headings[Math.max(0, Math.min(5, depth - 1))] as (typeof HeadingLevel)[keyof typeof HeadingLevel]
}

function textContent(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') return node.value ?? ''
  if (node.type === 'break') return '\n'
  return node.children?.map(textContent).join('') ?? ''
}

function inlineRuns(nodes: MarkdownNode[] | undefined, style: { bold?: boolean; italics?: boolean; strike?: boolean } = {}): ParagraphChild[] {
  if (!nodes) return []
  const runs: ParagraphChild[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push(new TextRun({ text: node.value ?? '', ...style }))
    } else if (node.type === 'break' || (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value ?? ''))) {
      runs.push(new TextRun({ break: 1, ...style }))
    } else if (node.type === 'inlineCode') {
      runs.push(new TextRun({ text: node.value ?? '', font: 'Menlo', shading: { fill: 'F1F3F5' } }))
    } else if (node.type === 'strong') {
      runs.push(...inlineRuns(node.children, { ...style, bold: true }))
    } else if (node.type === 'emphasis') {
      runs.push(...inlineRuns(node.children, { ...style, italics: true }))
    } else if (node.type === 'delete') {
      runs.push(...inlineRuns(node.children, { ...style, strike: true }))
    } else if (node.type === 'link' && node.url) {
      runs.push(new ExternalHyperlink({ link: node.url, children: inlineRuns(node.children, style) }))
    } else if (node.type === 'image') {
      runs.push(new TextRun({ text: node.alt ? `[${node.alt}]` : '[image]', italics: true }))
    } else {
      runs.push(...inlineRuns(node.children, style))
    }
  }
  return runs
}

function imagePath(url: string, sourcePath: string | null): string | null {
  if (/^(https?:|data:|blob:)/i.test(url)) return null
  try {
    if (url.startsWith('file:')) return fileURLToPath(url)
  } catch {
    return null
  }
  if (!sourcePath) return null
  return isAbsolute(url) ? url : resolve(dirname(sourcePath), decodeURIComponent(url))
}

function imageParagraph(node: MarkdownNode, sourcePath: string | null, images: Record<string, string> | undefined): Paragraph {
  const dataURL = node.url && images ? images[node.url] : undefined
  const image = dataURL
    ? nativeImage.createFromDataURL(dataURL)
    : (() => {
        const path = node.url ? imagePath(node.url, sourcePath) : null
        return path ? nativeImage.createFromPath(path) : null
      })()
  if (!image || image.isEmpty()) return new Paragraph({ children: [new TextRun({ text: node.alt ? `[${node.alt}]` : '[image]', italics: true })] })

  const size = image.getSize()
  const scale = Math.min(1, 560 / size.width, 420 / size.height)
  return new Paragraph({
    children: [new ImageRun({
      type: 'png',
      data: image.toPNG(),
      transformation: { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) },
    })],
  })
}

function tableForNode(node: MarkdownNode): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: (node.children ?? []).map((row) => new TableRow({
      children: Array.from({ length: node.children?.[0]?.children?.length ?? 0 }, (_, column) => new TableCell({
        children: [new Paragraph({ children: inlineRuns(row.children?.[column]?.children) })],
      })),
    })),
  })
}

function blockNodes(nodes: MarkdownNode[] | undefined, sourcePath: string | null, images?: Record<string, string>, listDepth = 0): Array<Paragraph | Table> {
  if (!nodes) return []
  const output: Array<Paragraph | Table> = []
  for (const node of nodes) {
    if (node.type === 'heading') {
      output.push(new Paragraph({ heading: headingForDepth(node.depth ?? 1), children: inlineRuns(node.children) }))
    } else if (node.type === 'paragraph') {
      const image = node.children?.length === 1 && node.children[0]?.type === 'image' ? node.children[0] : null
      output.push(image ? imageParagraph(image, sourcePath, images) : new Paragraph({ children: inlineRuns(node.children), spacing: { after: 120 } }))
    } else if (node.type === 'image') {
      output.push(imageParagraph(node, sourcePath, images))
    } else if (node.type === 'blockquote') {
      if (node.children?.some(child => child.type === 'table')) {
        for (const child of node.children) {
          if (child.type === 'table') output.push(tableForNode(child))
          else output.push(...blockNodes([{ ...node, children: [child] }], sourcePath, images, listDepth))
        }
        continue
      }
      output.push(new Paragraph({
        children: [new TextRun({ text: textContent(node), italics: true })],
        indent: { left: 720 },
        border: { left: { color: 'AEB7C2', space: 8, style: 'single', size: 12 } },
      }))
    } else if (node.type === 'code') {
      output.push(new Paragraph({
        children: [new TextRun({ text: node.value ?? '', font: 'Menlo', size: 18 })],
        shading: { fill: 'F1F3F5' },
        spacing: { before: 120, after: 120 },
      }))
    } else if (node.type === 'list') {
      const start = node.start ?? 1
      for (const [index, item] of (node.children ?? []).entries()) {
        const first = item.children?.find((child) => child.type === 'paragraph')
        const prefix = node.ordered ? `${start + index}. ` : '• '
        output.push(new Paragraph({
          children: [new TextRun({ text: prefix }), ...inlineRuns(first?.children)],
          indent: { left: 360 + listDepth * 360, hanging: 240 },
          spacing: { after: 60 },
        }))
        output.push(...blockNodes(item.children?.filter((child) => child !== first), sourcePath, images, listDepth + 1))
      }
    } else if (node.type === 'table') {
      output.push(tableForNode(node))
    } else if (node.type === 'thematicBreak') {
      output.push(new Paragraph({ border: { bottom: { color: 'AEB7C2', space: 1, style: 'single', size: 6 } } }))
    } else if (node.type === 'html') {
      output.push(new Paragraph({ children: [new TextRun({ text: node.value ?? '' })] }))
    } else if (node.type === 'footnoteDefinition') {
      output.push(new Paragraph({ children: [new TextRun({ text: textContent(node), size: 18, color: '667085' })] }))
    } else {
      output.push(...blockNodes(node.children, sourcePath, images, listDepth))
    }
  }
  return output
}

export async function markdownToDocx(input: DocxExportInput): Promise<Buffer> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(input.content) as MarkdownNode
  const document = new Document({
    creator: 'ColaMD',
    title: input.sourcePath ? basename(input.sourcePath, extname(input.sourcePath)) : 'Untitled',
    sections: [{ children: blockNodes(tree.children, input.sourcePath, input.images) }],
  })
  return Packer.toBuffer(document)
}
