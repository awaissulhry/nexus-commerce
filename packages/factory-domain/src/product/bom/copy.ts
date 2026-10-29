import type { BomLineData } from './rules'

/**
 * Copying a frozen revision's BOM into a new DRAFT (plan A1 §2.5: a change to a released style is a new revision), pure:
 * every line with its place, material, unit, quantity, wastage, size quantities and colour grid, under new ids. Nothing
 * is checked again here: the new draft's issues (./rules bomIssues) show what changed in the library since (a material
 * or colour archived, a size or colourway gone).
 */

export function copyLines(lines: readonly BomLineData[], newId: () => string): BomLineData[] {
  return [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({
      ...line,
      id: newId(),
      sizes: line.sizes.map((row) => ({ ...row })),
      colours: line.colours.map((cell) => ({ ...cell })),
    }))
}
