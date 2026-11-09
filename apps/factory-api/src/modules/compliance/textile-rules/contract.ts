import { z } from 'zod'
import { CARE_GROUPS } from '@nexus/factory-domain/compliance/textile-rules/care'
import { COMPONENTS } from '@nexus/factory-domain/compliance/textile-rules/composition'
import { CHECK_KEYS, SWITCH_REASON_MAX, SWITCH_REASON_MIN, SWITCHABLE_RULES } from '@nexus/factory-domain/compliance/textile-rules/rules'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The textile, leather and origin checks' contracts (B-W2b-208; PRD-338 … PRD-345). Codes, names, percents, grams and
 * countries; no price, no cost, no person. Every check carries its legal reference (LawRef: law, plain words, link).
 */

const finding = output({ path: z.string(), message: z.string(), severity: z.enum(['FAIL', 'WARN']) })
const lawRef = output({ law: z.string(), plain: z.string(), href: z.string().nullable() })
const words = output({ en: z.string(), it: z.string() })
const verdict = z.enum(['ALLOWED', 'NOT_ALLOWED', 'UNKNOWN'])

const resultView = output({
  key: z.enum(CHECK_KEYS),
  title: z.string(),
  on: z.boolean(),
  switchable: z.boolean(),
  outcome: z.enum(['PASS', 'FAIL', 'WARN', 'UNKNOWN', 'NOT_APPLICABLE', 'OFF']),
  words: z.string(),
  law: z.array(lawRef),
  findings: z.array(finding),
})

const partView = output({
  component: z.enum(COMPONENTS),
  part: z.string(),
  words,
  fibres: z.array(output({ fibre: z.string(), annex: z.boolean(), percent: z.string(), names: z.record(z.string(), z.string()) })).nullable(),
  basis: z.enum(['ONE_COMPOSITION', 'BY_WEIGHT']).nullable(),
  materials: z.array(z.string()),
})

const placeView = output({ code: z.string(), name: z.string(), country: z.string().nullable() })

export const checksView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), originCountry: z.string().nullable(), netMassKg: z.string().nullable() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.string() }),
  size: z.string().nullable(),
  site: output({ id: id(), code: z.string() }).nullable(),
  label: output({ id: id(), code: z.string(), revision: z.number().int(), status: z.string(), languages: z.array(z.string()) }).nullable(),
  switches: z.array(output({ rule: z.enum(SWITCHABLE_RULES), on: z.boolean() })),
  /** Colourways that give the same parts, together (one group: every colourway). */
  composition: z.array(output({ colourways: z.array(z.string()), parts: z.array(partView), findings: z.array(finding) })),
  textileShare: z.array(
    output({
      colourways: z.array(z.string()),
      pct: z.string().nullable(),
      applies: z.boolean().nullable(),
      basis: z.enum(['NET_MASS', 'BOM']).nullable(),
      textileGrams: z.string().nullable(),
      garmentGrams: z.string().nullable(),
      missing: z.array(output({ seq: z.number().int(), code: z.string(), why: z.string() })),
      findings: z.array(finding),
    }),
  ),
  animalOrigin: output({
    needed: z.boolean(),
    materials: z.array(output({ code: z.string(), name: z.string() })),
    phrases: z.array(output({ language: z.string(), text: z.string().nullable(), typed: z.boolean() })),
  }),
  care: output({
    entries: z.array(output({ symbol: z.string(), group: z.enum(CARE_GROUPS).nullable(), words: z.array(output({ language: z.string(), text: z.string().nullable(), typed: z.boolean() })) })),
    missingGroups: z.array(z.enum(CARE_GROUPS)),
  }),
  origin: output({
    madeInItaly: verdict,
    fullMadeInItaly: verdict,
    styleOrigin: z.string().nullable(),
    steps: z.array(
      output({
        seq: z.number().int(),
        code: z.string(),
        name: z.string(),
        workCentreKind: z.string(),
        makesUp: z.boolean(),
        where: z.enum(['IN_HOUSE', 'WORKSHOP']),
        places: z.array(placeView),
        country: z.string().nullable(),
      }),
    ),
    findings: z.array(finding),
  }),
  /** The Rule checks, in order: composition, fibreNames, animalOrigin, textileShare, careLabel, madeInItaly, leatherNaming. */
  results: z.array(resultView),
  asOf: instant(),
})

export const styleChecksContract = defineContract({
  params: input({ styleId: z.string().min(1).max(64) }),
  querystring: input({ revisionId: id().optional(), size: z.string().trim().min(1).max(16).optional(), siteId: id().optional() }),
  response: { 200: output({ checks: checksView }) },
})

const switchView = output({
  rule: z.enum(SWITCHABLE_RULES),
  title: z.string(),
  on: z.boolean(),
  words: output({ on: z.string(), off: z.string() }),
  law: z.array(lawRef),
  changedAt: instant().nullable(),
  reason: z.string().nullable(),
})

export const switchesContract = defineContract({ response: { 200: output({ switches: z.array(switchView), asOf: instant() }) } })

export const switchContract = defineContract({
  params: input({ rule: z.string().min(1).max(40) }),
  body: input({ on: z.boolean(), reason: z.string().trim().min(SWITCH_REASON_MIN).max(SWITCH_REASON_MAX) }),
  response: { 200: output({ switch: switchView }) },
})

export const vocabularyContract = defineContract({
  response: {
    200: output({
      vocabulary: output({
        fibres: z.array(output({ key: z.string(), names: z.record(z.string(), z.string()), aliases: z.array(z.string()), brands: z.array(z.string()) })),
        care: z.array(output({ symbol: z.string(), group: z.enum(CARE_GROUPS), words: z.record(z.string(), z.string()) })),
        animalOrigin: z.array(output({ language: z.string(), text: z.string() })),
        components: z.array(output({ component: z.enum(COMPONENTS), words })),
        weight: z.string(),
      }),
    }),
  },
})

/** The customer's catalogue: a style's fibres before buying (PRD-341; Reg. (EU) 1007/2011 art. 16(1)). No material code. */
export const catalogueCompositionContract = defineContract({
  params: input({ styleId: z.string().min(1).max(64) }),
  querystring: input({ language: z.string().trim().toLowerCase().min(2).max(8).optional() }),
  response: {
    200: output({
      composition: output({
        styleId: id(),
        revision: z.number().int().nullable(),
        /** LABEL: the active label of the released revision; BOM: computed from it; null: not known yet. */
        source: z.enum(['LABEL', 'BOM']).nullable(),
        language: z.string(),
        groups: z.array(output({ colourways: z.array(z.string()), parts: z.array(output({ part: z.string(), fibres: z.array(output({ fibre: z.string(), percent: z.string() })) })) })),
        animalOrigin: z.string().nullable(),
        words: z.string(),
      }),
    }),
  },
})
