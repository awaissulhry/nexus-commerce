import { animalOriginText, type CareEntry, type CompositionPart, type LabelLayout } from '../labels/rules'
import { careWordsOf, CARE_GROUP_WORDS, missingCareGroups, type CareGroup, type CareWordsOfEntry } from './care'
import {
  compareWithLabel,
  computeComposition,
  fibresOf,
  partText,
  roleOf,
  textileShareOf,
  type ComputedPart,
  type Finding,
  type LineFacts,
  type TextileShare,
} from './composition'
import { officialName, readFibre } from './fibres'
import { leatherNaming, type LeatherMaterial, type LeatherStyle } from './leather'
import { originCheck, type OriginCheck, type PlaceFacts, type StepFacts } from './origin'

/**
 * The textile, leather and origin checks of one style revision (B-W2b-208; PRD-338 … PRD-345), each a sentence with its
 * outcome and its legal reference (the label's Rule checks, design compliance.labels › lb-checks; the "Why this rule"
 * popover reads `law`). Pure: the API gathers the facts (modules/compliance/textile-rules).
 *
 *   composition     the parts' fibres computed from the BOM against the label's typed composition (PRD-338)
 *   fibreNames      the fibres typed on the materials and the label are names of Annex I, in each printed language (PRD-338)
 *   animalOrigin    the art. 12 phrase on the label exactly when the BOM has a non-textile part of animal origin (PRD-339)
 *   textileShare    the 80 % threshold of art. 2(2)(a) (PRD-340)                                          SWITCH, OFF
 *   careLabel       the five groups of care symbols and their words in each printed language (PRD-342)    SWITCH, OFF
 *   madeInItaly     "Made in Italy" from where each routing step is done (PRD-344)                        SWITCH, OFF
 *   leatherNaming   the Italian leather words on materials and the style (PRD-345)
 *
 * The three switches are OFF by default (Owner 2026-11-09: rules for lines and claims still open in OWNER-QUESTIONS Q10,
 * Q22, Q23 are built switched off until a style or a market needs them). A switched-off check still computes: its
 * values come back, its outcome is OFF with the words that say why.
 */

export const CHECK_KEYS = ['composition', 'fibreNames', 'animalOrigin', 'textileShare', 'careLabel', 'madeInItaly', 'leatherNaming'] as const
export type CheckKey = (typeof CHECK_KEYS)[number]

export const SWITCHABLE_RULES = ['textileShare', 'careLabel', 'madeInItaly'] as const
export type SwitchableRule = (typeof SWITCHABLE_RULES)[number]
export const isSwitchableRule = (value: string): value is SwitchableRule => (SWITCHABLE_RULES as readonly string[]).includes(value)

export type Switches = Readonly<Record<SwitchableRule, boolean>>
/** Every switch OFF until a person switches it on. */
export const DEFAULT_SWITCHES: Switches = Object.freeze({ textileShare: false, careLabel: false, madeInItaly: false })

export const SWITCH_REASON_MIN = 3
export const SWITCH_REASON_MAX = 300

export interface LawReference {
  readonly law: string
  readonly plain: string
  readonly href: string | null
}

const REG_1007 = 'https://eur-lex.europa.eu/eli/reg/2011/1007/oj'
const law = (name: string, plain: string, href: string | null): LawReference => Object.freeze({ law: name, plain, href })

/** What each check is about, and the law behind it. */
export const CHECK_WORDS: Readonly<Record<CheckKey, { readonly title: string; readonly law: readonly LawReference[] }>> = Object.freeze({
  composition: {
    title: 'Fibre composition from the BOM',
    law: [law('Reg. (EU) 1007/2011 arts. 9, 11', "A textile product's label gives the fibres of each part in percent by weight, with the names of Annex I.", REG_1007)],
  },
  fibreNames: {
    title: 'Official fibre names',
    law: [law('Reg. (EU) 1007/2011 arts. 5, 16(3)', 'Only the fibre names of Annex I may be used, in the language of each market the product is sold in.', REG_1007)],
  },
  animalOrigin: {
    title: 'Animal-origin phrase',
    law: [law('Reg. (EU) 1007/2011 art. 12', 'A textile product with non-textile parts of animal origin (leather, fur) says "Contains non-textile parts of animal origin".', REG_1007)],
  },
  textileShare: {
    title: '80 % textile threshold',
    law: [law('Reg. (EU) 1007/2011 art. 2(2)(a)', 'A product with at least 80 % textile fibres by weight is treated as a textile product, and its label gives its fibres.', REG_1007)],
  },
  careLabel: {
    title: 'Care label',
    law: [law('ISO 3758:2023', 'Care symbols in the order washing, bleaching, drying, ironing, professional care, with their words. Whether a care label is mandatory in Italy is not verified.', null)],
  },
  madeInItaly: {
    title: 'Made in Italy',
    law: [
      law('Reg. (EU) 952/2013 art. 60(2)', 'Goods made in more than one country take the origin of their last substantial processing: for a garment, its complete making-up after cutting.', 'https://eur-lex.europa.eu/eli/reg/2013/952/oj'),
      law('D.L. 135/2009 art. 16 (L. 166/2009)', '"100% Made in Italy" and the like only for goods designed, planned, made and packed entirely in Italy.', 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legge:2009-09-25;135'),
      law('L. 350/2003 art. 4(49)', 'A false or misleading origin on goods is an offence.', 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2003-12-24;350'),
    ],
  },
  leatherNaming: {
    title: 'Leather names (Italy)',
    law: [law('D.Lgs. 68/2020', '"Cuoio", "pelle", "pelliccia" and the words made from them are kept for materials from an animal\'s skin; "pieno fiore" for leather whose grain is whole.', 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2020-06-09;68')],
  },
})

/** Why each switch is off by default, and what it does when on. */
export const SWITCH_WORDS: Readonly<Record<SwitchableRule, { readonly on: string; readonly off: string }>> = Object.freeze({
  textileShare: {
    on: 'Weighs the textiles of each style against the garment and says whether textile labelling applies (80 % or more).',
    off: 'Switched off: the Owner has not yet said whether any style is 80 % textile or more by weight (OWNER-QUESTIONS Q10). Switch it on when a style or a market needs it.',
  },
  careLabel: {
    on: 'Asks each label for the five groups of care symbols and their words in every language it prints.',
    off: 'Switched off: whether a care label is mandatory in Italy is not verified. Switch it on when a market or a brand asks for one; the care words are offered either way.',
  },
  madeInItaly: {
    on: 'Reads where each routing step is done and says whether "Made in Italy" and "100% Made in Italy" are allowed.',
    off: 'Switched off: the Owner has not yet said whether any step is done outside Italy or whether an origin is claimed (OWNER-QUESTIONS Q22, Q23). Switch it on before a label or a catalogue says "Made in Italy".',
  },
})

export type Outcome = 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'OFF'

export interface CheckResult {
  readonly key: CheckKey
  readonly title: string
  readonly on: boolean
  readonly switchable: boolean
  readonly outcome: Outcome
  /** The check's sentence (OFF: why it is off). */
  readonly words: string
  readonly law: readonly LawReference[]
  readonly findings: readonly Finding[]
}

// ---- the facts ---------------------------------------------------------------------------------------------------------------

export interface LabelFacts {
  readonly code: string
  readonly revision: number
  readonly status: string
  readonly languages: readonly string[]
  readonly composition: readonly CompositionPart[]
  readonly animalOriginPhrase: boolean
  readonly care: readonly CareEntry[]
  readonly layout: Pick<LabelLayout, 'texts'>
}

/** The lines of one colourway (null: a style without colourways), in the size asked. */
export interface ColourwayLines {
  readonly colourway: string | null
  readonly lines: readonly LineFacts[]
}

export interface TextileFacts {
  readonly style: LeatherStyle & { readonly originCountry: string | null; readonly netMassKg: string | null }
  readonly revision: number
  readonly label: LabelFacts | null
  readonly colourways: readonly ColourwayLines[]
  /** Every material of the revision's BOM, with its names (leather naming). */
  readonly materials: readonly LeatherMaterial[]
  readonly steps: readonly StepFacts[]
  readonly plants: readonly PlaceFacts[]
}

/** Colourways that give the same answer, together (most styles: one group with every colourway). */
export interface Grouped<T> {
  readonly colourways: readonly string[]
  readonly value: T
}

export interface TextileReport {
  readonly composition: readonly Grouped<{ readonly parts: readonly ComputedPart[]; readonly findings: readonly Finding[] }>[]
  readonly textileShare: readonly Grouped<TextileShare>[]
  readonly animalOrigin: {
    readonly needed: boolean
    readonly materials: readonly { readonly code: string; readonly name: string }[]
    readonly phrases: readonly { readonly language: string; readonly text: string | null; readonly typed: boolean }[]
  }
  readonly care: { readonly entries: readonly CareWordsOfEntry[]; readonly missingGroups: readonly CareGroup[] }
  readonly origin: OriginCheck
  readonly results: readonly CheckResult[]
}

function grouped<T>(entries: readonly { colourway: string | null; value: T }[]): Grouped<T>[] {
  const groups: { key: string; colourways: string[]; value: T }[] = []
  for (const entry of entries) {
    const key = JSON.stringify(entry.value)
    const group = groups.find((candidate) => candidate.key === key)
    if (group) {
      if (entry.colourway !== null) group.colourways.push(entry.colourway)
    } else groups.push({ key, colourways: entry.colourway === null ? [] : [entry.colourway], value: entry.value })
  }
  return groups.map(({ colourways, value }) => ({ colourways, value }))
}

const outcomeOf = (findings: readonly Finding[]): Outcome => (findings.some((finding) => finding.severity === 'FAIL') ? 'FAIL' : findings.some((finding) => finding.severity === 'WARN') ? 'WARN' : 'PASS')

const inColourways = (group: Grouped<unknown>, groups: number): string => (groups > 1 && group.colourways.length > 0 ? ` (colourway ${group.colourways.join(', ')})` : '')

const tagged = (findings: readonly Finding[], group: Grouped<unknown>, groups: number): Finding[] =>
  groups > 1 && group.colourways.length > 0 ? findings.map((finding) => ({ ...finding, message: `${group.colourways.join(', ')}: ${finding.message}` })) : [...findings]

const noLabel = (revision: number) => `Revision ${revision} names no label yet`

/** Every check of a style revision, with what each computed. */
export function textileChecks(facts: TextileFacts, switches: Switches): TextileReport {
  const results: CheckResult[] = []
  const result = (key: CheckKey, outcome: Outcome, words: string, findings: readonly Finding[], on = true): void => {
    const switchable = isSwitchableRule(key)
    results.push({ key, title: CHECK_WORDS[key].title, on, switchable, outcome: on ? outcome : 'OFF', words: on ? words : SWITCH_WORDS[key as SwitchableRule].off, law: CHECK_WORDS[key].law, findings: on ? findings : [] })
  }
  const label = facts.label
  const sets = facts.colourways.length > 0 ? facts.colourways : [{ colourway: null, lines: [] }]

  // PRD-338: the composition, per group of colourways.
  const computed = sets.map((set) => ({ colourway: set.colourway, value: computeComposition(set.lines) }))
  const composition = grouped(computed.map((entry) => ({ colourway: entry.colourway, value: { parts: entry.value.parts, findings: entry.value.findings } })))
  {
    const findings: Finding[] = []
    let unknown = false
    for (const group of composition) {
      findings.push(...tagged(group.value.findings, group, composition.length))
      if (group.value.parts.some((part) => part.fibres === null)) unknown = true
      if (label) findings.push(...tagged(compareWithLabel(group.value.parts, label.composition), group, composition.length))
    }
    const anyPart = composition.some((group) => group.value.parts.length > 0)
    const words = composition
      .map((group) => group.value.parts.filter((part) => part.fibres !== null).map((part) => partText(part.part, part.fibres!)).join('; ') + inColourways(group, composition.length))
      .filter((text) => text.trim() !== '')
      .join(' · ')
    if (!anyPart) result('composition', label && label.composition.length > 0 ? 'WARN' : 'NOT_APPLICABLE', 'The BOM has no textile part.', label ? compareWithLabel([], label.composition) : [])
    else if (!label) result('composition', 'UNKNOWN', `${noLabel(facts.revision)}: the BOM gives ${words || 'a composition that cannot be computed yet'}.`, findings)
    else {
      const outcome = outcomeOf(findings)
      result('composition', unknown && outcome !== 'FAIL' ? 'UNKNOWN' : outcome, outcome === 'PASS' && !unknown ? `The label's composition matches the BOM: ${words}.` : `The BOM gives ${words || 'a composition that cannot be computed yet'}.`, findings)
    }
  }

  // PRD-338: the fibre names.
  {
    const findings: Finding[] = []
    const languages = label ? label.languages : []
    const seen = new Set<string>()
    const check = (typed: string, path: string): void => {
      const reading = readFibre(typed)
      if (reading.kind === 'UNKNOWN') findings.push({ path, severity: 'WARN', message: `"${typed}" is not a fibre name of this list of Reg. (EU) 1007/2011 Annex I: check it (art. 5: only the Annex's names).` })
      else if (reading.kind === 'NOT_TEXTILE') findings.push({ path, severity: 'WARN', message: `"${typed}" is no textile fibre: leather and fur are said by the animal-origin phrase (art. 12), not in the fibres.` })
      else {
        if (reading.brand) findings.push({ path, severity: 'WARN', message: `"${typed}" is a trade mark: the label prints the official name "${reading.fibre.key}" (art. 5); the mark may follow it.` })
        for (const language of languages) {
          const key = `${reading.fibre.key}|${language}`
          if (officialName(reading.fibre, language) === null && !seen.has(key)) {
            seen.add(key)
            findings.push({ path: `languages/${language}`, severity: 'WARN', message: `The label prints ${language}, and the official ${language} name of ${reading.fibre.key} is not on file here: check the label's wording in ${language} (art. 16(3)).` })
          }
        }
      }
    }
    const materials = new Map<string, LineFacts['material']>()
    for (const set of sets) for (const line of set.lines) if (line.qty !== null && roleOf(line.material) !== 'NOT_IN_GARMENT') materials.set(line.material.id, line.material)
    for (const material of materials.values()) fibresOf(material).forEach((share, index) => check(share.fibre, `materials/${material.code}/composition/${index}/fibre`))
    label?.composition.forEach((part, index) => part.fibres.forEach((share, fibreIndex) => check(share.fibre, `label/composition/${index}/fibres/${fibreIndex}/fibre`)))
    const any = materials.size > 0 && [...materials.values()].some((material) => fibresOf(material).length > 0)
    if (!any && !(label && label.composition.length > 0)) result('fibreNames', 'NOT_APPLICABLE', 'No fibre is typed on the BOM\'s materials or the label.', [])
    else result('fibreNames', outcomeOf(findings), outcomeOf(findings) === 'PASS' ? 'Every fibre is named as Annex I names it.' : 'Some fibre names need a look.', findings)
  }

  // PRD-340: the 80 % threshold (switch).
  const textileShare = grouped(sets.map((set) => ({ colourway: set.colourway, value: textileShareOf(set.lines, facts.style.netMassKg) })))
  const notTextile = textileShare.every((group) => group.value.applies === false)
  {
    const findings: Finding[] = []
    for (const group of textileShare) findings.push(...tagged(group.value.findings, group, textileShare.length))
    const unknown = textileShare.some((group) => group.value.applies === null)
    const words = textileShare.map((group) => (group.value.pct === null ? `not known${inColourways(group, textileShare.length)}` : `${group.value.pct} % by weight${inColourways(group, textileShare.length)}`)).join(' · ')
    const applies = textileShare.some((group) => group.value.applies === true)
    if (unknown) result('textileShare', 'UNKNOWN', `Textile share ${words}: weights are missing.`, findings, switches.textileShare)
    else if (applies) {
      if (label && label.composition.length === 0) findings.push({ path: 'label/composition', severity: 'FAIL', message: 'Textile labelling applies, and the label gives no fibre composition.' })
      result('textileShare', outcomeOf(findings), `Textile share ${words}: textile labelling applies.`, findings, switches.textileShare)
    } else result('textileShare', outcomeOf(findings), `Textile share ${words}: not a textile product under art. 2(2)(a); its label need not give the fibres.`, findings, switches.textileShare)
  }

  // PRD-339: the animal-origin phrase.
  const animalMaterials = [...new Map(computed.flatMap((entry) => entry.value.animalParts).map((part) => [part.code, part])).values()]
  const needed = animalMaterials.length > 0
  const phrases = label ? label.languages.map((language) => {
    const text = animalOriginText(label.layout, language)
    return { language, text: text?.text ?? null, typed: text?.typed ?? false }
  }) : []
  {
    const names = animalMaterials.map((material) => material.code).join(', ')
    if (switches.textileShare && notTextile) {
      result('animalOrigin', 'NOT_APPLICABLE', needed ? `Not a textile product (art. 2(2)(a)): the phrase is not required for ${names}; it may stay.` : 'Not a textile product, and no non-textile part of animal origin.', [])
    } else if (!label) {
      result('animalOrigin', 'UNKNOWN', needed ? `${noLabel(facts.revision)}: its label must say "Contains non-textile parts of animal origin" (the BOM has ${names}).` : `${noLabel(facts.revision)}: the BOM has no non-textile part of animal origin.`, [])
    } else if (needed && !label.animalOriginPhrase) {
      result('animalOrigin', 'FAIL', `The BOM has ${names}: the label must say "Contains non-textile parts of animal origin".`, [{ path: 'label/animalOriginPhrase', severity: 'FAIL', message: `Label ${label.code} r${label.revision} leaves the animal-origin phrase out, and the BOM has ${names} (Reg. (EU) 1007/2011 art. 12).` }])
    } else if (!needed && label.animalOriginPhrase) {
      result('animalOrigin', 'WARN', 'The label carries the animal-origin phrase, and no material of the BOM is a non-textile part of animal origin.', [{ path: 'label/animalOriginPhrase', severity: 'WARN', message: `Label ${label.code} r${label.revision} says "Contains non-textile parts of animal origin", and the BOM has no leather or fur: check the BOM or remove the phrase.` }])
    } else {
      const missing = phrases.filter((phrase) => phrase.text === null)
      const findings: Finding[] = needed ? missing.map((phrase) => ({ path: `label/layout/texts/animalOrigin/${phrase.language}`, severity: 'FAIL' as const, message: `Type the animal-origin phrase in ${phrase.language}: no official text is on file for it.` })) : []
      result('animalOrigin', outcomeOf(findings), needed ? `Added because the BOM has ${names}: the label carries the phrase.` : 'No non-textile part of animal origin, and the label carries no phrase.', findings)
    }
  }

  // PRD-342: the care label (switch); its words are offered whatever the switch.
  const careEntries = label ? careWordsOf(label.care, label.languages) : []
  const missingGroups = label ? missingCareGroups(label.care) : []
  {
    const findings: Finding[] = []
    if (label) {
      if (label.care.length === 0) findings.push({ path: 'label/care', severity: 'FAIL', message: `Label ${label.code} r${label.revision} shows no care symbol.` })
      else if (missingGroups.length > 0) findings.push({ path: 'label/care', severity: 'WARN', message: `The label shows no symbol for ${missingGroups.map((group) => CARE_GROUP_WORDS[group]).join(', ')} (ISO 3758: washing, bleaching, drying, ironing, professional care).` })
      careEntries.forEach((entry, index) => {
        for (const words of entry.words) if (words.text === null) findings.push({ path: `label/care/${index}/text/${words.language}`, severity: 'WARN', message: `The care symbol ${entry.symbol} has no ${words.language} words: type them on the label.` })
      })
    }
    if (!label) result('careLabel', 'UNKNOWN', `${noLabel(facts.revision)}: its care symbols cannot be checked.`, [], switches.careLabel)
    else result('careLabel', outcomeOf(findings), outcomeOf(findings) === 'PASS' ? 'The label shows every group of care symbols, with words in each language it prints.' : 'The care label needs a look.', findings, switches.careLabel)
  }

  // PRD-344: Made in Italy (switch).
  const origin = originCheck(facts.steps, facts.plants, facts.style.originCountry)
  {
    const words =
      origin.madeInItaly === 'ALLOWED'
        ? `"Made in Italy" allowed: every step after cutting is done in Italy.${origin.fullMadeInItaly === 'ALLOWED' ? ' "100% Made in Italy" allowed as far as the routing goes (design and planning are not in the records).' : ''}`
        : origin.madeInItaly === 'NOT_ALLOWED'
          ? '"Made in Italy" not allowed: the garment is made up outside Italy.'
          : '"Made in Italy" cannot be decided from the routing yet.'
    const outcome = outcomeOf(origin.findings)
    result('madeInItaly', origin.madeInItaly === 'UNKNOWN' && outcome !== 'FAIL' ? 'UNKNOWN' : outcome, words, origin.findings, switches.madeInItaly)
  }

  // PRD-345: leather names.
  {
    const findings = leatherNaming(facts.style, facts.materials)
    result('leatherNaming', outcomeOf(findings), findings.length === 0 ? 'Leather words are used only for leather from an animal\'s skin.' : 'Some names use leather words wrongly.', findings)
  }

  const order = (key: CheckKey) => CHECK_KEYS.indexOf(key)
  return {
    composition,
    textileShare,
    animalOrigin: { needed, materials: animalMaterials, phrases },
    care: { entries: careEntries, missingGroups },
    origin,
    results: results.sort((a, b) => order(a.key) - order(b.key)),
  }
}
