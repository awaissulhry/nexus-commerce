import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The fonts every factory PDF prints with (B-W2b-GF2, gap G076): Liberation Sans, regular and bold, embedded (subset) in
 * each PDF, so Polish, Greek, Czech, Romanian, Turkish, Cyrillic … print as written. Until now the PDFs used the PDF
 * standard fonts (Helvetica: WinAnsi text only), and every character outside it printed "?".
 *
 * Liberation Sans (SIL Open Font License 1.1; assets/fonts/LICENSE-LiberationSans.txt) has Helvetica's and Arial's metrics,
 * so every layout measured for Helvetica keeps its widths. The files sit in apps/factory-api/assets/fonts and are read once
 * (pdfkit embeds them through fontkit, its own dependency: no package is added). A character the fonts lack (CJK, emoji)
 * still prints "?", never an empty box.
 *
 *   useFonts(pdf)        registers the two fonts on a pdfkit document under FONT.regular and FONT.bold
 *   printableText(text)  the text as the fonts print it: a line break becomes a space, a control character or a
 *                        character the fonts lack becomes "?"
 */

/** The names the fonts are registered under (plain strings, as pdfkit's font names are). */
export const FONT: { readonly regular: string; readonly bold: string } = Object.freeze({ regular: 'LiberationSans', bold: 'LiberationSans-Bold' })

const FILES = { regular: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf' } as const

/** apps/factory-api/assets/fonts, found from this file in src/ (dev, tests) or from its chunk in dist/ (the build). */
function fontsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'assets', 'fonts')
    if (existsSync(join(candidate, FILES.regular))) return candidate
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error('documents: the PDF fonts (assets/fonts/LiberationSans-*.ttf) are not beside the API: the build ships the assets folder with dist.')
}

interface GlyphFont {
  hasGlyphForCodePoint(codePoint: number): boolean
}

interface Fonts {
  readonly regular: Buffer
  readonly bold: Buffer
  readonly covers: (codePoint: number) => boolean
}

let loaded: Fonts | null = null

function fonts(): Fonts {
  if (loaded) return loaded
  const folder = fontsFolder()
  const regular = readFileSync(join(folder, FILES.regular))
  const bold = readFileSync(join(folder, FILES.bold))
  // fontkit as pdfkit itself loads it (pdfkit's dependency): which characters the fonts can print.
  const fromPdfkit = createRequire(createRequire(import.meta.url).resolve('pdfkit'))
  const fontkit = fromPdfkit('fontkit') as { create(buffer: Buffer): GlyphFont }
  const faces = [fontkit.create(regular), fontkit.create(bold)]
  const known = new Map<number, boolean>()
  const covers = (codePoint: number): boolean => {
    let answer = known.get(codePoint)
    if (answer === undefined) {
      answer = faces.every((face) => face.hasGlyphForCodePoint(codePoint))
      known.set(codePoint, answer)
    }
    return answer
  }
  loaded = { regular, bold, covers }
  return loaded
}

/** Registers the embedded fonts on a pdfkit document (FONT.regular, FONT.bold) and starts it in the regular one. */
export function useFonts(pdf: PDFKit.PDFDocument): void {
  const { regular, bold } = fonts()
  pdf.registerFont(FONT.regular, regular)
  pdf.registerFont(FONT.bold, bold)
  pdf.font(FONT.regular)
}

/** Text as the embedded fonts print it: a line break becomes a space; a control character or one the fonts lack, "?". */
export function printableText(text: string): string {
  const { covers } = fonts()
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (char === '\n') out += ' '
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += '?'
    else out += covers(code) ? char : '?'
  }
  return out
}
