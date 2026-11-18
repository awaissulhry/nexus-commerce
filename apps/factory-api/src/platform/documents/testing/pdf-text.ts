import { inflateSync } from 'node:zlib'

/**
 * Test support (imported by tests only): the text a PDF made by platform/documents shows, read back without a PDF
 * library. pdfkit writes each line of text as a `[<hex> kerning <hex> …] TJ` array inside Flate-compressed content
 * streams; this inflates every stream and decodes those arrays, one string per text operation, in drawing order. Enough
 * to prove what a printed document says; not a general PDF reader.
 *
 * B-W2b-GF2 (G076): the PDFs embed their fonts (platform/documents/fonts.ts): a text operation in an embedded font holds
 * two-byte glyph codes, read back through the font's ToUnicode map (pdfkit writes one per embedded font); one in a
 * standard font (Helvetica) holds WinAnsi bytes, as before.
 */

// WinAnsi 0x80-0x9F; every other byte is its Latin-1 character.
const WIN_ANSI_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ'

function decodeWinAnsi(hex: string): string {
  let out = ''
  for (let index = 0; index + 1 < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16)
    out += byte >= 0x80 && byte <= 0x9f ? WIN_ANSI_HIGH[byte - 0x80] : String.fromCharCode(byte)
  }
  return out
}

/** UTF-16BE hex ("00410042") as a string. */
function utf16(hex: string): string {
  const units: number[] = []
  for (let index = 0; index + 3 < hex.length; index += 4) units.push(Number.parseInt(hex.slice(index, index + 4), 16))
  return String.fromCharCode(...units)
}

/** The stream of an object (inflated when Flate-compressed), or null. */
function streamOf(pdf: Buffer, source: string, start: number, end: number): string | null {
  const head = source.slice(start, end)
  const at = head.search(/>>\s*stream\r?\n/)
  if (at < 0) return null
  const open = start + head.slice(at).match(/>>\s*stream\r?\n/)![0].length + at
  const close = source.indexOf('endstream', open)
  if (close < 0 || close > end) return null
  const raw = pdf.subarray(open, close)
  if (/\/FlateDecode/.test(head.slice(0, at))) {
    try {
      return inflateSync(raw).toString('latin1')
    } catch {
      return null
    }
  }
  return raw.toString('latin1')
}

/** Every object of the PDF by number: where its body starts and ends in the latin1 source. */
function objectsOf(source: string): Map<number, { start: number; end: number }> {
  const objects = new Map<number, { start: number; end: number }>()
  for (const match of source.matchAll(/(?:^|[\r\n])(\d+) 0 obj\b/g)) {
    const start = match.index! + match[0].length
    const end = source.indexOf('endobj', start)
    if (end > 0) objects.set(Number(match[1]), { start, end })
  }
  return objects
}

/** A ToUnicode CMap as code (4 hex digits, lower case) → text. */
function cmapOf(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of text.matchAll(/beginbfrange([^]*?)endbfrange/g)) {
    for (const entry of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const low = Number.parseInt(entry[1]!, 16)
      const high = Number.parseInt(entry[2]!, 16)
      const target = entry[3]!
      if (target.startsWith('[')) {
        const items = [...target.matchAll(/<([0-9a-fA-F ]+)>/g)].map((item) => item[1]!.replace(/ /g, ''))
        items.forEach((item, offset) => map.set((low + offset).toString(16).padStart(4, '0'), utf16(item)))
      } else {
        const first = Number.parseInt(target.slice(1, -1), 16)
        for (let code = low; code <= high; code += 1) map.set(code.toString(16).padStart(4, '0'), String.fromCharCode(first + code - low))
      }
    }
  }
  for (const block of text.matchAll(/beginbfchar([^]*?)endbfchar/g)) {
    for (const entry of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(entry[1]!.toLowerCase().padStart(4, '0'), utf16(entry[2]!))
  }
  return map
}

/** The embedded fonts' ToUnicode maps by the font object's number. */
function fontCmaps(pdf: Buffer, source: string, objects: Map<number, { start: number; end: number }>): Map<number, Map<string, string>> {
  const byObject = new Map<number, Map<string, string>>()
  for (const [number, place] of objects) {
    const body = source.slice(place.start, place.end)
    const ref = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body)
    if (!ref || !/\/Type\s*\/Font\b/.test(body)) continue
    const target = objects.get(Number(ref[1]))
    const stream = target ? streamOf(pdf, source, target.start, target.end) : null
    if (stream) byObject.set(number, cmapOf(stream))
  }
  return byObject
}

/** The embedded fonts' ToUnicode maps by the resource name the content streams use (/F1 …). */
function fontMaps(pdf: Buffer, source: string): Map<string, Map<string, string>> {
  const byObject = fontCmaps(pdf, source, objectsOf(source))
  const byName = new Map<string, Map<string, string>>()
  for (const dict of source.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
    for (const entry of dict[1]!.matchAll(/\/([^\s/]+)\s+(\d+)\s+0\s+R/g)) {
      const map = byObject.get(Number(entry[2]))
      if (map) byName.set(entry[1]!, map)
    }
  }
  return byName
}

// ---- fix-pg-2: a merged PDF (modules/shipping/shipment-pack/pdf-merge.ts, one PDF per shipment) keeps each source file's resource
// names on its own pages, so /F1 of a label page and /F1 of the DDT are two fonts: a page's content is read with ITS page's fonts
// (the one map of every name above stays the answer for a stream no page names, and for a name the page does not hold).
/** Each page content stream's fonts (object number of the content stream → resource name → ToUnicode map). */
function pageFonts(pdf: Buffer, source: string): Map<number, Map<string, Map<string, string>>> {
  const objects = objectsOf(source)
  const cmaps = fontCmaps(pdf, source, objects)
  const bodyOf = (number: number): string => {
    const place = objects.get(number)
    return place ? source.slice(place.start, place.end) : ''
  }
  const fontsIn = (resources: string): Map<string, Map<string, string>> => {
    let dict = /\/Font\s*<<([^>]*)>>/.exec(resources)?.[1]
    const ref = dict === undefined ? /\/Font\s+(\d+)\s+0\s+R/.exec(resources) : null
    if (ref) dict = /<<([^]*)>>/.exec(bodyOf(Number(ref[1])))?.[1]
    const names = new Map<string, Map<string, string>>()
    for (const entry of (dict ?? '').matchAll(/\/([^\s/]+)\s+(\d+)\s+0\s+R/g)) {
      const map = cmaps.get(Number(entry[2]))
      if (map) names.set(entry[1]!, map)
    }
    return names
  }
  const byContent = new Map<number, Map<string, Map<string, string>>>()
  for (const place of objects.values()) {
    const body = source.slice(place.start, place.end)
    if (!/\/Type\s*\/Page(?![A-Za-z])/.test(body)) continue
    const resources = /\/Resources\s+(\d+)\s+0\s+R/.exec(body)
    const fonts = fontsIn(resources ? bodyOf(Number(resources[1])) : body)
    const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(body)
    const refs = single ? [single[1]!] : [...(/\/Contents\s*\[([^\]]*)\]/.exec(body)?.[1] ?? '').matchAll(/(\d+)\s+0\s+R/g)].map((match) => match[1]!)
    for (const ref of refs) byContent.set(Number(ref), fonts)
  }
  return byContent
}

/** The decoded streams of the PDF in file order, each with the number of the object it belongs to (null before any object). */
function streamsOf(pdf: Buffer, source: string): { readonly object: number | null; readonly text: string }[] {
  const heads = [...source.matchAll(/(?:^|[\r\n])(\d+) 0 obj\b/g)].map((match) => ({ at: match.index!, number: Number(match[1]) }))
  let head = 0
  let object: number | null = null
  const streams: { object: number | null; text: string }[] = []
  const pattern = /<<([^]*?)>>\s*stream\r?\n/g
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const start = match.index + match[0].length
    // The object the stream belongs to: the last object opened before its data (the `<<` found may be an earlier object's).
    while (head < heads.length && heads[head]!.at < start) object = heads[head++]!.number
    const end = source.indexOf('endstream', start)
    if (end < 0) break
    const raw = pdf.subarray(start, end)
    if (/\/FlateDecode/.test(match[1] ?? '')) {
      try {
        streams.push({ object, text: inflateSync(raw).toString('latin1') })
      } catch {
        // a binary stream (an image) that is not text
      }
    } else {
      streams.push({ object, text: raw.toString('latin1') })
    }
    pattern.lastIndex = end
  }
  return streams
}
// ---- end fix-pg-2

/** The decoded content streams of the PDF (latin1 text of the operators). */
export function pdfStreams(pdf: Buffer): string[] {
  return streamsOf(pdf, pdf.toString('latin1')).map((stream) => stream.text)
}

/** Every text operation's string, in drawing order. */
export function pdfTextRuns(pdf: Buffer): string[] {
  const source = pdf.toString('latin1')
  const maps = fontMaps(pdf, source)
  const pages = pageFonts(pdf, source) // fix-pg-2
  const runs: string[] = []
  for (const { object, text: stream } of streamsOf(pdf, source)) {
    const own = object === null ? undefined : pages.get(object) // fix-pg-2: the page's own fonts first
    let font: Map<string, string> | undefined
    for (const match of stream.matchAll(/\/([^\s/]+)\s+-?\d+(?:\.\d+)?\s+Tf|\[((?:\s*(?:<[0-9a-fA-F]*>|-?\d+(?:\.\d+)?))*)\s*\]\s*TJ/g)) {
      if (match[1] !== undefined) {
        font = own?.get(match[1]) ?? maps.get(match[1])
        continue
      }
      const hexes = [...(match[2] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((hex) => hex[1] ?? '')
      const map = font
      runs.push(
        hexes
          .map((hex) => {
            if (!map) return decodeWinAnsi(hex)
            let out = ''
            for (let index = 0; index + 3 < hex.length; index += 4) out += map.get(hex.slice(index, index + 4).toLowerCase()) ?? '�'
            return out
          })
          .join(''),
      )
    }
  }
  return runs
}

/** The whole text, runs joined by newlines (a wrapped line is two runs). */
export const pdfText = (pdf: Buffer): string => pdfTextRuns(pdf).join('\n')

/** The whole text on one line, white space collapsed: a phrase a narrow box wrapped reads whole again. */
export const pdfFlatText = (pdf: Buffer): string => pdfTextRuns(pdf).join(' ').replace(/\s+/g, ' ')

/** The number of pages. */
export const pdfPageCount = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
