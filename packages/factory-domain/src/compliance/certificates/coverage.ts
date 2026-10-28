import type { Issue } from '../../core/errors'

/**
 * What a certificate covers (QHS-103, PRD-281, PRD-288; Reg. (EU) 2016/425 Annex V 6.2(c)): one style, in some of its
 * colourways and sizes (none listed: all of them), with or without made-to-measure units; or one item (a protector, a
 * material it was tested with). One active coverage per certificate and style or item: the API keeps it so (the
 * database cannot, a coverage row has no natural key), and an end of coverage is ARCHIVED, never deleted.
 */

export interface CoverageInput {
  readonly styleId?: string | null | undefined
  readonly itemId?: string | null | undefined
  readonly colourwayIds?: readonly string[] | undefined
  readonly sizes?: readonly string[] | undefined
  readonly allowsMadeToMeasure?: boolean | undefined
}

/** The covered style as the API read it: its size range and its colourways. */
export interface CoveredStyle {
  readonly sizes: readonly string[]
  readonly colourwayIds: readonly string[]
}

const duplicates = (values: readonly string[]): string[] => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]

/** What is wrong with a coverage; `style` is the covered style (null for an item's coverage). Paths are field names. */
export function coverageProblems(input: CoverageInput, style: CoveredStyle | null): Issue[] {
  const colourwayIds = input.colourwayIds ?? []
  const sizes = input.sizes ?? []
  const hasStyle = typeof input.styleId === 'string' && input.styleId !== ''
  const hasItem = typeof input.itemId === 'string' && input.itemId !== ''
  if (hasStyle === hasItem) return [{ path: 'styleId', message: 'A coverage covers exactly one style or one item.' }]

  const problems: Issue[] = []
  if (hasItem) {
    if (colourwayIds.length > 0) problems.push({ path: 'colourwayIds', message: "An item's coverage names no colourways." })
    if (sizes.length > 0) problems.push({ path: 'sizes', message: "An item's coverage names no sizes." })
    if (input.allowsMadeToMeasure) problems.push({ path: 'allowsMadeToMeasure', message: 'Made-to-measure units are covered through a style, not an item.' })
    return problems
  }
  for (const value of duplicates(colourwayIds)) problems.push({ path: 'colourwayIds', message: `Colourway ${value} is listed twice.` })
  for (const value of duplicates(sizes)) problems.push({ path: 'sizes', message: `Size ${value} is listed twice.` })
  if (style) {
    colourwayIds.forEach((value, index) => {
      if (!style.colourwayIds.includes(value)) problems.push({ path: `colourwayIds/${index}`, message: 'Not a colourway of the style.' })
    })
    sizes.forEach((value, index) => {
      if (!style.sizes.includes(value)) problems.push({ path: `sizes/${index}`, message: `Size ${value} is not in the style's size range (${style.sizes.join(', ') || 'none'}).` })
    })
  }
  return problems
}
