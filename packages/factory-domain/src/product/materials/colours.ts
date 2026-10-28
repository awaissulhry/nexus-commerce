import type { Issue } from '../../core/errors'
import { MATERIAL_CODE, MATERIAL_CODE_RULE, normaliseCode } from './rules'

/**
 * A material's colours (feature PRD-032), pure: each material in its colours, with our reference for it (unique per
 * material), its name, the supplier's colour code as it goes on a purchase order, and the library colour it matches.
 * A BOM line resolves to one of them, so the right colour is bought and cut. A colour in use is removed by archiving it
 * (no runtime role deletes product rows); the same code can be restored.
 *
 * Imports carry the colours as one cell: `NER=Nero|T-0001; ROS=Rosso` (code, then `=` and its name, then `|` and the
 * supplier's code; entries split by `;` or new lines). An import adds colours and renames them, never removes one.
 */

export interface ColourFields {
  readonly code: string
  readonly name: string
  readonly supplierColourCode: string | null
}

export function colourProblems(colour: ColourFields, at = ''): Issue[] {
  const issues: Issue[] = []
  if (!MATERIAL_CODE.test(colour.code)) issues.push({ path: `${at}code`, message: `Expected ${MATERIAL_CODE_RULE}.` })
  if (colour.name.trim() === '' || colour.name.trim() !== colour.name || colour.name.length > 120) {
    issues.push({ path: `${at}name`, message: 'Name the colour (at most 120 characters).' })
  }
  const supplier = colour.supplierColourCode
  if (supplier !== null && (supplier.trim() === '' || supplier.trim() !== supplier || supplier.length > 64)) {
    issues.push({ path: `${at}supplierColourCode`, message: "The supplier's colour code is at most 64 characters." })
  }
  return issues
}

/** The colours of one new material: each valid, each code once. */
export function colourListProblems(colours: readonly ColourFields[]): Issue[] {
  const seen = new Set<string>()
  return colours.flatMap((colour, index) => {
    const issues = colourProblems(colour, `colours/${index}/`)
    if (seen.has(colour.code)) issues.push({ path: `colours/${index}/code`, message: 'Each colour code is listed once.' })
    seen.add(colour.code)
    return issues
  })
}

/** A colour as typed: the code trimmed and upper-cased, the texts trimmed, an empty supplier code left out. */
export function normaliseColour(colour: { readonly code: string; readonly name: string; readonly supplierColourCode?: string | null | undefined }): ColourFields {
  const supplier = colour.supplierColourCode?.trim() ?? ''
  return { code: normaliseCode(colour.code), name: colour.name.trim(), supplierColourCode: supplier === '' ? null : supplier }
}

// ---- the colour cell of an import ------------------------------------------------------------------------------------

export type ColourList =
  | { readonly ok: true; readonly colours: readonly ColourFields[] }
  | { readonly ok: false; readonly message: string }

/** Reads `NER=Nero|T-0001; ROS=Rosso`. A code without a name is named by its code. Messages never repeat the cell. */
export function parseColourList(text: string): ColourList {
  const parts = text
    .split(/[;\n\r]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return { ok: false, message: 'Expected colours written CODE=Name, split by ;.' }
  if (parts.length > 200) return { ok: false, message: 'At most 200 colours.' }
  const colours: ColourFields[] = []
  for (const [index, part] of parts.entries()) {
    const [codeAndName = '', supplier] = part.split('|', 2) as [string, string | undefined]
    const at = codeAndName.indexOf('=')
    const code = at < 0 ? codeAndName : codeAndName.slice(0, at)
    const name = at < 0 ? code : codeAndName.slice(at + 1)
    const colour = normaliseColour({ code, name, supplierColourCode: supplier ?? null })
    if (colourProblems(colour).length > 0) {
      return { ok: false, message: `Colour ${index + 1} is not valid: write CODE=Name|supplier code, the code in ${MATERIAL_CODE_RULE}.` }
    }
    if (colours.some((other) => other.code === colour.code)) return { ok: false, message: `Colour ${index + 1} repeats a code.` }
    colours.push(colour)
  }
  return { ok: true, colours }
}

/** The colours as one cell, in code order: what an import compares and stores. */
export function formatColourList(colours: readonly ColourFields[]): string {
  return [...colours]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((colour) => `${colour.code}=${colour.name}${colour.supplierColourCode === null ? '' : `|${colour.supplierColourCode}`}`)
    .join('; ')
}

/**
 * The current colours with the given ones added or renamed (an import never removes a colour, and a colour given
 * without a supplier code keeps the one it has).
 */
export function mergeColours(current: readonly ColourFields[], given: readonly ColourFields[]): ColourFields[] {
  const byCode = new Map(current.map((colour) => [colour.code, colour]))
  for (const colour of given) {
    const known = byCode.get(colour.code)
    byCode.set(colour.code, { ...colour, supplierColourCode: colour.supplierColourCode ?? known?.supplierColourCode ?? null })
  }
  return [...byCode.values()]
}
