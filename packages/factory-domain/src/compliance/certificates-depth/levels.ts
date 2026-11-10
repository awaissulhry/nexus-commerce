import type { Issue } from '../../core/errors'

/**
 * Performance levels a certificate grants beyond its class (B-W2b-255; PRD-290 glove levels per EN 13594; EN 1621
 * protector zones for the bought-in parts of QHS-106). B-W2b-216's Certificate.performanceLevels holds them as one level
 * per property (`{ "level": "2", "knuckle": "KP" }`); the database checks only the shape (1-30 properties, a small
 * letter then letters and digits, levels of 1-20 characters). The vocabulary is this file's: which properties each
 * standard takes, which values each may have, which one is required. A standard with no vocabulary here takes no levels
 * (W1's class or level says it all). Pure.
 *
 *   EN 13594 (motorcyclists' gloves)        level 1 | 2 (required) · knuckle KP (knuckle protection, when tested)
 *   EN 1621-1 (limb impact protectors)       shoulder · elbow · hip · knee · leg · kneeLeg: 1 | 2 (at least one) ·
 *                                            type A | B (the protector's size type)
 *   EN 1621-2 (back protectors)              back 1 | 2 (required) · backArea FB | CB | LB (full, central, lower back)
 *   EN 1621-3 (chest protectors)             chest 1 | 2 (required) · chestArea FULL | DIVIDED
 *
 * Gloves are made only if the Owner says so (OWNER-QUESTIONS Q10; plan question 5 answered A: the rule is built and
 * stays switched off until needed): the glove levels are data a person types from a glove certificate; the seeded
 * GLOVE-LEVELS requirement of B-W2b-216 stays OFF, so nothing is refused because of them.
 */

export const LEVEL_FAMILIES = ['EN13594', 'EN1621-1', 'EN1621-2', 'EN1621-3'] as const
export type LevelFamily = (typeof LEVEL_FAMILIES)[number]

export interface LevelProperty {
  readonly key: string
  readonly values: readonly string[]
  /** Always given (EN 13594's level, a back protector's level). */
  readonly required: boolean
  /** One of the zones (EN 1621-1: at least one zone has a level). */
  readonly zone?: boolean
}

export interface LevelVocabulary {
  readonly family: LevelFamily
  readonly properties: readonly LevelProperty[]
}

const ONE_TWO = ['1', '2'] as const

export const LEVEL_VOCABULARY: Readonly<Record<LevelFamily, LevelVocabulary>> = Object.freeze({
  EN13594: {
    family: 'EN13594',
    properties: [
      { key: 'level', values: ONE_TWO, required: true },
      { key: 'knuckle', values: ['KP'], required: false },
    ],
  },
  'EN1621-1': {
    family: 'EN1621-1',
    properties: [
      ...['shoulder', 'elbow', 'hip', 'knee', 'leg', 'kneeLeg'].map((key) => ({ key, values: ONE_TWO, required: false, zone: true })),
      { key: 'type', values: ['A', 'B'], required: false },
    ],
  },
  'EN1621-2': {
    family: 'EN1621-2',
    properties: [
      { key: 'back', values: ONE_TWO, required: true },
      { key: 'backArea', values: ['FB', 'CB', 'LB'], required: false },
    ],
  },
  'EN1621-3': {
    family: 'EN1621-3',
    properties: [
      { key: 'chest', values: ONE_TWO, required: true },
      { key: 'chestArea', values: ['FULL', 'DIVIDED'], required: false },
    ],
  },
})

/** The level vocabulary a standard takes ("EN 13594:2015" → EN13594), or null when it takes none. */
export function levelFamilyOf(standard: string): LevelFamily | null {
  const text = standard.trim().toUpperCase().replace(/\s+/g, ' ')
  if (/^EN ?13594\b/.test(text)) return 'EN13594'
  const part = /^EN ?1621-(\d)\b/.exec(text)?.[1]
  if (part === '1') return 'EN1621-1'
  if (part === '2') return 'EN1621-2'
  if (part === '3') return 'EN1621-3'
  return null
}

export type Levels = Readonly<Record<string, string>>

/** The stored JSON as levels (anything but an object of strings: none). */
export function levelsOf(value: unknown): Levels | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/** Levels without empty values, each value trimmed (what is stored; null when nothing is left). */
export function cleanLevels(levels: Readonly<Record<string, string | null | undefined>>): Levels | null {
  const entries = Object.entries(levels)
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''] as const)
    .filter(([, value]) => value !== '')
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/**
 * What is wrong with the levels for this standard (paths `levels/<property>`); empty when they hold. A standard without
 * a vocabulary takes no levels; the class W1 typed must agree with EN 13594's level and an EN 1621 back or chest level.
 */
export function levelsProblems(standard: string, ppeClass: string | null, levels: Levels | null): Issue[] {
  if (levels === null) return []
  const family = levelFamilyOf(standard)
  if (!family) return [{ path: 'levels', message: `${standard} takes no performance levels here: its class or level on the certificate says it.` }]
  const vocabulary = LEVEL_VOCABULARY[family]
  const problems: Issue[] = []
  for (const [key, value] of Object.entries(levels)) {
    const property = vocabulary.properties.find((entry) => entry.key === key)
    if (!property) problems.push({ path: `levels/${key}`, message: `${standard} has no property "${key}" (it takes ${vocabulary.properties.map((entry) => entry.key).join(', ')}).` })
    else if (!property.values.includes(value)) problems.push({ path: `levels/${key}`, message: `"${key}" is ${property.values.join(' or ')} under ${standard}, not "${value}".` })
  }
  for (const property of vocabulary.properties) {
    if (property.required && !(property.key in levels)) problems.push({ path: `levels/${property.key}`, message: `${standard} certifies a "${property.key}" level (${property.values.join(' or ')}).` })
  }
  if (family === 'EN1621-1' && !vocabulary.properties.some((property) => property.zone && property.key in levels)) {
    problems.push({ path: 'levels', message: `Give the level of at least one zone the EN 1621-1 protector covers (${vocabulary.properties.filter((entry) => entry.zone).map((entry) => entry.key).join(', ')}).` })
  }
  const main = family === 'EN13594' ? levels.level : family === 'EN1621-2' ? levels.back : family === 'EN1621-3' ? levels.chest : undefined
  const typedClass = ppeClass?.trim() ?? ''
  if (main && /^[12]$/.test(main) && /^[12]$/.test(typedClass) && typedClass !== main) {
    problems.push({ path: 'levels', message: `The certificate's class or level is ${typedClass} but its performance level is ${main}: the two must agree.` })
  }
  return problems
}

/** Whether two sets of levels say the same (the order of the properties aside; none = none). */
export function sameLevels(a: Levels | null, b: Levels | null): boolean {
  const keys = (levels: Levels | null) => Object.keys(levels ?? {}).sort()
  const left = keys(a)
  const right = keys(b)
  return left.length === right.length && left.every((key, index) => key === right[index] && a![key] === b![key])
}

/** The glove's marking as EN 13594 prints it beside the pictogram ("2KP", "1"), or null without a level. */
export function gloveMarking(levels: Levels | null): string | null {
  if (!levels?.level) return null
  return `${levels.level}${levels.knuckle === 'KP' ? 'KP' : ''}`
}

/** The levels in the vocabulary's order (the screen words each property), unknown properties last. */
export function orderedLevels(standard: string, levels: Levels | null): Array<{ key: string; value: string }> {
  if (!levels) return []
  const family = levelFamilyOf(standard)
  const order = family ? LEVEL_VOCABULARY[family].properties.map((property) => property.key) : []
  const rank = (key: string) => (order.indexOf(key) === -1 ? order.length : order.indexOf(key))
  return Object.entries(levels)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
}
