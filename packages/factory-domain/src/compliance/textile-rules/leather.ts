import type { Finding } from './composition'
import { normalisedWords } from './fibres'

/**
 * The Italian leather naming check (B-W2b-208; PRD-345; D.Lgs. 9 giugno 2020, n. 68): "cuoio", "pelle", "pelliccia", the
 * words made from them and their translations are kept for materials obtained from an animal's skin; "pieno fiore" (full
 * grain) only for leather whose grain is whole; leather fibres bound together are "cuoio rigenerato" or "fibre di cuoio",
 * never "pelle" or "cuoio" alone. Read from the style revision's materials (their names in every language, kind, animal
 * origin and finish) and from the style's own names. Pure.
 */

export interface LeatherMaterial {
  readonly code: string
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string>> | null
  readonly kind: string
  readonly animalOrigin: boolean
  readonly finish: string | null
}

export interface LeatherStyle {
  readonly code: string
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string>> | null
  readonly description: string | null
}

const RESERVED_EXACT = new Set(['pelle', 'pelli', 'pellame', 'cuoio', 'cuoi', 'pelliccia', 'pellicce', 'leather', 'leathers', 'fur', 'furs', 'leder', 'cuir', 'piel', 'cuero', 'pelz', 'fourrure'])

/** The reserved words a text uses ("ecopelle", "vegan leather", "similpelle"…), as written in it. */
export function reservedWords(text: string): string[] {
  const found = new Set<string>()
  for (const token of normalisedWords(text).split(/[^a-z]+/)) {
    if (token === '') continue
    if (RESERVED_EXACT.has(token) || token.endsWith('pelle') || token.endsWith('cuoio') || token.endsWith('pelliccia') || token.includes('leather')) found.add(token)
  }
  return [...found]
}

const FULL_GRAIN = /\b(pieno fiore|fiore pieno|full grain|full-grain|fullgrain)\b/
const REGENERATED = /\b(rigenerat\w*|bonded|reconstitut\w*|fibre di cuoio|fibra di cuoio|leather fibre\w*|leather fiber\w*)\b/

const namesOf = (thing: { readonly name: string; readonly nameI18n: Readonly<Record<string, string>> | null }): string[] => [thing.name, ...Object.values(thing.nameI18n ?? {})].filter((value) => typeof value === 'string' && value.trim() !== '')

const isLeather = (material: LeatherMaterial): boolean => material.kind === 'LEATHER'

/** The findings over the materials of the BOM and the style's names; empty when every name is right. */
export function leatherNaming(style: LeatherStyle, materials: readonly LeatherMaterial[]): Finding[] {
  const findings: Finding[] = []
  for (const material of materials) {
    const names = namesOf(material)
    const words = [...new Set(names.flatMap(reservedWords))]
    const path = `materials/${material.code}`
    if (!isLeather(material)) {
      if (words.length > 0) {
        findings.push({ path: `${path}/name`, severity: 'FAIL', message: `Material ${material.code} is ${material.kind.toLowerCase()}, not leather, and its name says "${words.join('", "')}": these words are kept for materials from an animal's skin (D.Lgs. 68/2020). Rename it.` })
      }
      continue
    }
    if (!material.animalOrigin) {
      findings.push({ path: `${path}/animalOrigin`, severity: 'FAIL', message: `Material ${material.code} is leather and is not marked of animal origin: mark it, so the label carries the animal-origin phrase.` })
    }
    const text = normalisedWords(names.join(' '))
    const finish = material.finish === null ? null : normalisedWords(material.finish)
    if (REGENERATED.test(text) || (finish !== null && REGENERATED.test(finish))) {
      const plainName = names.some((name) => reservedWords(name).length > 0 && !REGENERATED.test(normalisedWords(name)))
      findings.push(
        plainName
          ? { path: `${path}/name`, severity: 'FAIL', message: `Material ${material.code} is leather fibres bound together: it is "cuoio rigenerato" or "fibre di cuoio", never "pelle" or "cuoio" alone (D.Lgs. 68/2020). Rename it.` }
          : { path: `${path}/name`, severity: 'WARN', message: `Material ${material.code} is leather fibres bound together: name it "cuoio rigenerato" or "fibre di cuoio", and only with at least 50 % leather fibres by dry weight (D.Lgs. 68/2020).` },
      )
    }
    if (FULL_GRAIN.test(text)) {
      if (finish === null) {
        findings.push({ path: `${path}/finish`, severity: 'WARN', message: `Material ${material.code} is called full grain ("pieno fiore") and its finish is not on record: full grain cannot be checked.` })
      } else if (!FULL_GRAIN.test(finish)) {
        findings.push({ path: `${path}/name`, severity: 'FAIL', message: `Material ${material.code} is called full grain ("pieno fiore"), and its finish is "${material.finish}": "pieno fiore" is kept for leather whose grain is whole (D.Lgs. 68/2020).` })
      }
    }
  }
  const hasLeather = materials.some((material) => isLeather(material) && material.animalOrigin)
  const styleWords = [...new Set([...namesOf(style), ...(style.description ? [style.description] : [])].flatMap(reservedWords))]
  if (styleWords.length > 0 && !hasLeather) {
    findings.push({ path: 'style/name', severity: 'FAIL', message: `Style ${style.code} says "${styleWords.join('", "')}" in its name or description, and no material of its BOM is leather from an animal's skin (D.Lgs. 68/2020). Rename it or check the BOM.` })
  }
  return findings
}
