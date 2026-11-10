import { LABEL_RULE_WORDS } from '@nexus/factory-domain/compliance/label-rules/rules'
import { CHECK_WORDS } from '@nexus/factory-domain/compliance/textile-rules/rules'
import { ready } from '../../../quality/_shared/model'
import { GLOVES_R1, JACKET_R2, ROLES, ROWS, TSHIRT_R1 } from '../demo'
import type { LabelTemplate } from '../api'
import type { RecordDepth } from '../view-model'
import type { Artwork, LabelChecks, Market, MarketRef, Phrase, PhraseText, RuleCheck, TextileChecks } from './api'
import { depthCan, gapsOf, type ListDepth } from './model'

/**
 * Design-only made-up data for Labels & marking in depth (B-W2b-270): an invented factory's markets (IT, DE, FR, CH), its
 * phrase library (a removable-protectors warning, the animal-origin phrase, two care phrases), the touring jacket's marking
 * checks and textile checks, its proofs (v1 retired, v2 approved, v3 waiting for a second person) and the work orders that
 * print them. Names are made up ("Giulia Demo", "Marco Demo", "Officina Demo S.r.l."); the laws are the domain's own
 * references. Nothing here is business data.
 */

const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
export const ME = uid('5401', 1)
const GIULIA = { id: uid('5401', 2), name: 'Giulia Demo' }
const MARCO = { id: uid('5401', 3), name: 'Marco Demo' }

export const DEPTH_CAN = { owner: depthCan([...ROLES.owner, 'files.upload']), quality: depthCan([...ROLES.quality, 'files.upload']), developer: depthCan(ROLES.developer) }

// ---- markets ----
const market = (code: string, name: string, labelLanguages: string[], switchedOn = true): Market => ({ code, name, companyId: null, labelLanguages, switchedOn, status: 'ACTIVE' })
export const MARKETS: Market[] = [market('IT', 'Italia', ['it']), market('DE', 'Germania', ['de']), market('FR', 'Francia', ['fr']), market('CH', 'Svizzera', ['de', 'fr', 'it']), market('UK', 'Regno Unito', ['en'], false)]
const ref = (code: string): MarketRef => {
  const row = MARKETS.find((entry) => entry.code === code)!
  return { code: row.code, name: row.name, switchedOn: row.switchedOn, labelLanguages: row.labelLanguages, markings: code === 'UK' ? ['UKCA'] : ['CE'], gpsrContactNeeded: false }
}

// ---- the phrase texts the list reads (approved words per key and language) ----
export const TEXTS: PhraseText[] = [
  { key: 'warning.protectors-removable', language: 'it', text: 'Le protezioni sono rimovibili: la classe vale solo con le protezioni inserite.', revision: 1 },
  { key: 'warning.protectors-removable', language: 'de', text: null, revision: 1 },
  { key: 'warning.protectors-removable', language: 'fr', text: null, revision: 1 },
]

/** The list's W2b reads: a proof waits on two labels; the gaps from the markets and texts above. */
export function listDepth(rows: readonly LabelTemplate[] = ROWS, extra: Partial<ListDepth> = {}): ListDepth {
  return { waiting: new Set([JACKET_R2.id, GLOVES_R1.id]), waitingFailed: false, gaps: gapsOf(rows, MARKETS, TEXTS), gapsFailed: false, ...extra }
}

// ---- the jacket's marking checks (B-W2b-253) ----
const check = (key: RuleCheck['key'], outcome: RuleCheck['outcome'], words: string, findings: RuleCheck['findings'] = []): RuleCheck => ({
  key,
  gateKey: key === 'gpsr' ? 'gpsr.contact' : `label.${key}`,
  title: LABEL_RULE_WORDS[key].title,
  outcome,
  blocks: outcome === 'FAIL' || outcome === 'WAITING' || outcome === 'UNKNOWN',
  words,
  law: [...LABEL_RULE_WORDS[key].law],
  findings,
})

const jacketChecks = (code: string, languages: string[]): RuleCheck[] => {
  const missing = languages.filter((language) => language !== 'it')
  return [
    check('ceMarking', 'PASS', 'The CE marking prints 6 mm high; category II: no notified-body number after it.'),
    missing.length > 0
      ? check(
          'classWarnings',
          'FAIL',
          `The warning that the impact protectors can be taken out has no approved text in ${missing.join(', ')}.`,
          missing.map((language) => ({ path: `phrases/warning.protectors-removable/${language}`, message: `No approved ${language} text of warning.protectors-removable.`, severity: 'FAIL' as const })),
        )
      : check('classWarnings', 'WAITING', 'The warning texts are ready and wait for the PPE consultant (GATE-PPE-TEXTS).', [{ path: 'gate/GATE-PPE-TEXTS', message: 'Generated PPE texts stay drafts until a PPE consultant says yes.', severity: 'WAITING' }]),
    check('gloveMarking', 'NOT_APPLICABLE', `${code} is not a glove.`),
    check('gpsr', 'NOT_APPLICABLE', 'A PPE garment: the GPSR contact is not asked for this market (Owner Q37).'),
    check('qrCode', 'WARN', 'The QR names a local web address: a printed QR lasts ten years.', [{ path: 'qr/origin', message: 'The web origin is plain http on a local host.', severity: 'WARN' }]),
  ]
}

export function demoChecks(label: LabelTemplate = JACKET_R2, extra: Partial<LabelChecks> = {}): LabelChecks {
  const markets = ['IT', 'DE', 'FR', 'CH'].map(ref)
  return {
    label: { id: label.id, code: label.code, revision: label.revision, status: label.status, kind: label.kind, qrTarget: label.qrTarget, gpsrContact: label.gpsrContact, languages: label.languages, version: label.version },
    style: { id: label.style?.id ?? uid('5301', 1), code: label.style?.code ?? 'DEMO-JKT-01', name: label.style?.name ?? 'Giacca Touring Demo', ppeCategory: label.style?.ppeCategory ?? 'CATEGORY_II', ppeStandard: label.style?.ppeStandard ?? null, ppeClass: label.style?.ppeClass ?? null, productType: 'JACKET', soldUnderOurName: true },
    revisionId: uid('5320', 2),
    workOrder: null,
    markets: markets.map((entry) => {
      const checks = jacketChecks(label.style?.code ?? label.code, entry.labelLanguages)
      return { market: entry, sender: { who: 'COMPANY' as const, name: 'Officina Demo S.r.l.', address: 'Via dell’Esempio 12, 00000 Borgo Demo (XX)', contact: 'assistenza@example.com', operatorId: uid('5402', 1) }, blocks: checks.some((item) => item.blocks), checks }
    }),
    marking: {
      qr: label.qrTarget === 'NONE' ? null : { target: label.qrTarget, kind: label.qrTarget === 'BATCH_DOC' ? 'BATCH' : 'STYLE', address: null, printed: null, recordType: null, recordId: null, reference: null, origin: 'http://localhost:3200', live: null },
      warnings: [
        {
          reason: 'REMOVABLE_PROTECTORS',
          key: 'warning.protectors-removable',
          texts: label.languages.map((language) => ({ language, text: language === 'it' ? TEXTS[0]!.text : language === 'en' ? 'The protectors can be taken out: the class holds only with them in place.' : null })),
          draft: true,
        },
      ],
      glove: null,
      gpsr: { typed: label.gpsrContact, expected: { who: 'COMPANY', name: 'Officina Demo S.r.l.', address: 'Via dell’Esempio 12, 00000 Borgo Demo (XX)', contact: 'assistenza@example.com', operatorId: uid('5402', 1) }, suggested: 'Officina Demo S.r.l.\nVia dell’Esempio 12, 00000 Borgo Demo (XX)\nassistenza@example.com' },
    },
    asOf: '2026-10-29',
    ...extra,
  }
}

/** A glove marking's checks: level 1 KP granted by its certificate, no warning, no QR. */
export function gloveChecks(): LabelChecks {
  const base = demoChecks(GLOVES_R1)
  return {
    ...base,
    markets: base.markets.map((entry) => {
      const checks = [
        check('ceMarking', 'PASS', 'The CE marking prints; category II: no notified-body number after it.'),
        check('classWarnings', 'NOT_APPLICABLE', 'A glove: EN 17092 class warnings do not apply.'),
        check('gloveMarking', 'PASS', 'Marked EN 13594 level 1 KP, as certificate CERT-DEMO-0002 grants.'),
        check('gpsr', 'NOT_APPLICABLE', 'A PPE garment: the GPSR contact is not asked for this market (Owner Q37).'),
        check('qrCode', 'NOT_APPLICABLE', 'The label carries no QR.'),
      ]
      return { ...entry, checks, blocks: false }
    }),
    marking: { ...base.marking, qr: null, warnings: [], glove: { level: { level: '1', knuckle: true }, text: '1 KP', granted: { level: '1', knuckle: true } } },
  }
}

/** The t-shirt's fibre and care label: not PPE, the GPSR contact typed. */
export function tshirtChecks(): LabelChecks {
  const base = demoChecks(TSHIRT_R1)
  return {
    ...base,
    style: { ...base.style, ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null, productType: 'OTHER' },
    markets: base.markets.map((entry) => {
      const checks = [
        check('ceMarking', 'NOT_APPLICABLE', 'A fibre and care label of a style that is not PPE: no CE marking.'),
        check('classWarnings', 'NOT_APPLICABLE', 'Not an EN 17092 garment.'),
        check('gloveMarking', 'NOT_APPLICABLE', 'Not a glove.'),
        check('gpsr', 'PASS', 'The label prints the model, the batch and the contact with a postal and an electronic address.'),
        check('qrCode', 'NOT_APPLICABLE', 'The label carries no QR.'),
      ]
      return { ...entry, checks, blocks: false }
    }),
    marking: { ...base.marking, qr: null, warnings: [] },
  }
}

// ---- the jacket's textile checks (B-W2b-208) ----
const result = (key: TextileChecks['results'][number]['key'], outcome: TextileChecks['results'][number]['outcome'], words: string, findings: TextileChecks['results'][number]['findings'] = []): TextileChecks['results'][number] => ({
  key,
  title: CHECK_WORDS[key].title,
  on: outcome !== 'OFF',
  switchable: ['textileShare', 'careLabel', 'madeInItaly'].includes(key),
  outcome,
  words,
  law: [...CHECK_WORDS[key].law],
  findings,
})

export function demoTextile(label: LabelTemplate = JACKET_R2): TextileChecks {
  return {
    style: { id: uid('5301', 1), code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, originCountry: 'IT', netMassKg: '1.850' },
    revision: { id: uid('5320', 2), revision: 2, status: 'RELEASED' },
    size: '52',
    label: { id: label.id, code: label.code, revision: label.revision, status: label.status, languages: label.languages },
    composition: [
      {
        colourways: ['NER', 'GRI'],
        parts: [
          { component: 'SHELL', part: 'outer fabric', words: { en: 'outer fabric', it: 'tessuto esterno' }, fibres: [{ fibre: 'polyamide', annex: true, percent: '80', names: { en: 'polyamide', it: 'poliammide' } }, { fibre: 'polyester', annex: true, percent: '20', names: { en: 'polyester', it: 'poliestere' } }], basis: 'BY_WEIGHT', materials: ['DEMO-TES-01', 'DEMO-TES-02'] },
          { component: 'LINING', part: 'lining', words: { en: 'lining', it: 'fodera' }, fibres: [{ fibre: 'polyester', annex: true, percent: '100', names: { en: 'polyester', it: 'poliestere' } }], basis: 'ONE_COMPOSITION', materials: ['DEMO-FOD-01'] },
          { component: 'PADDING', part: 'padding', words: { en: 'padding', it: 'imbottitura' }, fibres: null, basis: null, materials: ['DEMO-IMB-01', 'DEMO-IMB-02'] },
        ],
        findings: [{ path: 'lines/7/weight', message: 'DEMO-IMB-02 has no weight: write it as "180 g/m2".', severity: 'WARN' }],
      },
    ],
    textileShare: [{ colourways: ['NER', 'GRI'], pct: '82.4', applies: true, basis: 'NET_MASS', missing: [] }],
    results: [
      result('composition', 'FAIL', 'The outer fabric is 80 % polyamide and 20 % polyester by weight; the label says 75 % and 20 %.', [{ path: 'label/composition/0', message: 'The label’s Esterno adds up to 95 %.', severity: 'FAIL' }]),
      result('fibreNames', 'PASS', 'Every fibre is named by its official name.'),
      result('animalOrigin', 'PASS', 'The BOM has leather: the label carries the animal-origin phrase.'),
      result('textileShare', 'PASS', 'Textile share 82 % by weight: textile labelling applies.'),
      result('careLabel', 'OFF', 'Off: whether a care label is mandatory in Italy is not verified yet.'),
      result('madeInItaly', 'PASS', '"Made in Italy" allowed: cutting and sewing in Italy.'),
      result('leatherNaming', 'PASS', 'Every leather name is used for animal leather.'),
    ],
    asOf: at(29, 9, 40),
  }
}

// ---- the jacket's proofs (B-W2b-259) ----
export function demoArtwork(label: LabelTemplate = JACKET_R2, extra: Partial<Artwork> = {}): Artwork {
  const file = (n: number, contentType = 'application/pdf') => ({ id: uid('5403', n), name: `${label.code}-r${label.revision}-proof-v${n}.pdf`, contentType, status: 'AVAILABLE' })
  return {
    label: { id: label.id, code: label.code, revision: label.revision, name: label.name, status: label.status, kind: label.kind, companyId: label.companyId, styleId: label.styleId },
    versions: [
      { id: uid('5404', 3), versionNo: 3, status: 'DRAFT', file: file(3, 'image/png'), author: GIULIA, byYou: false, approvedAt: null, approvedBy: null, retiredAt: null, note: 'Nuovo indirizzo del fabbricante (inventato).', createdAt: at(28, 15, 2), version: 1, approveHeld: null },
      { id: uid('5404', 2), versionNo: 2, status: 'APPROVED', file: file(2), author: GIULIA, byYou: false, approvedAt: at(20, 11), approvedBy: MARCO, retiredAt: null, note: null, createdAt: at(19, 16), version: 2, approveHeld: 'Artwork v2 is approved already.' },
      { id: uid('5404', 1), versionNo: 1, status: 'RETIRED', file: file(1), author: MARCO, byYou: false, approvedAt: at(5, 10), approvedBy: GIULIA, retiredAt: at(20, 11), note: null, createdAt: at(4, 9), version: 3, approveHeld: 'Artwork v1 is retired.' },
    ],
    approvedId: uid('5404', 2),
    workOrders: [
      { id: uid('5330', 1), number: 'WO-DEMO-001', status: 'COMPLETED', firstPrintAt: at(12, 8), artwork: { id: uid('5404', 1), versionNo: 1 } },
      { id: uid('5330', 2), number: 'WO-DEMO-002', status: 'IN_PROGRESS', firstPrintAt: at(24, 8), artwork: { id: uid('5404', 2), versionNo: 2 } },
      { id: uid('5330', 3), number: 'WO-DEMO-003', status: 'RELEASED', firstPrintAt: null, artwork: null },
    ],
    mayManage: true,
    mayApprove: true,
    asOf: '2026-10-29',
    ...extra,
  }
}

/** A picture proof for the approve dialog (an SVG drawn here: words in boxes, never real artwork). */
export const PROOF_PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="640" viewBox="0 0 400 640"><rect x="4" y="4" width="392" height="632" rx="16" fill="#fff" stroke="#888" stroke-width="4" stroke-dasharray="14 8"/><text x="200" y="90" font-family="sans-serif" font-size="34" text-anchor="middle" fill="#333">PROOF v3 (demo)</text><text x="200" y="160" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#555">LBL-DEMO-JKT-01 r2</text><rect x="120" y="220" width="160" height="120" fill="none" stroke="#555" stroke-width="3"/><text x="200" y="290" font-family="sans-serif" font-size="40" text-anchor="middle" fill="#555">CE</text><text x="200" y="420" font-family="sans-serif" font-size="20" text-anchor="middle" fill="#555">Officina Demo S.r.l.</text></svg>',
)}`

// ---- the phrase library's cells (B-W2b-249) ----
const cell = (language: string, state: Phrase['cells'][number]['state'], approved: string | null, draft?: { text: string; by: { id: string; name: string } }): Phrase['cells'][number] => ({
  language,
  state,
  approved: approved ? { id: uid('5405', language.charCodeAt(0) + approved.length), text: approved, revision: 1 } : null,
  draft: draft ? { id: uid('5406', language.charCodeAt(0) + draft.text.length), text: draft.text, revision: 1, proposedBy: draft.by, version: 1 } : null,
})

export function demoPhrases(languages: readonly string[] = ['it', 'en', 'nl', 'de', 'fr']): Phrase[] {
  const of = (key: string, kind: Phrase['kind'], sourceText: string, cells: Record<string, Phrase['cells'][number]>): Phrase => ({ id: uid('5407', key.length), key, kind, sourceLanguage: 'it', sourceText, revision: 1, status: 'ACTIVE', version: 1, cells: languages.map((language) => cells[language] ?? cell(language, 'MISSING', null)) })
  return [
    of('warning.protectors-removable', 'WARNING', TEXTS[0]!.text!, {
      it: cell('it', 'SOURCE', null),
      en: cell('en', 'APPROVED', 'The protectors can be taken out: the class holds only with them in place.'),
      fr: cell('fr', 'PROPOSED', null, { text: 'Les protections sont amovibles : la classe ne vaut qu’avec elles en place.', by: GIULIA }),
      de: cell('de', 'MISSING', null),
    }),
    of('marking.animal-origin', 'MARKING', 'Contiene parti non tessili di origine animale', {
      it: cell('it', 'SOURCE', null),
      en: cell('en', 'APPROVED', 'Contains non-textile parts of animal origin'),
      de: cell('de', 'APPROVED', 'Enthält nichttextile Teile tierischen Ursprungs'),
      fr: cell('fr', 'APPROVED', 'Contient des parties non textiles d’origine animale'),
      nl: cell('nl', 'PROPOSED', null, { text: 'Bevat niet-textieldelen van dierlijke oorsprong', by: { id: ME, name: 'Tu (demo)' } }),
    }),
    of('care.wash-30-mild', 'CARE', 'Lavare a 30 °C, ciclo delicato', {
      it: cell('it', 'SOURCE', null),
      en: cell('en', 'APPROVED', 'Wash at 30 °C, mild process'),
      de: cell('de', 'STALE', null),
    }),
  ]
}

export function demoDepth(extra: Partial<RecordDepth> = {}): RecordDepth {
  const phrases = demoPhrases()
  return {
    can: DEPTH_CAN.owner,
    me: ME,
    checks: ready(demoChecks()),
    market: null,
    textile: ready(demoTextile()),
    marking: null,
    artwork: ready(demoArtwork()),
    proof: null,
    picked: null,
    phrases: ready({ phrases, languages: ['it', 'en', 'nl', 'de', 'fr'], asOf: at(29, 9, 40), mayManage: true, mayApprove: true }),
    selectedPhrases: [],
    writing: null,
    cellProblem: null,
    ...extra,
  }
}
