import type { Issue } from '../../core/errors'
import { defineMachine } from '../../state/machine'
import { MASTER_STATUSES } from '../sizes/rules'

/**
 * A style's colourways (feature PRD-004), pure: the colour variants of a style (main leather colour, contrast panels,
 * stitching, logos), each with our code (unique in the style; the SKUs carry it), its name, the library colour of its
 * main material and a free description. Orders, BOM colours and stock are per colourway. A colourway in use is
 * archived, never deleted (PRD-022), and its code never changes once used (its SKUs, BOM colour cells and order lines
 * name it); the API asks the database what uses it.
 */

/** A colourway code: 1 to 12 capital letters or digits, with . or _ inside ("BLK", "RED.WHT"); never `-` (./sku). */
export const COLOURWAY_CODE = /^[A-Z0-9](?:[A-Z0-9._]{0,10}[A-Z0-9])?$/
export const COLOURWAY_CODE_RULE = '1 to 12 capital letters or digits, with . or _ inside (no -)'
export const MAX_COLOURWAYS = 100

/** ACTIVE ↔ ARCHIVED: an archived colourway's SKUs are off; restored, its SKUs in the range come back (./matrix). */
export const colourwayMachine = defineMachine({ name: 'colourway', states: MASTER_STATUSES, transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: ['ACTIVE'] } })

export interface ColourwayFields {
  readonly code: string
  readonly name: string
  /** The library colour of its main material. */
  readonly colourId: string | null
  /** Its contrast panels, stitching and logos. */
  readonly description: string | null
}

/** A colourway as typed: the code upper-cased, the texts trimmed (an empty description is none). */
export function normaliseColourway(colourway: { readonly code: string; readonly name: string; readonly colourId?: string | null | undefined; readonly description?: string | null | undefined }): ColourwayFields {
  const description = colourway.description?.trim() ?? ''
  return { code: colourway.code.trim().toUpperCase(), name: colourway.name.trim(), colourId: colourway.colourId ?? null, description: description === '' ? null : description }
}

export function colourwayProblems(colourway: ColourwayFields, at = ''): Issue[] {
  const issues: Issue[] = []
  if (!COLOURWAY_CODE.test(colourway.code)) issues.push({ path: `${at}code`, message: `Expected ${COLOURWAY_CODE_RULE}.` })
  if (colourway.name === '' || colourway.name.length > 120) issues.push({ path: `${at}name`, message: 'Name the colourway (at most 120 characters).' })
  if (colourway.description !== null && colourway.description.length > 1000) issues.push({ path: `${at}description`, message: 'At most 1000 characters.' })
  return issues
}

/** The colourways of a new style, or added to one: each valid, each code once (also against the style's `taken` codes). */
export function colourwayListProblems(colourways: readonly ColourwayFields[], taken: readonly string[] = [], at = 'colourways/'): Issue[] {
  if (colourways.length + taken.length > MAX_COLOURWAYS) return [{ path: at.replace(/\/$/, ''), message: `A style has at most ${MAX_COLOURWAYS} colourways.` }]
  const seen = new Set(taken)
  return colourways.flatMap((colourway, index) => {
    const issues = colourwayProblems(colourway, `${at}${index}/`)
    if (seen.has(colourway.code)) issues.push({ path: `${at}${index}/code`, message: `The style has colourway ${colourway.code} already.` })
    seen.add(colourway.code)
    return issues
  })
}

/** Why a colourway cannot get a new code: something names it (`uses` from the database: SKUs, BOM cells, order lines). */
export function colourwayCodeChangeRefusal(code: string, uses: number): string | null {
  return uses > 0 ? `Colourway ${code} is in use (its SKUs, BOM colours or order lines name it): its code never changes.` : null
}
