import { dotsOf, fitText, MAX_LABEL_COPIES, stockProblems, zplText, type LabelStock } from '../../labels/zpl'

/**
 * A machine's QR tag (B-W2b-136; QHS-164; design plant.machines › Machine › "Tag" and pop "Print QR tags"): the label
 * stuck on the machine. Its QR holds the ASSET NUMBER, exactly as the W2a tag sheet prints it (B-W2a-53): a station's
 * scan reads a free code as a machine tag and opens the machine with "Report a problem" (B-W2a-73), so a tag printed
 * again is the same tag and an old one keeps working. A phone camera reads the number only: the no-login report form
 * (QHS-182) is Later.
 *
 * The office sends tags to a label printer of the machine's site (platform/print's queue: QUEUED → SENT → PRINTED, or
 * FAILED and sent again), or prints the tag sheet from the browser. Words come from the caller in the person's language.
 */

/** The print job's label kind of a machine tag (platform/print MODULE_LABEL_KINDS). */
export const MACHINE_TAG_KIND = 'MACHINE' as const

/** At most this many tags in one "Print QR tags". */
export const MAX_TAGS_AT_ONCE = 50
/** Copies of each tag (one on the machine, a spare). */
export const MAX_TAG_COPIES = 5

export interface MachineTag {
  readonly assetNumber: string
  /** The machine's type in words ("Lockstitch"). */
  readonly typeWords: string
  /** Where it stands ("A1 · SEW-02"). */
  readonly placeWords: string
  /** "Scan to report a problem" in the tag's language. */
  readonly scanWords: string
}

/**
 * The ZPL of one machine tag on the printer's stock, `copies` times: the QR (the asset number) on the left, the asset
 * number big beside it, the type, the place and what the scan does under it. Throws a RangeError for a stock the layout
 * does not fit or copies out of range (the API checks both first).
 */
export function machineTagZpl(tag: MachineTag, stock: LabelStock, copies = 1): string {
  const problems = stockProblems(stock)
  if (problems.length > 0) throw new RangeError(problems.map((problem) => problem.message).join(' '))
  if (!Number.isSafeInteger(copies) || copies < 1 || copies > Math.min(MAX_TAG_COPIES, MAX_LABEL_COPIES)) throw new RangeError(`A tag is printed 1 to ${MAX_TAG_COPIES} times.`)
  const dots = (millimetres: number): number => dotsOf(millimetres * 100, stock.dpi)
  const width = dots(stock.widthMm)
  const height = dots(stock.heightMm)
  const margin = dots(3)
  // The QR: magnification so the code is about 60% of the label's height (a version-2 code is 25 modules + quiet zone).
  const qrSide = Math.floor(height * 0.6)
  const magnification = Math.max(2, Math.min(10, Math.floor(qrSide / 29)))
  const textX = margin + magnification * 29 + margin
  const textWidth = Math.max(dots(10), width - textX - margin)
  const big = dots(7)
  const small = dots(3.5)
  const line = (y: number, size: number, value: string) => `^FO${textX},${y}^A0N,${size},${size}^FH^FD${zplText(fitText(value, textWidth, size))}^FS`
  return [
    '^XA',
    '^CI28',
    `^PW${width}`,
    `^LL${height}`,
    '^LH0,0',
    // Model 2, error correction H (a tag on a machine gets scratched); the data after "HA," is the asset number.
    `^FO${margin},${margin}^BQN,2,${magnification}^FH^FDHA,${zplText(tag.assetNumber)}^FS`,
    line(margin, big, tag.assetNumber),
    line(margin + big + dots(2), small, tag.typeWords),
    line(margin + big + dots(2) + small + dots(1.5), small, tag.placeWords),
    `^FO${margin},${height - margin - small}^A0N,${small},${small}^FH^FD${zplText(fitText(tag.scanWords, width - 2 * margin, small))}^FS`,
    `^PQ${copies}`,
    '^XZ',
  ].join('\n')
}

/** The words of a tag in Italian or English (the label's language is the person's). */
export const TAG_WORDS = Object.freeze({
  it: { scan: 'Inquadra per segnalare un problema' },
  en: { scan: 'Scan to report a problem' },
} as const)
export type TagLanguage = keyof typeof TAG_WORDS
