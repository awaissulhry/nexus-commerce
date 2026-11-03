/**
 * ISO 2859-1:1999 "Sampling procedures for inspection by attributes — Part 1: Sampling schemes indexed by acceptance
 * quality limit (AQL) for lot-by-lot inspection" (the same tables as ANSI/ASQ Z1.4 and MIL-STD-105E), the two tables the
 * factory's single sampling needs (B-W2b-93; QHS-020):
 *
 * - **Table 1 — Sample size code letters**: the lot size and the inspection level (general I, II, III; special S-1 … S-4)
 *   give the code letter (A … R; the standard skips I and O).
 * - **Table 2-A — Single sampling plans for normal inspection (Master table)**: the code letter and the AQL give the
 *   sample size n, the acceptance number Ac and the rejection number Re (single sampling: Re = Ac + 1), or an arrow:
 *   ↓ "use the first sampling plan below the arrow" (a larger sample), ↑ "use the first sampling plan above the arrow"
 *   (a smaller one). The sample size goes with the plan the arrow leads to, not with the original letter (ISO 2859-1
 *   §10.2). "If sample size equals, or exceeds, lot size, carry out 100 % inspection" (the table's note).
 *
 * Only the AQL columns 0.010 … 10 are kept: above 10 the standard counts nonconformities per hundred items only, and the
 * factory counts garments (items) with a defect, for which ISO 2859-1 allows AQLs up to 10. Normal inspection only:
 * tightened and reduced inspection (Tables 2-B, 2-C) and the switching rules are QHS-022 (Later, not in this wave).
 *
 * The tables are written out below exactly as published, row by row, so they can be read against the standard;
 * aql.vitest.test.ts checks every cell against two independent readings (the diagonal law of the master table, and the
 * published sample-size table for Table 1) and a list of published plans.
 */

/** The inspection levels, as AqlProfile.inspectionLevel stores them (DB enum AqlInspectionLevel), special first. */
export const INSPECTION_LEVELS = ['S1', 'S2', 'S3', 'S4', 'I', 'II', 'III'] as const
export type InspectionLevel = (typeof INSPECTION_LEVELS)[number]

/** The code letters of Table 1 / Table 2-A, smallest sample first. */
export const CODE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R'] as const
export type CodeLetter = (typeof CODE_LETTERS)[number]

/** Table 2-A, column "Sample size": n for each code letter. */
export const SAMPLE_SIZES: Readonly<Record<CodeLetter, number>> = Object.freeze({
  A: 2,
  B: 3,
  C: 5,
  D: 8,
  E: 13,
  F: 20,
  G: 32,
  H: 50,
  J: 80,
  K: 125,
  L: 200,
  M: 315,
  N: 500,
  P: 800,
  Q: 1250,
  R: 2000,
})

/**
 * Table 1 — Sample size code letters. Each row: the lot size range (from, to; to null = "and over") and the letter for
 * S-1, S-2, S-3, S-4, I, II, III, in that order (the order of INSPECTION_LEVELS).
 */
export const TABLE_1: readonly { readonly from: number; readonly to: number | null; readonly letters: string }[] = Object.freeze([
  //  lot size            S1 S2 S3 S4 I  II III
  { from: 2, to: 8, letters: 'A A A A A A B' },
  { from: 9, to: 15, letters: 'A A A A A B C' },
  { from: 16, to: 25, letters: 'A A B B B C D' },
  { from: 26, to: 50, letters: 'A B B C C D E' },
  { from: 51, to: 90, letters: 'B B C C C E F' },
  { from: 91, to: 150, letters: 'B B C D D F G' },
  { from: 151, to: 280, letters: 'B C D E E G H' },
  { from: 281, to: 500, letters: 'B C D E F H J' },
  { from: 501, to: 1200, letters: 'C C E F G J K' },
  { from: 1201, to: 3200, letters: 'C D E G H K L' },
  { from: 3201, to: 10000, letters: 'C D F G J L M' },
  { from: 10001, to: 35000, letters: 'C D F H K M N' },
  { from: 35001, to: 150000, letters: 'D E G J L N P' },
  { from: 150001, to: 500000, letters: 'D E G J M P Q' },
  { from: 500001, to: null, letters: 'D E H K N Q R' },
])

/** The AQL columns of Table 2-A kept here (percent nonconforming items), as the standard prints them. */
export const AQL_COLUMNS = ['0.010', '0.015', '0.025', '0.040', '0.065', '0.10', '0.15', '0.25', '0.40', '0.65', '1.0', '1.5', '2.5', '4.0', '6.5', '10'] as const
export type AqlColumn = (typeof AQL_COLUMNS)[number]

/**
 * Table 2-A — Single sampling plans for normal inspection (Master table), the columns AQL 0.010 … 10 in the order of
 * AQL_COLUMNS. A cell is "Ac/Re", "v" (↓ use the first plan below) or "^" (↑ use the first plan above).
 */
export const TABLE_2A: Readonly<Record<CodeLetter, string>> = Object.freeze({
  //   0.010 0.015 0.025 0.040 0.065 0.10 0.15 0.25 0.40 0.65 1.0  1.5   2.5   4.0   6.5   10
  A: 'v     v     v     v     v     v    v    v    v    v    v    v     v     v     0/1   v',
  B: 'v     v     v     v     v     v    v    v    v    v    v    v     v     0/1   ^     v',
  C: 'v     v     v     v     v     v    v    v    v    v    v    v     0/1   ^     v     1/2',
  D: 'v     v     v     v     v     v    v    v    v    v    v    0/1   ^     v     1/2   2/3',
  E: 'v     v     v     v     v     v    v    v    v    v    0/1  ^     v     1/2   2/3   3/4',
  F: 'v     v     v     v     v     v    v    v    v    0/1  ^    v     1/2   2/3   3/4   5/6',
  G: 'v     v     v     v     v     v    v    v    0/1  ^    v    1/2   2/3   3/4   5/6   7/8',
  H: 'v     v     v     v     v     v    v    0/1  ^    v    1/2  2/3   3/4   5/6   7/8   10/11',
  J: 'v     v     v     v     v     v    0/1  ^    v    1/2  2/3  3/4   5/6   7/8   10/11 14/15',
  K: 'v     v     v     v     v     0/1  ^    v    1/2  2/3  3/4  5/6   7/8   10/11 14/15 21/22',
  L: 'v     v     v     v     0/1   ^    v    1/2  2/3  3/4  5/6  7/8   10/11 14/15 21/22 ^',
  M: 'v     v     v     0/1   ^     v    1/2  2/3  3/4  5/6  7/8  10/11 14/15 21/22 ^     ^',
  N: 'v     v     0/1   ^     v     1/2  2/3  3/4  5/6  7/8  10/11 14/15 21/22 ^    ^     ^',
  P: 'v     0/1   ^     v     1/2   2/3  3/4  5/6  7/8  10/11 14/15 21/22 ^    ^    ^     ^',
  Q: '0/1   ^     v     1/2   2/3   3/4  5/6  7/8  10/11 14/15 21/22 ^   ^    ^    ^     ^',
  R: '^     ^     1/2   2/3   3/4   5/6  7/8  10/11 14/15 21/22 ^    ^   ^    ^    ^     ^',
})

/** One cell of Table 2-A as printed. */
export type TableCell = { readonly kind: 'plan'; readonly accept: number; readonly reject: number } | { readonly kind: 'down' } | { readonly kind: 'up' }

function parseCell(text: string): TableCell {
  if (text === 'v') return { kind: 'down' }
  if (text === '^') return { kind: 'up' }
  const match = /^(\d+)\/(\d+)$/.exec(text)
  if (!match) throw new Error(`ISO 2859-1 Table 2-A: unreadable cell "${text}"`)
  return { kind: 'plan', accept: Number(match[1]), reject: Number(match[2]) }
}

const GRID: Readonly<Record<CodeLetter, readonly TableCell[]>> = Object.freeze(
  Object.fromEntries(
    CODE_LETTERS.map((letter) => {
      const cells = TABLE_2A[letter].trim().split(/\s+/).map(parseCell)
      if (cells.length !== AQL_COLUMNS.length) throw new Error(`ISO 2859-1 Table 2-A: row ${letter} has ${cells.length} cells, not ${AQL_COLUMNS.length}`)
      return [letter, Object.freeze(cells)]
    }),
  ) as Record<CodeLetter, readonly TableCell[]>,
)

const LEVEL_INDEX: Readonly<Record<InspectionLevel, number>> = Object.freeze({ S1: 0, S2: 1, S3: 2, S4: 3, I: 4, II: 5, III: 6 })

export const isCodeLetter = (value: unknown): value is CodeLetter => typeof value === 'string' && (CODE_LETTERS as readonly string[]).includes(value)
export const isInspectionLevel = (value: unknown): value is InspectionLevel => typeof value === 'string' && (INSPECTION_LEVELS as readonly string[]).includes(value)
export const isAqlColumn = (value: unknown): value is AqlColumn => typeof value === 'string' && (AQL_COLUMNS as readonly string[]).includes(value)

/** The smallest lot ISO 2859-1 samples (Table 1 starts at 2); the largest a lot size may be here. */
export const LOT_SIZE_MIN = 2
export const LOT_SIZE_MAX = 10_000_000

/** Table 1: the code letter of a lot of `lotSize` units at `level`. A lot of 1 is inspected whole (no letter). */
export function codeLetterFor(lotSize: number, level: InspectionLevel): CodeLetter {
  if (!Number.isInteger(lotSize) || lotSize < LOT_SIZE_MIN) throw new RangeError(`ISO 2859-1 Table 1 starts at a lot of ${LOT_SIZE_MIN}; got ${lotSize}`)
  const row = TABLE_1.find((entry) => lotSize >= entry.from && (entry.to === null || lotSize <= entry.to))!
  return row.letters.split(' ')[LEVEL_INDEX[level]] as CodeLetter
}

/** The cell of Table 2-A as printed (an arrow or a plan). */
export function tableCell(letter: CodeLetter, aql: AqlColumn): TableCell {
  return GRID[letter][AQL_COLUMNS.indexOf(aql)]!
}

/** A plan of Table 2-A, after the arrows: the letter it sits on, its sample size, Ac and Re. */
export interface TablePlan {
  readonly letter: CodeLetter
  readonly sampleSize: number
  readonly accept: number
  readonly reject: number
  /** The arrow followed from the original letter, if any. */
  readonly arrow: 'down' | 'up' | null
}

/**
 * Table 2-A read at a code letter and an AQL: the plan of the cell, or the first plan the arrow points to in the same
 * column (the letter, and so the sample size, are the plan's).
 */
export function tablePlan(letter: CodeLetter, aql: AqlColumn): TablePlan {
  const column = AQL_COLUMNS.indexOf(aql)
  let row = CODE_LETTERS.indexOf(letter)
  const first = GRID[letter][column]!
  const arrow = first.kind === 'plan' ? null : first.kind
  let cell = first
  while (cell.kind !== 'plan') {
    row += cell.kind === 'down' ? 1 : -1
    if (row < 0 || row >= CODE_LETTERS.length) throw new Error(`ISO 2859-1 Table 2-A: the arrow at ${letter} / ${aql} leads off the table`)
    const next: TableCell = GRID[CODE_LETTERS[row]!][column]!
    // An arrow never points back at the one it came from (the table reads one way down a column, or one way up).
    if (next.kind !== 'plan' && next.kind !== cell.kind) throw new Error(`ISO 2859-1 Table 2-A: arrows meet at ${CODE_LETTERS[row]} / ${aql}`)
    cell = next
  }
  const at = CODE_LETTERS[row]!
  return { letter: at, sampleSize: SAMPLE_SIZES[at], accept: cell.accept, reject: cell.reject, arrow }
}
