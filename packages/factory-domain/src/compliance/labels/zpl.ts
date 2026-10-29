import { code128Bars } from '../../labels/code128'
import { dotsOf, LABEL_DPIS, MAX_LABEL_COPIES, zplText } from '../../labels/zpl'
import { hundredthsOf, LAYOUT_PRESETS } from './rules'
import type { RenderedBlock, RenderedLabel } from './render'

/**
 * The garment label as ZPL II for a label printer (B-W1-19; plan A1 §3.9), pure: the rendered label's blocks top to
 * bottom inside the preset's margins, in the same geometry as the API's PDF (hundredths of a millimetre, turned into
 * the printer's dots). Text goes through `^FH` hex escapes under `^CI28` (factory-domain labels/zpl.ts `zplText`), so a
 * value can never start a ZPL command.
 *
 * The drawn marks are stand-ins until the artwork is licensed or drawn (W2b): the CE mark as the letters "CE" at the
 * mark's height (the CE marking's own proportions, Reg. (EC) 765/2008 Annex II, come with the artwork), the pictogram
 * as a framed box with the standard and the class letters, each care symbol as a framed box with its short mark. The
 * batch number or serial is also printed as Code 128 bars (`^BC`, B-W1-44: packing scans the serial), as wide a module
 * as the label holds (1 to 3 dots); a preview's empty bar row is a framed box. A sample (preview, test print) carries a
 * black band with the SAMPLE banner across the middle.
 */

export interface GarmentPrint {
  readonly x: number
  readonly y: number
}

/** Where each block starts (hundredths of a millimetre from the label's top left). */
export function blockPositions(label: Pick<RenderedLabel, 'blocks' | 'preset'>): GarmentPrint[] {
  const preset = LAYOUT_PRESETS[label.preset]
  let y = preset.margin
  return label.blocks.map((block) => {
    const at = { x: preset.margin, y }
    y += block.height + preset.gap
    return at
  })
}

/** The height of a block's drawn element (hundredths), 0 without one. */
export function graphicHeight(block: Pick<RenderedBlock, 'graphic'>, preset: (typeof LAYOUT_PRESETS)[keyof typeof LAYOUT_PRESETS]): number {
  if (!block.graphic) return 0
  const kind = block.graphic.kind
  return kind === 'CE' ? preset.ce : kind === 'PICTOGRAM' ? preset.pictogram : kind === 'BARCODE' ? preset.barcode : preset.care
}

/** The bars' height inside their row (hundredths): a little space is left above the value's text line. */
export const barHeight = (preset: (typeof LAYOUT_PRESETS)[keyof typeof LAYOUT_PRESETS]): number => preset.barcode - 80

/**
 * The module (narrowest bar) of a Code 128 symbol of `value` that fits `inner` dots: 1 to 3 dots, the widest that fits
 * (a 203 dpi head prints 0.125 mm per dot; a 50 mm label holds a serial at 1 dot, a 300 dpi head at 2).
 */
export function barModule(value: string, inner: number): number {
  return Math.max(1, Math.min(3, Math.floor(inner / code128Bars(value).modules)))
}

/**
 * The ZPL of the label at the printer's resolution, `copies` times. Throws a RangeError for a resolution the printers do
 * not have, a label size that is not readable, or a copy count out of range (the API checks them first).
 */
export function garmentLabelZpl(label: RenderedLabel, dpi: number, copies = 1): string {
  if (!(LABEL_DPIS as readonly number[]).includes(dpi)) throw new RangeError(`A label printer prints at ${LABEL_DPIS.join(', ')} dpi.`)
  if (!Number.isSafeInteger(copies) || copies < 1 || copies > MAX_LABEL_COPIES) throw new RangeError(`A label is printed 1 to ${MAX_LABEL_COPIES} times.`)
  const width = label.fit ? hundredthsOf(label.fit.widthMm) : null
  const height = label.fit ? hundredthsOf(label.fit.heightMm) : null
  if (width === null || height === null) throw new RangeError('The label has no readable size.')
  const dots = (hundredths: number): number => dotsOf(hundredths, dpi)
  const preset = LAYOUT_PRESETS[label.preset]
  const text = (x: number, y: number, size: number, value: string): string => `^FO${dots(x)},${dots(y)}^A0N,${dots(size)},${dots(size)}^FH^FD${zplText(value)}^FS`
  const box = (x: number, y: number, w: number, h: number): string => `^FO${dots(x)},${dots(y)}^GB${dots(w)},${dots(h)},${Math.max(1, dots(20))}^FS`

  const commands = ['^XA', '^CI28', `^PW${dots(width)}`, `^LL${dots(height)}`, '^LH0,0']
  const positions = blockPositions(label)
  label.blocks.forEach((block, index) => {
    const { x, y } = positions[index]!
    const graphic = block.graphic
    if (graphic?.kind === 'CE') {
      commands.push(text(x, y, preset.ce, 'CE'))
      if (graphic.notifiedBodyNumber) commands.push(text(x + Math.round(preset.ce * 1.5), y + Math.round(preset.ce * 0.4), Math.round(preset.ce * 0.55), graphic.notifiedBodyNumber))
    } else if (graphic?.kind === 'PICTOGRAM') {
      const side = preset.pictogram
      commands.push(box(x, y, side, side))
      commands.push(text(x + 60, y + 60, Math.round(side * 0.16), graphic.standardCode ?? ''))
      if (graphic.ppeClass) commands.push(text(x + 80, y + Math.round(side * 0.42), Math.round(side * 0.45), graphic.ppeClass))
    } else if (graphic?.kind === 'CARE') {
      const side = preset.care
      graphic.symbols.forEach((symbol, at) => {
        const left = x + at * (side + 80)
        commands.push(box(left, y, side, side))
        commands.push(text(left + 40, y + Math.round(side * 0.3), Math.round(side * 0.4), symbol.mark))
      })
    } else if (graphic?.kind === 'BARCODE') {
      const bars = dots(barHeight(preset))
      if (graphic.value === null) commands.push(box(x, y, width - 2 * preset.margin, barHeight(preset)))
      else commands.push(`^FO${dots(x)},${dots(y)}^BY${barModule(graphic.value, dots(width - 2 * preset.margin))},3,${bars}^BCN,${bars},N,N,N^FH^FD${zplText(graphic.value)}^FS`)
    }
    let lineY = y + graphicHeight(block, preset)
    for (const line of block.lines) {
      commands.push(text(x, lineY, preset.text, line.text))
      lineY += preset.line
    }
  })

  if (label.banner.length > 0) {
    const band = label.banner.length * preset.line + 2 * preset.gap + 100
    const top = Math.max(0, Math.round((height - band) / 2))
    commands.push(`^FO0,${dots(top)}^GB${dots(width)},${dots(band)},${dots(band)}^FS`)
    label.banner.forEach((line, at) => commands.push(`^FO${dots(preset.margin)},${dots(top + preset.gap + 50 + at * preset.line)}^FR^A0N,${dots(preset.text)},${dots(preset.text)}^FH^FD${zplText(line)}^FS`))
  }
  commands.push(`^PQ${copies}`, '^XZ')
  return `${commands.join('\n')}\n`
}
