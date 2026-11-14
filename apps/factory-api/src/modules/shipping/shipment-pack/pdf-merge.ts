import { inflateSync } from 'node:zlib'

/**
 * Merges PDF files page by page into one PDF (B-W2b-391; LOG-031 "one print job per shipment"). The API has no PDF library
 * that reads a PDF (pdfkit only writes, and no npm package is added), so this is the small reader and writer the merge
 * needs, nothing more:
 *
 *   read    the file's cross-reference (classic tables and PDF 1.5 cross-reference streams, with their /Prev chain, and the
 *           objects inside object streams); a file whose cross-reference cannot be read is scanned for its `n g obj`
 *           objects instead. An encrypted file is refused.
 *   copy    each file's pages in order: every object a page reaches is copied once under a new number, its streams byte for
 *           byte (still compressed as they were); what a page inherits from its page tree (resources, media box, crop box,
 *           rotation) is written on the page itself; the source page trees, outlines and forms are left behind.
 *   write   one PDF 1.7 with a classic cross-reference table: a catalog, one page tree, the pages, an /Info naming the
 *           title. The same files give the same bytes (no date is written).
 *
 * Pure apart from zlib: no file, network or database. A refusal is a PdfMergeError in words for a person.
 */

export class PdfMergeError extends Error {
  override name = 'PdfMergeError'
}

type Value =
  | { readonly t: 'null' }
  | { readonly t: 'bool'; readonly v: boolean }
  | { readonly t: 'num'; readonly raw: string }
  | { readonly t: 'name'; readonly v: string }
  | { readonly t: 'str'; readonly raw: string }
  | { readonly t: 'ref'; readonly num: number; readonly gen: number }
  | { readonly t: 'arr'; readonly items: Value[] }
  | { readonly t: 'dict'; readonly map: Map<string, Value> }

interface PdfObject {
  readonly value: Value
  /** The stream's bytes as stored (latin1, one char per byte), or null. */
  readonly stream: string | null
}

const NULL: Value = { t: 'null' }
const num = (value: number): Value => ({ t: 'num', raw: String(value) })
const name = (value: string): Value => ({ t: 'name', v: value })
const ref = (value: number): Value => ({ t: 'ref', num: value, gen: 0 })

const isWhite = (code: number) => code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])
const isRegular = (code: number) => !isWhite(code) && !DELIMITERS.has(code)
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)/y
const INTEGER = /\d+/y

/** The inheritable page attributes (PDF 32000-1 §7.7.3.4). */
const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const

/** The most objects one file may hold, and the deepest nesting of arrays and dictionaries read. */
const MAX_OBJECTS = 500_000
const MAX_DEPTH = 64

class Parser {
  constructor(
    readonly s: string,
    public i = 0,
  ) {}

  skip(): void {
    const s = this.s
    while (this.i < s.length) {
      const code = s.charCodeAt(this.i)
      if (isWhite(code)) this.i++
      else if (code === 0x25) {
        while (this.i < s.length && s.charCodeAt(this.i) !== 0x0a && s.charCodeAt(this.i) !== 0x0d) this.i++
      } else break
    }
  }

  keyword(word: string): boolean {
    this.skip()
    if (!this.s.startsWith(word, this.i)) return false
    const after = this.s.charCodeAt(this.i + word.length)
    if (!Number.isNaN(after) && isRegular(after)) return false
    this.i += word.length
    return true
  }

  integer(): number | null {
    this.skip()
    INTEGER.lastIndex = this.i
    const match = INTEGER.exec(this.s)
    if (!match) return null
    this.i += match[0].length
    return Number.parseInt(match[0], 10)
  }

  value(depth = 0): Value {
    if (depth > MAX_DEPTH) throw new PdfMergeError('The PDF nests its objects too deeply.')
    this.skip()
    const s = this.s
    const code = s.charCodeAt(this.i)
    if (Number.isNaN(code)) throw new PdfMergeError('The PDF ends inside an object.')
    if (code === 0x2f) return this.name()
    if (code === 0x28) return this.literal()
    if (code === 0x3c) {
      if (s.charCodeAt(this.i + 1) === 0x3c) return this.dict(depth)
      const end = s.indexOf('>', this.i)
      if (end < 0) throw new PdfMergeError('The PDF ends inside a string.')
      const raw = s.slice(this.i, end + 1)
      this.i = end + 1
      return { t: 'str', raw }
    }
    if (code === 0x5b) {
      this.i++
      const items: Value[] = []
      for (;;) {
        this.skip()
        if (s.charCodeAt(this.i) === 0x5d) {
          this.i++
          return { t: 'arr', items }
        }
        items.push(this.value(depth + 1))
      }
    }
    if (this.keyword('true')) return { t: 'bool', v: true }
    if (this.keyword('false')) return { t: 'bool', v: false }
    if (this.keyword('null')) return NULL
    NUMBER.lastIndex = this.i
    const match = NUMBER.exec(s)
    if (!match) throw new PdfMergeError('The PDF has an object it cannot read.')
    this.i += match[0].length
    if (/^\d+$/.test(match[0])) {
      // "12 0 R" is a reference.
      const back = this.i
      const generation = this.integer()
      if (generation !== null && this.keyword('R')) return { t: 'ref', num: Number.parseInt(match[0], 10), gen: generation }
      this.i = back
    }
    return { t: 'num', raw: match[0] }
  }

  private name(): Value {
    const s = this.s
    const start = ++this.i
    while (this.i < s.length && isRegular(s.charCodeAt(this.i))) this.i++
    return { t: 'name', v: s.slice(start, this.i).replace(/#([0-9A-Fa-f]{2})/g, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) }
  }

  private literal(): Value {
    const s = this.s
    const start = this.i
    let depth = 0
    for (; this.i < s.length; this.i++) {
      const code = s.charCodeAt(this.i)
      if (code === 0x5c) this.i++
      else if (code === 0x28) depth++
      else if (code === 0x29 && --depth === 0) {
        this.i++
        return { t: 'str', raw: s.slice(start, this.i) }
      }
    }
    throw new PdfMergeError('The PDF ends inside a string.')
  }

  private dict(depth: number): Value {
    this.i += 2
    const map = new Map<string, Value>()
    for (;;) {
      this.skip()
      if (this.s.startsWith('>>', this.i)) {
        this.i += 2
        return { t: 'dict', map }
      }
      const key = this.value(depth + 1)
      if (key.t !== 'name') throw new PdfMergeError('The PDF has a dictionary it cannot read.')
      map.set(key.v, this.value(depth + 1))
    }
  }
}

const dictOf = (value: Value | undefined): Map<string, Value> | null => (value?.t === 'dict' ? value.map : null)
const intOf = (value: Value | undefined): number | null => (value?.t === 'num' && /^\d+$/.test(value.raw) ? Number.parseInt(value.raw, 10) : null)
const nameOf = (value: Value | undefined): string | null => (value?.t === 'name' ? value.v : null)

type XrefEntry = { readonly at: number } | { readonly stream: number; readonly index: number }

/** One PDF file, read. */
class SourcePdf {
  private readonly s: string
  private readonly xref = new Map<number, XrefEntry>()
  private readonly objects = new Map<number, PdfObject>()
  private readonly objectStreams = new Map<number, { readonly data: string; readonly at: Map<number, number> }>()
  private readonly reading = new Set<number>()
  trailer: Map<string, Value> = new Map()

  constructor(bytes: Uint8Array) {
    this.s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
    const header = this.s.indexOf('%PDF-')
    if (header < 0 || header > 1024) throw new PdfMergeError('One of the files is not a PDF.')
    try {
      this.readXref()
    } catch (error) {
      if (!(error instanceof PdfMergeError)) throw error
      this.xref.clear()
      this.trailer = new Map()
    }
    if (this.xref.size === 0 || !this.trailer.has('Root')) this.scan()
    if (this.trailer.has('Encrypt')) throw new PdfMergeError('One of the files is encrypted: it cannot be merged.')
  }

  private readXref(): void {
    const start = this.s.lastIndexOf('startxref')
    if (start < 0) throw new PdfMergeError('No cross-reference.')
    const parser = new Parser(this.s, start + 'startxref'.length)
    let at = parser.integer()
    const seen = new Set<number>()
    while (at !== null && !seen.has(at)) {
      seen.add(at)
      const trailer = this.readSection(at)
      if (this.trailer.size === 0) this.trailer = trailer
      // A hybrid file names its cross-reference stream beside its table.
      const hybrid = intOf(trailer.get('XRefStm'))
      if (hybrid !== null && !seen.has(hybrid)) {
        seen.add(hybrid)
        this.readSection(hybrid)
      }
      at = intOf(trailer.get('Prev'))
    }
  }

  /** One cross-reference section (a table or a stream) at a byte offset; earlier sections never replace a later one's entry. */
  private readSection(at: number): Map<string, Value> {
    const parser = new Parser(this.s, at)
    if (parser.keyword('xref')) {
      for (;;) {
        if (parser.keyword('trailer')) break
        const first = parser.integer()
        const count = parser.integer()
        if (first === null || count === null) throw new PdfMergeError('A cross-reference table it cannot read.')
        for (let k = 0; k < count; k++) {
          const offset = parser.integer()
          const generation = parser.integer()
          parser.skip()
          const kind = this.s.charAt(parser.i)
          parser.i++
          if (offset === null || generation === null || (kind !== 'n' && kind !== 'f')) throw new PdfMergeError('A cross-reference entry it cannot read.')
          if (kind === 'n' && !this.xref.has(first + k)) this.xref.set(first + k, { at: offset })
        }
      }
      const trailer = dictOf(parser.value())
      if (!trailer) throw new PdfMergeError('A trailer it cannot read.')
      return trailer
    }
    const object = this.parseAt(at)
    const dict = dictOf(object.value)
    if (!dict || nameOf(dict.get('Type')) !== 'XRef' || object.stream === null) throw new PdfMergeError('A cross-reference it cannot read.')
    const data = decode(dict, object.stream)
    const widths = dict.get('W')
    const w = widths?.t === 'arr' ? widths.items.map((item) => intOf(item) ?? 0) : []
    if (w.length !== 3) throw new PdfMergeError('A cross-reference stream it cannot read.')
    const size = intOf(dict.get('Size')) ?? 0
    const index = dict.get('Index')
    const ranges = index?.t === 'arr' ? index.items.map((item) => intOf(item) ?? 0) : [0, size]
    const row = w[0]! + w[1]! + w[2]!
    const field = (offset: number, width: number) => {
      let value = 0
      for (let k = 0; k < width; k++) value = value * 256 + data[offset + k]!
      return value
    }
    let offset = 0
    for (let r = 0; r + 1 < ranges.length; r += 2) {
      for (let k = 0; k < ranges[r + 1]!; k++) {
        if (offset + row > data.length) throw new PdfMergeError('A cross-reference stream ends early.')
        const type = w[0] === 0 ? 1 : field(offset, w[0]!)
        const second = field(offset + w[0]!, w[1]!)
        const third = field(offset + w[0]! + w[1]!, w[2]!)
        const number = ranges[r]! + k
        if (!this.xref.has(number)) {
          if (type === 1) this.xref.set(number, { at: second })
          else if (type === 2) this.xref.set(number, { stream: second, index: third })
        }
        offset += row
      }
    }
    return dict
  }

  /** A file without a readable cross-reference: every `n g obj` in it (the last one of a number wins). */
  private scan(): void {
    this.xref.clear()
    const pattern = /(\d+)\s+(\d+)\s+obj\b/g
    for (let match = pattern.exec(this.s); match; match = pattern.exec(this.s)) {
      this.xref.set(Number.parseInt(match[1]!, 10), { at: match.index })
      if (this.xref.size > MAX_OBJECTS) throw new PdfMergeError('One of the files has too many objects.')
    }
    this.objects.clear()
    const trailerAt = this.s.lastIndexOf('trailer')
    if (trailerAt >= 0) {
      const parser = new Parser(this.s, trailerAt + 'trailer'.length)
      const dict = dictOf(parser.value())
      if (dict?.has('Root')) {
        this.trailer = dict
        return
      }
    }
    for (const number of this.xref.keys()) {
      const dict = dictOf(this.get(number).value)
      if (dict && nameOf(dict.get('Type')) === 'Catalog') {
        this.trailer = new Map([['Root', ref(number)]])
        return
      }
    }
    throw new PdfMergeError('One of the files has no page tree.')
  }

  private parseAt(at: number): PdfObject {
    const parser = new Parser(this.s, at)
    if (parser.integer() === null || parser.integer() === null || !parser.keyword('obj')) throw new PdfMergeError('An object it cannot read.')
    const value = parser.value()
    if (!parser.keyword('stream')) return { value, stream: null }
    if (this.s.charCodeAt(parser.i) === 0x0d) parser.i++
    if (this.s.charCodeAt(parser.i) === 0x0a) parser.i++
    const start = parser.i
    const dict = dictOf(value)
    const length = dict ? this.resolve(dict.get('Length') ?? NULL) : NULL
    const declared = intOf(length)
    if (declared !== null && this.s.startsWith('endstream', skipWhite(this.s, start + declared))) return { value, stream: this.s.slice(start, start + declared) }
    // The length is wrong or unreadable: up to the keyword, without the end of line before it.
    const end = this.s.indexOf('endstream', start)
    if (end < 0) throw new PdfMergeError('A stream it cannot read.')
    let stop = end
    if (this.s.charCodeAt(stop - 1) === 0x0a) stop--
    if (this.s.charCodeAt(stop - 1) === 0x0d) stop--
    return { value, stream: this.s.slice(start, Math.max(start, stop)) }
  }

  get(number: number): PdfObject {
    const cached = this.objects.get(number)
    if (cached) return cached
    const entry = this.xref.get(number)
    if (!entry || this.reading.has(number)) return { value: NULL, stream: null }
    this.reading.add(number)
    try {
      const object = 'at' in entry ? this.parseAt(entry.at) : { value: this.fromObjectStream(entry.stream, entry.index, number), stream: null }
      this.objects.set(number, object)
      return object
    } finally {
      this.reading.delete(number)
    }
  }

  private fromObjectStream(streamNumber: number, _index: number, number: number): Value {
    let loaded = this.objectStreams.get(streamNumber)
    if (!loaded) {
      const container = this.get(streamNumber)
      const dict = dictOf(container.value)
      if (!dict || container.stream === null) throw new PdfMergeError('An object stream it cannot read.')
      const data = Buffer.from(decode(dict, container.stream)).toString('latin1')
      const count = intOf(dict.get('N')) ?? 0
      const first = intOf(dict.get('First')) ?? 0
      const parser = new Parser(data)
      const at = new Map<number, number>()
      for (let k = 0; k < count; k++) {
        const objectNumber = parser.integer()
        const offset = parser.integer()
        if (objectNumber === null || offset === null) throw new PdfMergeError('An object stream it cannot read.')
        if (!at.has(objectNumber)) at.set(objectNumber, first + offset)
      }
      loaded = { data, at }
      this.objectStreams.set(streamNumber, loaded)
    }
    const offset = loaded.at.get(number)
    if (offset === undefined) return NULL
    return new Parser(loaded.data, offset).value()
  }

  resolve(value: Value): Value {
    let current = value
    for (let hops = 0; current.t === 'ref' && hops < 32; hops++) current = this.get(current.num).value
    return current
  }
}

function skipWhite(s: string, at: number): number {
  let i = at
  while (i < s.length && isWhite(s.charCodeAt(i))) i++
  return i
}

/** A cross-reference or object stream's data: FlateDecode, with a PNG predictor when it has one. */
function decode(dict: Map<string, Value>, raw: string): Uint8Array {
  const filter = dict.get('Filter')
  const filters = filter?.t === 'arr' ? filter.items.map(nameOf) : filter ? [nameOf(filter)] : []
  let data: Uint8Array = Buffer.from(raw, 'latin1')
  if (filters.length > 1 || (filters.length === 1 && filters[0] !== 'FlateDecode')) throw new PdfMergeError('A stream compressed in a way it cannot read.')
  if (filters.length === 1) {
    try {
      data = inflateSync(data)
    } catch {
      throw new PdfMergeError('A compressed stream it cannot read.')
    }
  }
  const params = dictOf(dict.get('DecodeParms'))
  const predictor = params ? (intOf(params.get('Predictor')) ?? 1) : 1
  if (predictor >= 10) return unpredict(data, intOf(params!.get('Columns')) ?? 1, (intOf(params!.get('Colors')) ?? 1) * Math.max(1, (intOf(params!.get('BitsPerComponent')) ?? 8) / 8))
  if (predictor !== 1) throw new PdfMergeError('A stream predicted in a way it cannot read.')
  return data
}

/** The PNG predictors (None, Sub, Up, Average, Paeth), row by row. */
function unpredict(data: Uint8Array, columns: number, bytesPerPixel: number): Uint8Array {
  const width = Math.ceil(columns * bytesPerPixel)
  const rows = Math.floor(data.length / (width + 1))
  const out = new Uint8Array(rows * width)
  const bpp = Math.max(1, Math.round(bytesPerPixel))
  for (let r = 0; r < rows; r++) {
    const filter = data[r * (width + 1)]!
    const row = r * width
    for (let k = 0; k < width; k++) {
      const value = data[r * (width + 1) + 1 + k]!
      const left = k >= bpp ? out[row + k - bpp]! : 0
      const up = r > 0 ? out[row - width + k]! : 0
      const upLeft = r > 0 && k >= bpp ? out[row - width + k - bpp]! : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) throw new PdfMergeError('A stream predicted in a way it cannot read.')
      out[row + k] = (value + predicted) & 0xff
    }
  }
  return out
}

const encodeName = (value: string): string =>
  [...value].map((char) => {
    const code = char.charCodeAt(0)
    return code < 0x21 || code > 0x7e || '#()<>[]{}/%'.includes(char) ? `#${code.toString(16).padStart(2, '0').toUpperCase()}` : char
  }).join('')

function serialise(value: Value): string {
  switch (value.t) {
    case 'null':
      return 'null'
    case 'bool':
      return value.v ? 'true' : 'false'
    case 'num':
      return value.raw
    case 'name':
      return `/${encodeName(value.v)}`
    case 'str':
      return value.raw
    case 'ref':
      return `${value.num} 0 R`
    case 'arr':
      return `[${value.items.map(serialise).join(' ')}]`
    case 'dict':
      return `<<${[...value.map].map(([key, entry]) => `/${encodeName(key)} ${serialise(entry)}`).join(' ')}>>`
  }
}

/** A PDF literal string of plain text (the /Info title). */
const literal = (text: string): Value => ({ t: 'str', raw: `(${text.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1')})` })

export interface MergedPdf {
  readonly pdf: Buffer
  /** The pages of each file, in order, and of the whole. */
  readonly pagesPerFile: readonly number[]
  readonly pages: number
}

/** The files' pages, in order, as one PDF. Refuses (PdfMergeError) a file it cannot read, an encrypted one, more pages than `maxPages`. */
export function mergePdfs(files: readonly Uint8Array[], options: { readonly title: string; readonly maxPages?: number }): MergedPdf {
  if (files.length === 0) throw new PdfMergeError('There is nothing to merge.')
  const sources = files.map((file) => new SourcePdf(file))
  const out = new Map<number, PdfObject>()
  const numbers = new Map<string, number>()
  const queue: { readonly source: number; readonly number: number; readonly target: number }[] = []
  let next = 3
  const allocate = (source: number, number: number): number => {
    const key = `${source}:${number}`
    const known = numbers.get(key)
    if (known !== undefined) return known
    const target = next++
    numbers.set(key, target)
    queue.push({ source, number, target })
    return target
  }
  const translate = (value: Value, source: number): Value => {
    switch (value.t) {
      case 'ref':
        return ref(allocate(source, value.num))
      case 'arr':
        return { t: 'arr', items: value.items.map((item) => translate(item, source)) }
      case 'dict':
        return { t: 'dict', map: new Map([...value.map].map(([key, entry]) => [key, translate(entry, source)])) }
      default:
        return value
    }
  }

  // Each file's pages, depth first, with what they inherit; every node of the source page trees maps to the one new tree.
  const pages: { readonly source: number; readonly number: number; readonly inherited: Map<string, Value> }[] = []
  const pagesPerFile: number[] = []
  sources.forEach((pdf, source) => {
    const root = dictOf(pdf.resolve(pdf.trailer.get('Root') ?? NULL))
    const top = root?.get('Pages')
    if (!root || top?.t !== 'ref') throw new PdfMergeError('One of the files has no page tree.')
    const before = pages.length
    const seen = new Set<number>()
    const walk = (node: Value, inherited: Map<string, Value>): void => {
      if (node.t !== 'ref' || seen.has(node.num)) return
      seen.add(node.num)
      const dict = dictOf(pdf.get(node.num).value)
      if (!dict) return
      const kids = pdf.resolve(dict.get('Kids') ?? NULL)
      if (nameOf(dict.get('Type')) === 'Pages' || (nameOf(dict.get('Type')) !== 'Page' && kids.t === 'arr')) {
        numbers.set(`${source}:${node.num}`, 2)
        const passed = new Map(inherited)
        for (const key of INHERITED) if (dict.has(key)) passed.set(key, dict.get(key)!)
        if (kids.t === 'arr') for (const kid of kids.items) walk(kid, passed)
        return
      }
      numbers.set(`${source}:${node.num}`, next++)
      pages.push({ source, number: node.num, inherited })
      if (pages.length > (options.maxPages ?? Number.MAX_SAFE_INTEGER)) throw new PdfMergeError(`The pack would have more than ${options.maxPages} pages.`)
    }
    walk(top, new Map())
    if (pages.length === before) throw new PdfMergeError('One of the files has no page.')
    pagesPerFile.push(pages.length - before)
  })

  for (const page of pages) {
    const pdf = sources[page.source]!
    const dict = new Map(dictOf(pdf.get(page.number).value)!)
    dict.delete('Parent')
    for (const key of INHERITED) if (!dict.has(key) && page.inherited.has(key)) dict.set(key, page.inherited.get(key)!)
    const copied = translate({ t: 'dict', map: dict }, page.source) as Extract<Value, { t: 'dict' }>
    // The new page tree is object 2 (set after the copy: translate reads every reference as the source file's).
    copied.map.set('Parent', ref(2))
    out.set(numbers.get(`${page.source}:${page.number}`)!, { value: copied, stream: null })
  }
  while (queue.length > 0) {
    const { source, number, target } = queue.shift()!
    const object = sources[source]!.get(number)
    const value = object.stream !== null && object.value.t === 'dict' ? { t: 'dict' as const, map: new Map([...object.value.map, ['Length', num(object.stream.length)]]) } : object.value
    out.set(target, { value: translate(value, source), stream: object.stream })
    if (out.size > MAX_OBJECTS) throw new PdfMergeError('The pack has too many objects.')
  }

  const kids = pages.map((page) => ref(numbers.get(`${page.source}:${page.number}`)!))
  out.set(1, { value: { t: 'dict', map: new Map([['Type', name('Catalog')], ['Pages', ref(2)]]) }, stream: null })
  out.set(2, { value: { t: 'dict', map: new Map<string, Value>([['Type', name('Pages')], ['Kids', { t: 'arr', items: kids }], ['Count', num(kids.length)]]) }, stream: null })
  const info = next++
  out.set(info, { value: { t: 'dict', map: new Map([['Title', literal(options.title)], ['Producer', literal('Nexus Factory')]]) }, stream: null })

  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  for (let n = 1; n < next; n++) {
    const object = out.get(n) ?? { value: NULL, stream: null }
    offsets[n] = body.length
    body += `${n} 0 obj\n${serialise(object.value)}\n${object.stream === null ? '' : `stream\n${object.stream}\nendstream\n`}endobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${next}\n0000000000 65535 f \n`
  for (let n = 1; n < next; n++) body += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<</Size ${next} /Root 1 0 R /Info ${info} 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return { pdf: Buffer.from(body, 'latin1'), pagesPerFile, pages: pages.length }
}

/** The pages of a PDF (what mergePdfs reads), for a check. */
export const pdfPages = (bytes: Uint8Array): number => mergePdfs([bytes], { title: 'check' }).pages
