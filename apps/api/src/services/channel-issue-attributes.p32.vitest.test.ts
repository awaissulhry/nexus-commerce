/**
 * P3.2 — the attribute extractor, checked against the REAL stored Amazon rejections.
 *
 * The messages below are verbatim from `AmazonFlatFileFeedJob.perSkuResults` in the
 * development database (25 feed jobs, 371 per-SKU rows, 140 issues on 48 SKUs, all
 * marketplace IT). They are copied in rather than read from the database so the test
 * runs anywhere — but they are REAL, not SHAPE: every one of the 12 distinct messages
 * Amazon actually sent is here, with its real code.
 *
 * The fingerprint test at the bottom is the one that matters. It is the check that
 * would have caught the collapse before it reached the table.
 */
import { describe, it, expect } from 'vitest'
import { attributeNamesFromMessage, resolveIssueAttributes } from './channel-issue-attributes.js'

/** Every distinct (code, message) pair in the stored feed reports, verbatim. */
const REAL_ISSUES: Array<{ code: string; message: string; expect: string[] }> = [
  {
    code: '90220',
    message: '“outer” è obbligatorio ma mancante.',
    expect: ['outer'],
  },
  {
    code: '90220',
    message: '“externally_assigned_product_identifier” è obbligatorio ma mancante.',
    expect: ['externally_assigned_product_identifier'],
  },
  {
    code: '90220',
    message: '“merchant_suggested_asin” è obbligatorio ma mancante.',
    expect: ['merchant_suggested_asin'],
  },
  {
    code: '90220',
    message: '“inner” è obbligatorio ma mancante.',
    expect: ['inner'],
  },
  {
    code: '90220',
    message: '“closure” è obbligatorio ma mancante.',
    expect: ['closure'],
  },
  {
    code: '90220',
    message: '“rise” è obbligatorio ma mancante.',
    expect: ['rise'],
  },
  {
    code: '99022',
    message: 'Il campo “name” per l\'attributo “variation_theme” non ha valori sufficienti. Il minimo necessario è di “1” valore/i.',
    expect: ['variation_theme'],
  },
  {
    code: '99022',
    message: 'In base ai dati in “[bottoms_size#?.size_system, bottoms_size#?.size_class]”, il campo “"size"” per l’attributo “bottoms_size” non contiene abbastanza valori. Sono richiesti almeno “1” valori. Fornisci un valore valido.',
    expect: ['bottoms_size', 'size_system', 'size_class'],
  },
  {
    code: '99022',
    message: 'In base ai dati in “[bottoms_size#?.size_system, age_range_description.value, bottoms_size#?.size_class]”, il campo “"height_type"” per l’attributo “bottoms_size” non contiene abbastanza valori. Sono richiesti almeno “1” valori. Fornisci un valore valido.',
    expect: ['bottoms_size', 'size_system', 'age_range_description', 'size_class', 'height_type'],
  },
  {
    code: '99022',
    message: 'In base ai dati in “[bottoms_size#?.size_system, age_range_description.value, bottoms_size#?.size_class]”, il campo “"body_type"” per l’attributo “bottoms_size” non contiene abbastanza valori. Sono richiesti almeno “1” valori. Fornisci un valore valido.',
    expect: ['bottoms_size', 'size_system', 'age_range_description', 'size_class', 'body_type'],
  },
  {
    code: '90244',
    message: 'Non possiamo accettare SizeName-ColorName che hai inserito per variation_theme. Per risolvere il problema, seleziona un valore approvato dalla lista per la tua categoria di prodotti e ripeti l’invio.',
    expect: ['variation_theme'],
  },
  {
    code: '90244',
    message: 'Non possiamo accettare TEAM_NAME/ATHLETE/COLOR/SIZE che hai inserito per variation_theme. Per risolvere il problema, seleziona un valore approvato dalla lista per la tua categoria di prodotti e ripeti l’invio.',
    expect: ['variation_theme'],
  },
]

/**
 * The five 90220 issues Amazon returned for ONE real SKU,
 * GALE-JACKET-BLACK-MEN-XXS-REAL. Before P3.2 all five carried `attributeNames: []`,
 * so all five fingerprinted as `90220::` and four were lost.
 */
const ONE_REAL_SKU_90220 = [
  '“outer” è obbligatorio ma mancante.',
  '“externally_assigned_product_identifier” è obbligatorio ma mancante.',
  '“merchant_suggested_asin” è obbligatorio ma mancante.',
  '“inner” è obbligatorio ma mancante.',
  '“closure” è obbligatorio ma mancante.',
]

describe('P3.2 attributeNamesFromMessage — real Amazon rejections (Italian)', () => {
  for (const c of REAL_ISSUES) {
    it(`${c.code}: ${c.message.slice(0, 48)}…`, () => {
      expect(attributeNamesFromMessage(c.message)).toEqual(c.expect)
    })
  }

  it('names an attribute for every one of the 12 real messages', () => {
    const empty = REAL_ISSUES.filter((c) => attributeNamesFromMessage(c.message).length === 0)
    expect(empty.map((c) => c.message)).toEqual([])
  })
})

describe('P3.2 — the fingerprint collapse this was built to stop', () => {
  const fingerprint = (code: string, attrs: string[]): string =>
    `${code}::${[...attrs].sort().join(',')}`

  it('gives one real SKU five distinct fingerprints, not one', () => {
    const fps = new Set(
      ONE_REAL_SKU_90220.map((m) => fingerprint('90220', attributeNamesFromMessage(m))),
    )
    expect(fps.size).toBe(5)
  })

  it('is what the OLD behaviour lost: empty attributes collapse all five into one', () => {
    const old = new Set(ONE_REAL_SKU_90220.map(() => fingerprint('90220', [])))
    expect(old.size).toBe(1)
  })

  it('keeps the three 99022 bottoms_size variants apart', () => {
    const variants = REAL_ISSUES.filter((c) => c.code === '99022' && c.message.startsWith('In base'))
    expect(variants).toHaveLength(3)
    const fps = new Set(variants.map((c) => fingerprint(c.code, attributeNamesFromMessage(c.message))))
    expect(fps.size).toBe(3)
  })
})

describe('P3.2 resolveIssueAttributes', () => {
  it('prefers what the channel named itself', () => {
    expect(resolveIssueAttributes(['item_name'], '“closure” è obbligatorio ma mancante.'))
      .toEqual(['item_name'])
  })

  it('falls back on Amazon’s real `attributeNames: []` — an isArray guard would not', () => {
    expect(Array.isArray([])).toBe(true) // the guard that suppressed the fallback
    expect(resolveIssueAttributes([], '“closure” è obbligatorio ma mancante.')).toEqual(['closure'])
  })

  it('falls back when the field is absent entirely', () => {
    expect(resolveIssueAttributes(undefined, 'Missing required attribute - item_name'))
      .toEqual(['item_name'])
  })

  it('returns [] when the channel names nothing and the message names nothing', () => {
    expect(resolveIssueAttributes([], 'Si è verificato un errore. Riprova più tardi.')).toEqual([])
  })
})

describe('P3.2 — English messages still work (the old extractFields cases)', () => {
  it.each([
    ['Missing required attribute - item_name', ['item_name']],
    ['Invalid value for attribute: bullet_point_1', ['bullet_point_1']],
    ["Attribute 'brand_name' cannot be updated", ['brand_name']],
  ])('%s', (message, expected) => {
    expect(attributeNamesFromMessage(message)).toEqual(expected)
  })
})

describe('P3.2 — guards', () => {
  it('does not treat an Italian apostrophe as an opening quote', () => {
    // `l'attributo` … `l’invio`: pairing either apostrophe would swallow the sentence
    // and return a 60-character "attribute".
    const attrs = attributeNamesFromMessage("Il campo per l'attributo non è valido e ripeti l’invio.")
    expect(attrs).toEqual([])
  })

  it('ignores CamelCase and SCREAMING_CASE values Amazon quotes back at us', () => {
    expect(attributeNamesFromMessage('Non possiamo accettare SizeName-ColorName che hai inserito per variation_theme.'))
      .toEqual(['variation_theme'])
  })

  it('caps a runaway match', () => {
    const many = Array.from({ length: 40 }, (_, i) => `attr_${i}`).join(' ')
    expect(attributeNamesFromMessage(many)).toHaveLength(12)
  })

  it('is empty for empty input', () => {
    expect(attributeNamesFromMessage('')).toEqual([])
    expect(attributeNamesFromMessage(null)).toEqual([])
    expect(attributeNamesFromMessage(undefined)).toEqual([])
  })
})
