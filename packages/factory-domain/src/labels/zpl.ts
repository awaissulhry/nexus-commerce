import type { Issue } from '../core/errors'
import type { ComposedLabel } from './model'

/**
 * ZPL II for label printers (plan A1 §3.9: pure builders in factory-domain/labels, after Commerce's
 * fnsku-label-zpl.service.ts). The printer draws the text with its scalable font 0 and the barcode with its own
 * Code 128 (`^BC`), so the bars are as sharp as the print head allows; nothing is rasterised here.
 *
 * One fixed layout for every kind, in hundredths of a millimetre (LABEL_LAYOUT), turned into the printer's dots at its
 * resolution; the PDF label of the same composition (apps/factory-api platform/documents) uses the same geometry:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ Pelle · Seed A                              │  heading
 *   │ Nappa 1.2 nero                              │  title
 *   │ ║│║║│║│║║│║│║║║│║│║║│║║                      │  Code 128 of the scannable id (10 modules of quiet zone)
 *   │ HD-7K-0003RJ-M                              │  the id, for a person to type
 *   │ Colore        Scelta                        │  fields, two columns
 *   │ Nero          A                             │
 *   └────────────────────────────────────────────┘
 *
 * Text goes through `^FH` (hex escapes): `^`, `~`, `_` and every character outside printable ASCII are sent as their
 * UTF-8 bytes (`_C3_A8` for è) under `^CI28`, so a value can never start a ZPL command and the output is plain ASCII.
 */

/** The label stock a printer holds and its resolution. */
export interface LabelStock {
  readonly widthMm: number
  readonly heightMm: number
  /** Dots per inch of the print head. */
  readonly dpi: number
}

export const LABEL_DPIS = [203, 300, 600] as const
/** The smallest stock the fixed layout fits (3 × 1.9 inches). */
export const MIN_LABEL_WIDTH_MM = 76
export const MIN_LABEL_HEIGHT_MM = 48
export const MAX_LABEL_MM = 300
/** The most copies of one label a job asks for. */
export const MAX_LABEL_COPIES = 500

/** The fixed geometry, in hundredths of a millimetre. A Code 128 module is 0.25 mm, and the margin is its quiet zone. */
export const LABEL_LAYOUT = Object.freeze({
  margin: 250,
  heading: { y: 250, size: 250 },
  title: { y: 550, size: 400 },
  barcode: { y: 1050, height: 1000, module: 25 },
  code: { y: 2150, size: 350 },
  fields: { y: 2650, rowHeight: 600, labelSize: 200, valueSize: 300, valueOffset: 220, perRow: 2 },
})

/** What is wrong with a stock for the fixed layout (empty when it fits). */
export function stockProblems(stock: LabelStock, at = 'printer'): Issue[] {
  const problems: Issue[] = []
  if (!(LABEL_DPIS as readonly number[]).includes(stock.dpi)) problems.push({ path: `${at}/dpi`, message: `A label printer prints at ${LABEL_DPIS.join(', ')} dpi.` })
  if (!Number.isSafeInteger(stock.widthMm) || stock.widthMm < MIN_LABEL_WIDTH_MM || stock.widthMm > MAX_LABEL_MM) {
    problems.push({ path: `${at}/labelWidthMm`, message: `The label layout needs stock ${MIN_LABEL_WIDTH_MM} to ${MAX_LABEL_MM} mm wide.` })
  }
  if (!Number.isSafeInteger(stock.heightMm) || stock.heightMm < MIN_LABEL_HEIGHT_MM || stock.heightMm > MAX_LABEL_MM) {
    problems.push({ path: `${at}/labelHeightMm`, message: `The label layout needs stock ${MIN_LABEL_HEIGHT_MM} to ${MAX_LABEL_MM} mm high.` })
  }
  return problems
}

/** Hundredths of a millimetre → dots at the resolution (integer arithmetic: 1 inch = 2540 hundredths). */
export const dotsOf = (hundredths: number, dpi: number): number => Math.round((hundredths * dpi) / 2540)

/** Field data for `^FH^FD`: printable ASCII as it is, everything else (and ^ ~ _) as `_XX` UTF-8 bytes. */
export function zplText(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code >= 0x20 && code <= 0x7e && char !== '^' && char !== '~' && char !== '_') {
      out += char
      continue
    }
    for (const byte of new TextEncoder().encode(char)) out += `_${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** The text cut to what fits `widthDots` at font height `heightDots` (font 0 averages 0.55 of its height per character). */
export function fitText(value: string, widthDots: number, heightDots: number): string {
  const max = Math.max(1, Math.floor((widthDots * 20) / (heightDots * 11)))
  const chars = [...value]
  return chars.length <= max ? value : `${chars.slice(0, Math.max(1, max - 3)).join('')}...`
}

const text = (x: number, y: number, height: number, value: string): string => `^FO${x},${y}^A0N,${height},${height}^FH^FD${zplText(value)}^FS`

/**
 * The ZPL of one composed label on the stock, `copies` times. Throws a RangeError for a stock the layout does not fit
 * or a copy count out of range (the print module checks both first, so a request never gets here with them).
 */
export function labelZpl(label: ComposedLabel, stock: LabelStock, copies = 1): string {
  const problems = stockProblems(stock)
  if (problems.length > 0) throw new RangeError(problems.map((problem) => problem.message).join(' '))
  if (!Number.isSafeInteger(copies) || copies < 1 || copies > MAX_LABEL_COPIES) throw new RangeError(`A label is printed 1 to ${MAX_LABEL_COPIES} times.`)
  const dots = (hundredths: number): number => dotsOf(hundredths, stock.dpi)
  const L = LABEL_LAYOUT
  const width = dots(stock.widthMm * 100)
  const height = dots(stock.heightMm * 100)
  const margin = dots(L.margin)
  const inner = width - 2 * margin
  const module = Math.max(2, dots(L.barcode.module))
  const barHeight = dots(L.barcode.height)
  const headingSize = dots(L.heading.size)
  const titleSize = dots(L.title.size)
  const codeSize = dots(L.code.size)
  const labelSize = dots(L.fields.labelSize)
  const valueSize = dots(L.fields.valueSize)
  const column = Math.floor(inner / L.fields.perRow)

  const commands = [
    '^XA',
    '^CI28',
    `^PW${width}`,
    `^LL${height}`,
    '^LH0,0',
    text(margin, dots(L.heading.y), headingSize, fitText(label.heading, inner, headingSize)),
    text(margin, dots(L.title.y), titleSize, fitText(label.title, inner, titleSize)),
    `^FO${margin},${dots(L.barcode.y)}^BY${module},3,${barHeight}^BCN,${barHeight},N,N,N^FD${label.scanId}^FS`,
    text(margin, dots(L.code.y), codeSize, label.scanId),
  ]
  label.fields.forEach((field, index) => {
    const x = margin + (index % L.fields.perRow) * column
    const y = dots(L.fields.y + Math.floor(index / L.fields.perRow) * L.fields.rowHeight)
    commands.push(text(x, y, labelSize, fitText(field.label, column - margin, labelSize)))
    commands.push(text(x, y + dots(L.fields.valueOffset), valueSize, fitText(field.value, column - margin, valueSize)))
  })
  commands.push(`^PQ${copies}`, '^XZ')
  return `${commands.join('\n')}\n`
}
