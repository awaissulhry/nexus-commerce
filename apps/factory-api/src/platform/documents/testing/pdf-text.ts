import { inflateSync } from 'node:zlib'

/**
 * Test support (imported by tests only): the text a PDF made by platform/documents shows, read back without a PDF
 * library. pdfkit writes each line of text with the standard fonts as a `[<hex> kerning <hex> …] TJ` array of WinAnsi
 * bytes inside Flate-compressed content streams; this inflates every stream and decodes those arrays, one string per
 * text operation, in drawing order. Enough to prove what a printed document says; not a general PDF reader.
 */

// WinAnsi 0x80-0x9F; every other byte is its Latin-1 character.
const WIN_ANSI_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ'

function decode(hex: string): string {
  let out = ''
  for (let index = 0; index + 1 < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16)
    out += byte >= 0x80 && byte <= 0x9f ? WIN_ANSI_HIGH[byte - 0x80] : String.fromCharCode(byte)
  }
  return out
}

/** The decoded content streams of the PDF (latin1 text of the operators). */
export function pdfStreams(pdf: Buffer): string[] {
  const source = pdf.toString('latin1')
  const streams: string[] = []
  const pattern = /<<([^]*?)>>\s*stream\r?\n/g
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const start = match.index + match[0].length
    const end = source.indexOf('endstream', start)
    if (end < 0) break
    const raw = pdf.subarray(start, end)
    if (/\/FlateDecode/.test(match[1] ?? '')) {
      try {
        streams.push(inflateSync(raw).toString('latin1'))
      } catch {
        // a binary stream (an image) that is not text
      }
    } else {
      streams.push(raw.toString('latin1'))
    }
    pattern.lastIndex = end
  }
  return streams
}

/** Every text operation's string, in drawing order. */
export function pdfTextRuns(pdf: Buffer): string[] {
  const runs: string[] = []
  for (const stream of pdfStreams(pdf)) {
    for (const match of stream.matchAll(/\[((?:\s*(?:<[0-9a-fA-F]*>|-?\d+(?:\.\d+)?))*)\s*\]\s*TJ/g)) {
      runs.push([...(match[1] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((hex) => decode(hex[1] ?? '')).join(''))
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
