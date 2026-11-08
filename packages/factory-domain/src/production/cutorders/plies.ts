import type { Issue } from '../../core/errors'
import type { Language } from '../../inventory/rolls/rolls'
import { dotsOf, fitText, stockProblems, zplText, type LabelStock } from '../../labels/zpl'

/**
 * Ply (shade) numbering (B-W2b-112; MES-043; design floor.fabriccut "Ply stickers" — "Each ply and part numbered so a garment's
 * parts come from one ply"), pure. Once a lay's plies are counted at both ends (CHECKED, or CUT), a run of stickers numbers its
 * plies `firstPly`…`lastPly`: every piece the marker cuts from a ply gets a sticker with the ply's number, the size, which garment
 * of that size in the ply, and the part. Sewing joins only pieces of one number, so one garment never mixes the shades of two plies.
 *
 * Pieces per ply: for each cut order line (a cell), its ratio (garments of the size in one ply) × the pieces of each part a
 * garment of that size takes (the pattern pieces of the style's revision cut from this material, B-W2b-95: `quantity`, and only
 * the sizes the piece names), for the parts the run numbers. Parts named in the run that the pattern does not list count once per
 * garment. A run is at most MAX_STICKERS_PER_RUN stickers: a bigger lay is numbered in several runs (first … last). A misprinted
 * run is voided and a new one printed; only its print state changes. No person, no money.
 */

/** The print job's label kind of a ply sticker run (platform/print MODULE_LABEL_KINDS). */
export const PLY_LABEL_KIND = 'PLY' as const
export const MAX_STICKERS_PER_RUN = 2000
export const PLY_LIMITS = Object.freeze({ parts: 40, part: 60 })

export const PLY_REFUSALS = ['PLIES_NOT_COUNTED', 'PLIES_BEYOND_COUNT', 'PLIES_NUMBERED', 'NO_PARTS', 'RUN_TOO_BIG', 'RUN_VOID', 'NOT_FABRIC'] as const
export type PlyRefusalCode = (typeof PLY_REFUSALS)[number]
export interface PlyRefusal {
  readonly code: PlyRefusalCode
  readonly message: string
}

/** One line of the cut order as the stickers need it: its size, its ratio, and the parts a garment of that size takes. */
export interface PlyLine {
  readonly size: string
  readonly ratio: number
  /** The pattern's pieces of this material for the size (name and pieces per garment); empty: the pattern lists none. */
  readonly pieces: readonly { readonly name: string; readonly quantity: number }[]
}

export interface PlySticker {
  readonly ply: number
  readonly size: string
  /** Which garment of the size in this ply (1 … ratio), and of how many. */
  readonly garment: number
  readonly garments: number
  readonly part: string
  /** Which piece of the part (a garment with two sleeves: 1 and 2), and of how many. */
  readonly piece: number
  readonly pieces: number
}

/** The run's parts from the body or the pattern: trimmed, none blank, none twice (paths under `parts/`). */
export function partsProblems(parts: readonly string[]): Issue[] {
  const problems: Issue[] = []
  if (parts.length === 0 || parts.length > PLY_LIMITS.parts) problems.push({ path: 'parts', message: `From 1 to ${PLY_LIMITS.parts} parts.` })
  const seen = new Set<string>()
  parts.forEach((part, index) => {
    const name = part.trim()
    if (name === '' || name.length > PLY_LIMITS.part) problems.push({ path: `parts/${index}`, message: `A part's name, 1 to ${PLY_LIMITS.part} characters.` })
    else if (seen.has(name.toLowerCase())) problems.push({ path: `parts/${index}`, message: `${name} is named twice.` })
    seen.add(name.toLowerCase())
  })
  return problems
}

/** The parts a run numbers by default: every piece the lines' patterns cut from the material, in pattern order. */
export function defaultParts(lines: readonly PlyLine[]): string[] {
  const names: string[] = []
  for (const line of lines) for (const piece of line.pieces) if (!names.some((name) => name.toLowerCase() === piece.name.toLowerCase())) names.push(piece.name)
  return names
}

/** A line's pieces of the run's parts, per garment: the pattern's quantity, else one each. */
function piecesOf(line: PlyLine, parts: readonly string[]): { readonly name: string; readonly quantity: number }[] {
  return parts.flatMap((part) => {
    if (line.pieces.length === 0) return [{ name: part, quantity: 1 }]
    const piece = line.pieces.find((candidate) => candidate.name.toLowerCase() === part.toLowerCase())
    return piece ? [{ name: piece.name, quantity: piece.quantity }] : []
  })
}

/** Stickers one ply takes for the run's parts. */
export const stickersPerPly = (lines: readonly PlyLine[], parts: readonly string[]): number =>
  lines.reduce((sum, line) => sum + line.ratio * piecesOf(line, parts).reduce((pieces, piece) => pieces + piece.quantity, 0), 0)

/** Why the run cannot be made (null: it can). `counted` is the lay's ply count (null: not counted). */
export function plyRunRefusal(run: { readonly firstPly: number; readonly lastPly: number; readonly perPly: number }, lay: { readonly seq: number; readonly status: string; readonly counted: number | null }): PlyRefusal | null {
  if ((lay.status !== 'CHECKED' && lay.status !== 'CUT') || lay.counted === null) {
    return { code: 'PLIES_NOT_COUNTED', message: `Lay ${lay.seq} is ${lay.status.toLowerCase()}: its plies are numbered once they were counted at both ends.` }
  }
  if (run.lastPly > lay.counted) return { code: 'PLIES_BEYOND_COUNT', message: `Lay ${lay.seq} was counted at ${lay.counted} plies: ply ${run.lastPly} is not in it.` }
  if (run.perPly === 0) return { code: 'NO_PARTS', message: 'None of these parts is cut from this material for the lay\'s sizes: name the parts to number.' }
  const total = (run.lastPly - run.firstPly + 1) * run.perPly
  if (total > MAX_STICKERS_PER_RUN) {
    const plies = Math.max(1, Math.floor(MAX_STICKERS_PER_RUN / run.perPly))
    return { code: 'RUN_TOO_BIG', message: `${total} stickers: a run prints at most ${MAX_STICKERS_PER_RUN}. Number ${plies} ${plies === 1 ? 'ply' : 'plies'} at a time.` }
  }
  return null
}

/** Every sticker of the run, ply by ply, then line by line, garment, part and piece. */
export function stickersOf(run: { readonly firstPly: number; readonly lastPly: number }, lines: readonly PlyLine[], parts: readonly string[]): PlySticker[] {
  const stickers: PlySticker[] = []
  for (let ply = run.firstPly; ply <= run.lastPly; ply++) {
    for (const line of lines) {
      const pieces = piecesOf(line, parts)
      for (let garment = 1; garment <= line.ratio; garment++) {
        for (const piece of pieces) {
          for (let index = 1; index <= piece.quantity; index++) stickers.push({ ply, size: line.size, garment, garments: line.ratio, part: piece.name, piece: index, pieces: piece.quantity })
        }
      }
    }
  }
  return stickers
}

const PLY_WORDS = { it: { ply: 'Strato', lay: 'Mat.' }, en: { ply: 'Ply', lay: 'Lay' } } as const

/** A sticker's three lines: "Ply 7 · 48", "Sleeve 1/2", "CO-2026-0001 · Lay 2 · 2/3". */
export function stickerLines(sticker: PlySticker, header: { readonly cutOrderNumber: string; readonly laySeq: number }, language: Language): [string, string, string] {
  const words = PLY_WORDS[language]
  return [
    `${words.ply} ${sticker.ply} · ${sticker.size}`,
    sticker.pieces > 1 ? `${sticker.part} ${sticker.piece}/${sticker.pieces}` : sticker.part,
    `${header.cutOrderNumber} · ${words.lay} ${header.laySeq}${sticker.garments > 1 ? ` · ${sticker.garment}/${sticker.garments}` : ''}`,
  ]
}

/**
 * The run's ZPL on the printer's stock: one label per sticker, in order. Throws a RangeError for a stock the layout does not fit
 * or a run beyond MAX_STICKERS_PER_RUN (the API checks both first).
 */
export function plyRunZpl(stickers: readonly PlySticker[], header: { readonly cutOrderNumber: string; readonly laySeq: number }, stock: LabelStock, language: Language): string {
  const problems = stockProblems(stock)
  if (problems.length > 0) throw new RangeError(problems.map((problem) => problem.message).join(' '))
  if (stickers.length === 0 || stickers.length > MAX_STICKERS_PER_RUN) throw new RangeError(`A run prints 1 to ${MAX_STICKERS_PER_RUN} stickers.`)
  const dots = (millimetres: number): number => dotsOf(millimetres * 100, stock.dpi)
  const width = dots(stock.widthMm)
  const margin = dots(3)
  const inner = width - 2 * margin
  const big = dots(9)
  const middle = dots(6)
  const small = dots(4)
  const line = (y: number, size: number, value: string) => `^FO${margin},${y}^A0N,${size},${size}^FH^FD${zplText(fitText(value, inner, size))}^FS`
  return stickers
    .map((sticker) => {
      const [first, second, third] = stickerLines(sticker, header, language)
      return ['^XA', '^CI28', `^PW${width}`, `^LL${dots(stock.heightMm)}`, '^LH0,0', line(margin, big, first), line(margin + big + dots(2), middle, second), line(margin + big + middle + dots(4), small, third), '^PQ1', '^XZ'].join('\n')
    })
    .join('\n')
    .concat('\n')
}
