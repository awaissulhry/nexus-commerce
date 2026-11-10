import type { EvidenceKind, LimitBound, RuleCode, RuleMaterialKind, SubstanceList, SubstanceUnit } from './rules'

/**
 * The starter list (B-W2b-250; PRD-318, PRD-320 … PRD-325, PRD-329; design compliance.tests › Substance list, its empty
 * state "Load the starter list"): the REACH Annex XVII entries the plan names, as public law writes them — the substances
 * with their public CAS and EC numbers (EC only where it is certain; none is better than a wrong one) and the eight rules
 * with their limits, the side of the limit a value at it falls on, the test method and the legal reference. Loaded
 * tenant-wide by POST /compliance/substances/starter: only what is missing (a substance by its CAS number, a family by its
 * name; a rule by its key), so loading it twice adds nothing and nothing a person changed is overwritten.
 *
 * Entry 72 (CMR substances in clothing) and the PFAS screening are loaded switched OFF with the reason (Owner answer
 * 11-09, question 5 A: they stay off until a style or a market needs them). The SVHC Candidate List is not here: ECHA
 * publishes it as a sheet, imported with the substance importer (lists SVHC, the day it was added). No business data.
 */

export interface StarterSubstance {
  /** CAS number; null for a family without one (matched by its name). */
  readonly casNumber: string | null
  readonly ecNumber: string | null
  readonly name: string
  readonly groupCode: string | null
  readonly lists: readonly SubstanceList[]
  readonly annexXviiEntries: readonly string[]
  readonly note: string | null
}

export interface StarterRule {
  readonly key: string
  readonly code: RuleCode
  readonly name: string
  /** The substance it restricts, by CAS number (or the family's name), or the group. */
  readonly substance: { readonly cas: string } | { readonly family: string } | null
  readonly substanceGroup: string | null
  readonly materialKinds: readonly RuleMaterialKind[]
  readonly scopeNote: string
  readonly limitValue: string | null
  readonly limitUnit: SubstanceUnit | null
  readonly limitBound: LimitBound | null
  readonly testMethod: string | null
  readonly evidence: EvidenceKind
  readonly exemptPpe: boolean
  readonly exemptNaturalLeather: boolean
  readonly legalReference: string
  /** null: switched on; words: switched off with this reason. */
  readonly offReason: string | null
}

export const REACH_URL = 'https://eur-lex.europa.eu/eli/reg/2006/1907/oj'

const XVII = (entry: string, name: string, cas: string | null, groupCode: string | null, ec: string | null = null, note: string | null = null): StarterSubstance => ({
  casNumber: cas,
  ecNumber: ec,
  name,
  groupCode,
  lists: ['REACH_ANNEX_XVII'],
  annexXviiEntries: [entry],
  note,
})

/** Entry 43, Appendix 8: the aromatic amines an azo colourant may not release (group AZO_AMINES). */
const AZO_AMINES: readonly StarterSubstance[] = [
  XVII('43', '4-Aminobiphenyl', '92-67-1', 'AZO_AMINES', '202-177-1'),
  XVII('43', 'Benzidine', '92-87-5', 'AZO_AMINES', '202-199-1'),
  XVII('43', '4-Chloro-o-toluidine', '95-69-2', 'AZO_AMINES'),
  XVII('43', '2-Naphthylamine', '91-59-8', 'AZO_AMINES'),
  XVII('43', 'o-Aminoazotoluene', '97-56-3', 'AZO_AMINES'),
  XVII('43', '5-Nitro-o-toluidine', '99-55-8', 'AZO_AMINES'),
  XVII('43', '4-Chloroaniline', '106-47-8', 'AZO_AMINES'),
  XVII('43', '4-Methoxy-m-phenylenediamine', '615-05-4', 'AZO_AMINES'),
  XVII('43', "4,4'-Methylenedianiline", '101-77-9', 'AZO_AMINES'),
  XVII('43', "3,3'-Dichlorobenzidine", '91-94-1', 'AZO_AMINES'),
  XVII('43', "3,3'-Dimethoxybenzidine", '119-90-4', 'AZO_AMINES'),
  XVII('43', "3,3'-Dimethylbenzidine", '119-93-7', 'AZO_AMINES'),
  XVII('43', "4,4'-Methylenedi-o-toluidine", '838-88-0', 'AZO_AMINES'),
  XVII('43', 'p-Cresidine', '120-71-8', 'AZO_AMINES'),
  XVII('43', "4,4'-Methylene-bis-(2-chloroaniline)", '101-14-4', 'AZO_AMINES'),
  XVII('43', "4,4'-Oxydianiline", '101-80-4', 'AZO_AMINES'),
  XVII('43', "4,4'-Thiodianiline", '139-65-1', 'AZO_AMINES'),
  XVII('43', 'o-Toluidine', '95-53-4', 'AZO_AMINES'),
  XVII('43', '4-Methyl-m-phenylenediamine', '95-80-7', 'AZO_AMINES'),
  XVII('43', '2,4,5-Trimethylaniline', '137-17-7', 'AZO_AMINES'),
  XVII('43', 'o-Anisidine', '90-04-0', 'AZO_AMINES'),
  XVII('43', '4-Aminoazobenzene', '60-09-3', 'AZO_AMINES'),
]

/** Entry 50: the eight PAHs (group PAH_8). */
const PAH_8: readonly StarterSubstance[] = [
  XVII('50', 'Benzo[a]pyrene', '50-32-8', 'PAH_8', '200-028-5'),
  XVII('50', 'Benzo[e]pyrene', '192-97-2', 'PAH_8'),
  XVII('50', 'Benz[a]anthracene', '56-55-3', 'PAH_8'),
  XVII('50', 'Chrysene', '218-01-9', 'PAH_8'),
  XVII('50', 'Benzo[b]fluoranthene', '205-99-2', 'PAH_8'),
  XVII('50', 'Benzo[j]fluoranthene', '205-82-3', 'PAH_8'),
  XVII('50', 'Benzo[k]fluoranthene', '207-08-9', 'PAH_8'),
  XVII('50', 'Dibenz[a,h]anthracene', '53-70-3', 'PAH_8'),
]

export const NPE_FAMILY = 'Nonylphenol ethoxylates'

export const STARTER_SUBSTANCES: readonly StarterSubstance[] = Object.freeze([
  XVII('47', 'Chromium VI', '18540-29-9', 'CR6', null, 'Chromium VI compounds in leather in contact with the skin (entry 47).'),
  XVII('27', 'Nickel', '7440-02-0', null, '231-111-4'),
  XVII('61', 'Dimethylfumarate', '624-49-7', null, '210-849-0'),
  XVII('46a', NPE_FAMILY, null, 'NPE', null, 'A family of substances: no single CAS number.'),
  ...AZO_AMINES,
  ...PAH_8,
])

const ON = null
export const OWNER_5A_CMR = "Off until a line of clothing that is not PPE needs it (Owner answer 11-09, question 5 A)."
export const OWNER_5A_PFAS = 'Off until a style or a market needs it (Owner answer 11-09, question 5 A); the entry and its limits are to be verified.'

export const STARTER_RULES: readonly StarterRule[] = Object.freeze([
  {
    key: 'REACH-XVII-47',
    code: 'CR6',
    name: 'Chromium VI in leather in contact with the skin',
    substance: { cas: '18540-29-9' },
    substanceGroup: null,
    materialKinds: ['LEATHER'],
    scopeNote: 'Leather articles and leather parts of articles coming into contact with the skin.',
    limitValue: '3',
    limitUnit: 'MG_KG',
    limitBound: 'BELOW',
    testMethod: 'EN ISO 17075-1 or EN ISO 17075-2',
    evidence: 'TEST',
    exemptPpe: false,
    exemptNaturalLeather: false,
    legalReference: 'REACH Annex XVII entry 47',
    offReason: ON,
  },
  {
    key: 'REACH-XVII-43',
    code: 'AZO',
    name: 'Azo colourants releasing the listed aromatic amines',
    substance: null,
    substanceGroup: 'AZO_AMINES',
    materialKinds: ['LEATHER', 'TEXTILE', 'LINING'],
    scopeNote: 'Textile and leather articles which may come into direct and prolonged contact with the skin.',
    limitValue: '30',
    limitUnit: 'MG_KG',
    limitBound: 'AT_MOST',
    testMethod: 'EN ISO 17234-1 (leather), EN ISO 14362-1 (textiles)',
    evidence: 'EITHER',
    exemptPpe: false,
    exemptNaturalLeather: false,
    legalReference: 'REACH Annex XVII entry 43',
    offReason: ON,
  },
  {
    key: 'REACH-XVII-27',
    code: 'NICKEL',
    name: 'Nickel release from metal parts in prolonged skin contact',
    substance: { cas: '7440-02-0' },
    substanceGroup: null,
    materialKinds: ['TRIM', 'HARDWARE'],
    scopeNote: 'Rivets, buttons, zips and other metal parts of garments in direct and prolonged contact with the skin; per trim model.',
    limitValue: '0.5',
    limitUnit: 'UG_CM2_WEEK',
    limitBound: 'AT_MOST',
    testMethod: 'EN 1811',
    evidence: 'EITHER',
    exemptPpe: false,
    exemptNaturalLeather: false,
    legalReference: 'REACH Annex XVII entry 27',
    offReason: ON,
  },
  {
    key: 'REACH-XVII-50',
    code: 'PAH',
    name: 'The eight PAHs in rubber and plastic parts',
    substance: null,
    substanceGroup: 'PAH_8',
    materialKinds: ['PROTECTOR', 'TRIM'],
    scopeNote: 'Rubber or plastic parts in direct and prolonged or short-term repetitive contact with the skin (grips, protector shells, patches).',
    limitValue: '1',
    limitUnit: 'MG_KG',
    limitBound: 'AT_MOST',
    testMethod: 'AfPS GS 2019:01 PAK',
    evidence: 'EITHER',
    exemptPpe: false,
    exemptNaturalLeather: false,
    legalReference: 'REACH Annex XVII entry 50',
    offReason: ON,
  },
  {
    key: 'REACH-XVII-61',
    code: 'DMFU',
    name: 'Dimethylfumarate in articles',
    substance: { cas: '624-49-7' },
    substanceGroup: null,
    materialKinds: [],
    scopeNote: 'Any article or part of it; check leather and shipping packs (anti-mould sachets).',
    limitValue: '0.1',
    limitUnit: 'MG_KG',
    limitBound: 'AT_MOST',
    testMethod: 'CEN ISO/TS 16186',
    evidence: 'EITHER',
    exemptPpe: false,
    exemptNaturalLeather: false,
    legalReference: 'REACH Annex XVII entry 61',
    offReason: ON,
  },
  {
    key: 'REACH-XVII-46a',
    code: 'NPE',
    name: 'Nonylphenol ethoxylates in textiles washed in water',
    substance: { family: NPE_FAMILY },
    substanceGroup: null,
    materialKinds: ['TEXTILE', 'LINING'],
    scopeNote: 'Textile articles which can reasonably be expected to be washed in water during their normal lifecycle.',
    limitValue: '0.01',
    limitUnit: 'PERCENT_WW',
    limitBound: 'BELOW',
    testMethod: 'EN ISO 18254-1',
    evidence: 'EITHER',
    exemptPpe: false,
    exemptNaturalLeather: false,
    legalReference: 'REACH Annex XVII entry 46a',
    offReason: ON,
  },
  {
    key: 'REACH-XVII-72',
    code: 'CMR',
    name: 'CMR substances in clothing and textile articles',
    substance: null,
    substanceGroup: 'CMR_APPENDIX_12',
    materialKinds: ['TEXTILE', 'LINING', 'LEATHER'],
    scopeNote: 'Clothing and textile parts in contact with the skin, at the limits of Appendix 12; PPE and parts made only of natural leather, fur or hide are exempt.',
    limitValue: null,
    limitUnit: null,
    limitBound: null,
    testMethod: null,
    evidence: 'DECLARATION',
    exemptPpe: true,
    exemptNaturalLeather: true,
    legalReference: 'REACH Annex XVII entry 72',
    offReason: OWNER_5A_CMR,
  },
  {
    key: 'REACH-XVII-79',
    code: 'PFAS',
    name: 'PFAS screening of water-repellent finishes, membranes and coatings',
    substance: null,
    substanceGroup: 'PFHXA',
    materialKinds: ['MEMBRANE', 'TEXTILE'],
    scopeNote: 'Only for water-repellent finishes, membranes and coatings, or sales to France.',
    limitValue: null,
    limitUnit: null,
    limitBound: null,
    testMethod: null,
    evidence: 'DECLARATION',
    exemptPpe: false,
    exemptNaturalLeather: false,
    legalReference: 'REACH Annex XVII entry 79 (PFHxA), to be verified',
    offReason: OWNER_5A_PFAS,
  },
] satisfies StarterRule[])
