import prisma from '../../db.js'

/**
 * 🔴 A-25 (R-22) — "factual attributes never per-language: a code with a localized label, never
 * per-language free text" (docs/2026-09-11-language-axis-design.md:85-86). A closed choice list stores
 * a CODE; each market's label is a projection of it. It therefore cannot be made per-language.
 */
export const CODE_TYPES: ReadonlySet<string> = new Set(['select', 'multiselect'])
export const CODE_NOT_LOCALIZABLE = 'A choice list stores a code, and each market shows its own label for it, so it cannot be made per-language.'

/** The refusal for making a STORED attribute per-language, or null when it may be. */
export async function localizableRefusalFor(attributeId: string): Promise<string | null> {
  const current = await prisma.customAttribute.findUnique({ where: { id: attributeId }, select: { type: true } })
  return current && CODE_TYPES.has(current.type) ? CODE_NOT_LOCALIZABLE : null
}
