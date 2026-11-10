import { cell, foldWord, type CellValue } from '../../imports/cells'
import { defineImporter, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import {
  ANNEX_ENTRY,
  EVIDENCE_KINDS,
  LIMIT_BOUNDS,
  looksLikeCas,
  marketCodeOk,
  ordered,
  RULE_CODES,
  RULE_KEY,
  RULE_MATERIAL_KINDS,
  RULE_PRODUCT_TYPES,
  RULE_SOURCES,
  ruleProblems,
  splitValues,
  SUBSTANCE_LIMITS,
  SUBSTANCE_LISTS,
  SUBSTANCE_UNITS,
  substanceProblems,
  type EvidenceKind,
  type LimitBound,
  type RuleCode,
  type RuleSource,
  type SubstanceList,
  type SubstanceStatus,
  type SubstanceUnit,
} from './rules'

/**
 * The substance list's imports (B-W2b-250; PRD-318; design compliance.tests › Substance list "Yearly AFIRM import through
 * the import flow (dry run first)"), two sheets through the platform's import flow with its dry run:
 *
 *   compliance.substances       one substance per row, found by its CAS number (or, for a family without one, by its
 *                               name): the ECHA Candidate List export (lists SVHC, the day ECHA added it), an AFIRM RSL
 *                               (AFIRM_RSL), a brand's RSL (CUSTOMER_RSL), Annex XVII entries. A known substance takes
 *                               the cells given; its lists and Annex XVII entries are ADDED to (an import never takes a
 *                               substance off a list: edit it), its CAS and EC numbers are given once.
 *   compliance.substanceRules   one rule per row, found by its key: what it restricts (a substance by CAS number or
 *                               family name, or a group), where, the limit with its unit and bound, the method, the
 *                               evidence, the exemptions, the source (a brand by its party code) and legal reference. A
 *                               new rule of a brand's RSL is switched ON (it reaches that brand's styles only); any other
 *                               new rule comes in OFF with the reason (Owner answer 11-09, question 5 A: switch it on when
 *                               a style or a market needs it). A known rule takes the cells given; its switch is the
 *                               switch route's.
 *
 * Blank cells are "not given", never "clear it". The adapters (apps/factory-api modules/compliance/substances/importer.ts)
 * load each record as `$record` beside its columns, check the substance, version and brand a row names, and write.
 */

export const SUBSTANCES_IMPORTER_KEY = 'compliance.substances'
export const RULES_IMPORTER_KEY = 'compliance.substanceRules'
const RECORD = '$record'

const LIST_ALIASES: Readonly<Record<string, SubstanceList>> = {
  'reach annex xvii': 'REACH_ANNEX_XVII',
  'annex xvii': 'REACH_ANNEX_XVII',
  'allegato xvii': 'REACH_ANNEX_XVII',
  xvii: 'REACH_ANNEX_XVII',
  svhc: 'SVHC',
  'candidate list': 'SVHC',
  'elenco delle sostanze candidate': 'SVHC',
  'lista candidate': 'SVHC',
  pops: 'POPS',
  pop: 'POPS',
  afirm: 'AFIRM_RSL',
  'afirm rsl': 'AFIRM_RSL',
  'customer rsl': 'CUSTOMER_RSL',
  'brand rsl': 'CUSTOMER_RSL',
  'rsl cliente': 'CUSTOMER_RSL',
  'rsl del marchio': 'CUSTOMER_RSL',
}
const KIND_ALIASES: Readonly<Record<string, string>> = {
  pelle: 'LEATHER',
  cuoio: 'LEATHER',
  tessuto: 'TEXTILE',
  fodera: 'LINING',
  membrana: 'MEMBRANE',
  imbottitura: 'PADDING',
  filo: 'THREAD',
  accessorio: 'TRIM',
  accessori: 'TRIM',
  minuteria: 'HARDWARE',
  protezione: 'PROTECTOR',
  protezioni: 'PROTECTOR',
  etichetta: 'LABEL',
  imballo: 'PACKAGING',
  componente: 'COMPONENT',
}
const TYPE_ALIASES: Readonly<Record<string, string>> = { giacca: 'JACKET', giubbotto: 'JACKET', pantaloni: 'TROUSERS', tuta: 'SUIT', guanti: 'GLOVES', gilet: 'VEST', altro: 'OTHER' }

/** Reads a cell of several values against a list of allowed ones (and aliases): the values in order, or the ones not known. */
export function readValues<V extends string>(text: string, allowed: readonly V[], aliases: Readonly<Record<string, string>> = {}): { readonly values: V[]; readonly unknown: string[] } {
  const lookup = new Map<string, V>()
  for (const value of allowed) {
    lookup.set(foldWord(value), value)
    lookup.set(foldWord(value.replace(/_/g, ' ')), value)
  }
  for (const [alias, value] of Object.entries(aliases)) if ((allowed as readonly string[]).includes(value)) lookup.set(foldWord(alias), value as V)
  const values: V[] = []
  const unknown: string[] = []
  for (const part of splitValues(text)) {
    const found = lookup.get(foldWord(part))
    if (found) values.push(found)
    else unknown.push(part)
  }
  return { values: ordered(values, allowed), unknown }
}

const marketsOf = (text: string): { readonly values: string[]; readonly unknown: string[] } => {
  const parts = splitValues(text).map((part) => part.toUpperCase())
  return { values: ordered(parts.filter(marketCodeOk)), unknown: parts.filter((part) => !marketCodeOk(part)) }
}
const entriesOf = (text: string): { readonly values: string[]; readonly unknown: string[] } => {
  const parts = splitValues(text).map((part) => part.replace(/^(entry|voce)\s*/i, ''))
  return { values: ordered(parts.filter((part) => ANNEX_ENTRY.test(part))), unknown: parts.filter((part) => !ANNEX_ENTRY.test(part)) }
}

const wordsOf = (values: RowValues, it: string, en: string, current: Readonly<Record<string, string>> | null): Record<string, string> | null | undefined => {
  if (values[it] === undefined && values[en] === undefined) return undefined
  return { ...(current ?? {}), ...(typeof values[it] === 'string' ? { it: values[it] as string } : {}), ...(typeof values[en] === 'string' ? { en: values[en] as string } : {}) }
}

const refused = (errors: readonly RowIssue[]): RowPlan => ({ action: 'ERROR', errors })

function recordOf<T>(existing: ExistingRecord, what: string): T {
  const raw = existing.values[RECORD]
  if (typeof raw !== 'string') throw new Error(`The ${what} import needs the record ($record) beside the columns.`)
  return JSON.parse(raw) as T
}

/** The UPDATE or UNCHANGED plan of two column sets (a null `after` is "not given"). */
function changes(before: Readonly<Record<string, CellValue | null>>, after: Readonly<Record<string, CellValue | null>>): RowPlan {
  const was: Record<string, CellValue | null> = {}
  const now: Record<string, CellValue> = {}
  for (const [column, to] of Object.entries(after)) {
    const from = before[column] ?? null
    if (to === null || from === to) continue
    was[column] = from
    now[column] = to
  }
  return Object.keys(now).length === 0 ? { action: 'UNCHANGED' } : { action: 'UPDATE', before: was, after: now }
}

// ==== compliance.substances ==========================================================================================

export const substancesImporter = defineImporter({
  key: SUBSTANCES_IMPORTER_KEY,
  label: 'Restricted substances',
  description: 'The restricted substance list: REACH Annex XVII entries, the SVHC Candidate List, POPs, an AFIRM RSL or a brand\'s RSL; one substance per row, found by its CAS number (a family by its name).',
  columns: {
    identifier: {
      label: 'CAS number',
      aliases: ['cas', 'cas no', 'cas no.', 'cas number', 'numero cas', 'n. cas', 'cas o famiglia', 'cas or family'],
      required: true,
      type: cell.text({ max: SUBSTANCE_LIMITS.name }),
      description: 'The CAS number ("50-32-8"); for a family without one, its name ("Nonylphenol ethoxylates").',
    },
    name: { label: 'Name', aliases: ['nome', 'substance name', 'nome sostanza', 'denominazione', 'substance'], type: cell.text({ max: SUBSTANCE_LIMITS.name }), description: 'Needed for a new substance with a CAS number.' },
    nameIt: { label: 'Name (it)', aliases: ['nome (it)', 'nome italiano'], type: cell.text({ max: SUBSTANCE_LIMITS.name }) },
    nameEn: { label: 'Name (en)', aliases: ['nome (en)', 'nome inglese'], type: cell.text({ max: SUBSTANCE_LIMITS.name }) },
    ecNumber: { label: 'EC number', aliases: ['ec', 'ec no', 'ec no.', 'numero ce', 'n. ce', 'einecs'], type: cell.text({ max: 20 }), description: 'NNN-NNN-R with its check digit; given once.' },
    group: { label: 'Group', aliases: ['gruppo', 'group code', 'famiglia'], type: cell.code({ max: 40, upper: true }), description: 'The group a rule names it by ("AZO_AMINES", "PAH_8").' },
    lists: {
      label: 'Lists',
      aliases: ['liste', 'list', 'elenco', 'source', 'fonte'],
      type: cell.text({ max: 200 }),
      description: 'REACH_ANNEX_XVII, SVHC, POPS, AFIRM_RSL, CUSTOMER_RSL (several with a comma); added to the lists it is on. Needed for a new substance.',
    },
    annexXviiEntries: { label: 'Annex XVII entries', aliases: ['voci allegato xvii', 'annex xvii entry', 'entry', 'voce', 'reach entry'], type: cell.text({ max: 100 }), description: '"43", "46a" (several with a comma); with the list REACH_ANNEX_XVII.' },
    svhcAddedOn: { label: 'SVHC added on', aliases: ['date of inclusion', 'data di inclusione', 'inclusa il', 'added on'], type: cell.date(), description: 'The day ECHA added it to the Candidate List: the list version of that day (record it first).' },
    note: { label: 'Note', aliases: ['nota', 'note', 'reason for inclusion', 'motivo'], type: cell.text({ max: SUBSTANCE_LIMITS.note }) },
  },
  keyColumns: ['identifier'],
  batchSize: 100,
  validateRow: (values) => substanceRowIssues(values),
  plan: (values, existing) => planSubstanceRow(values, existing),
})

/** A substance as the import sees it (`$record`). */
export interface ImportedSubstance {
  readonly casNumber: string | null
  readonly ecNumber: string | null
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string>> | null
  readonly groupCode: string | null
  readonly lists: readonly SubstanceList[]
  readonly annexXviiEntries: readonly string[]
  /** The day of the Candidate List version that added it (null: none). */
  readonly svhcAddedOn: string | null
  readonly note: string | null
  readonly status: SubstanceStatus
  /** Of another company than the job's (a company's row for a tenant-wide job, or the reverse). */
  readonly foreign: boolean
}

function substanceColumns(record: Omit<ImportedSubstance, 'status' | 'foreign'>): Record<string, CellValue | null> {
  return {
    identifier: record.casNumber ?? record.name,
    name: record.name,
    nameIt: record.nameI18n?.it ?? null,
    nameEn: record.nameI18n?.en ?? null,
    ecNumber: record.ecNumber,
    group: record.groupCode,
    lists: record.lists.join(', '),
    annexXviiEntries: record.annexXviiEntries.length > 0 ? record.annexXviiEntries.join(', ') : null,
    svhcAddedOn: record.svhcAddedOn,
    note: record.note,
  }
}

/** The values the adapter's load answers for a substance: its columns and the whole record (`$record`). */
export function substanceRecordValues(record: ImportedSubstance): RecordValues {
  return { ...substanceColumns(record), [RECORD]: JSON.stringify(record) }
}

function substanceRowIssues(values: RowValues): RowIssue[] {
  const issues: RowIssue[] = []
  if (typeof values.lists === 'string') {
    const { unknown } = readValues(values.lists, SUBSTANCE_LISTS, LIST_ALIASES)
    if (unknown.length > 0) issues.push({ column: 'lists', message: `Not a list: ${unknown.join(', ')}. Write REACH_ANNEX_XVII, SVHC, POPS, AFIRM_RSL or CUSTOMER_RSL.` })
  }
  if (typeof values.annexXviiEntries === 'string') {
    const { unknown } = entriesOf(values.annexXviiEntries)
    if (unknown.length > 0) issues.push({ column: 'annexXviiEntries', message: `Not an Annex XVII entry: ${unknown.join(', ')} (write "43", "46a").` })
  }
  return issues
}

/** The substance a row makes or becomes (over `current`, or nothing for a new one). */
export function substanceFromRow(values: RowValues, current: Omit<ImportedSubstance, 'status' | 'foreign'> | null): Omit<ImportedSubstance, 'status' | 'foreign'> {
  const identifier = String(values.identifier).trim()
  const cas = looksLikeCas(identifier) ? identifier : null
  const base = current ?? { casNumber: cas, ecNumber: null, name: cas ? '' : identifier, nameI18n: null, groupCode: null, lists: [], annexXviiEntries: [], svhcAddedOn: null, note: null }
  const lists = typeof values.lists === 'string' ? ordered([...base.lists, ...readValues(values.lists, SUBSTANCE_LISTS, LIST_ALIASES).values], SUBSTANCE_LISTS) : [...base.lists]
  const entries = typeof values.annexXviiEntries === 'string' ? ordered([...base.annexXviiEntries, ...entriesOf(values.annexXviiEntries).values]) : [...base.annexXviiEntries]
  const nameI18n = wordsOf(values, 'nameIt', 'nameEn', base.nameI18n)
  return {
    casNumber: base.casNumber,
    ecNumber: typeof values.ecNumber === 'string' ? values.ecNumber.trim() : base.ecNumber,
    name: typeof values.name === 'string' ? values.name : base.name,
    nameI18n: nameI18n === undefined ? base.nameI18n : nameI18n,
    groupCode: typeof values.group === 'string' ? values.group : base.groupCode,
    lists,
    annexXviiEntries: entries,
    svhcAddedOn: typeof values.svhcAddedOn === 'string' ? values.svhcAddedOn : base.svhcAddedOn,
    note: typeof values.note === 'string' ? values.note : base.note,
  }
}

const SUBSTANCE_COLUMN_OF: Readonly<Record<string, string>> = { casNumber: 'identifier', svhcListVersionId: 'svhcAddedOn', groupCode: 'group' }
const substanceIssues = (fields: Omit<ImportedSubstance, 'status' | 'foreign'>): RowIssue[] =>
  substanceProblems({ ...fields, svhcListVersionId: fields.svhcAddedOn ? 'given' : null }).map((issue) => {
    const head = issue.path.split('/')[1] ?? ''
    const column = head === 'nameI18n' ? 'nameIt' : (SUBSTANCE_COLUMN_OF[head] ?? head)
    return Object.hasOwn(substancesImporter.columns, column) ? { column, message: issue.message } : { message: issue.message }
  })

/** What one substance row does (the importer's `plan`): see the module comment. */
export function planSubstanceRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) {
    const fields = substanceFromRow(values, null)
    const missing: RowIssue[] = []
    if (fields.casNumber !== null && values.name === undefined) missing.push({ column: 'name', message: 'Name is needed for a new substance.' })
    if (values.lists === undefined) missing.push({ column: 'lists', message: 'Lists is needed for a new substance (REACH_ANNEX_XVII, SVHC, …).' })
    if (missing.length > 0) return refused(missing)
    const problems = substanceIssues(fields)
    return problems.length > 0 ? refused(problems) : { action: 'CREATE', after: values }
  }
  const record = recordOf<ImportedSubstance>(existing, 'substances')
  if (record.foreign) return refused([{ column: 'identifier', message: "This substance is another company's (or one for every company): import it with that company." }])
  if (record.status !== 'ACTIVE') return refused([{ message: 'This substance is archived: restore it on the substance list (or add the right one) before importing changes.' }])
  const next = substanceFromRow(values, record)
  const problems = substanceIssues(next)
  if (record.ecNumber !== null && next.ecNumber !== record.ecNumber) problems.push({ column: 'ecNumber', message: `The EC number is given once (${record.ecNumber}): archive the substance and add the right one.` })
  if (problems.length > 0) return refused(problems)
  return changes(substanceColumns(record), { ...substanceColumns(next), identifier: null })
}

// ==== compliance.substanceRules ======================================================================================

const CODE_ALIASES: Readonly<Record<string, RuleCode>> = { nichel: 'NICKEL', ipa: 'PAH', 'cromo vi': 'CR6', 'chromium vi': 'CR6', 'cr vi': 'CR6', altro: 'OTHER' }
const UNIT_ALIASES: Readonly<Record<string, SubstanceUnit>> = {
  'mg/kg': 'MG_KG',
  ppm: 'MG_KG',
  'µg/kg': 'UG_KG',
  'μg/kg': 'UG_KG',
  'ug/kg': 'UG_KG',
  ppb: 'UG_KG',
  '%': 'PERCENT_WW',
  '% w/w': 'PERCENT_WW',
  '% p/p': 'PERCENT_WW',
  'µg/cm²/week': 'UG_CM2_WEEK',
  'μg/cm²/week': 'UG_CM2_WEEK',
  'ug/cm2/week': 'UG_CM2_WEEK',
  'µg/cm2/week': 'UG_CM2_WEEK',
  'µg/m²': 'UG_M2',
  'μg/m²': 'UG_M2',
  'ug/m2': 'UG_M2',
  'µg/m2': 'UG_M2',
}
const BOUND_ALIASES: Readonly<Record<string, LimitBound>> = { below: 'BELOW', '<': 'BELOW', sotto: 'BELOW', 'inferiore a': 'BELOW', 'at most': 'AT_MOST', '<=': 'AT_MOST', '≤': 'AT_MOST', 'al massimo': 'AT_MOST', 'non oltre': 'AT_MOST' }
const EVIDENCE_ALIASES: Readonly<Record<string, EvidenceKind>> = { prova: 'TEST', 'lab test': 'TEST', dichiarazione: 'DECLARATION', either: 'EITHER', entrambe: 'EITHER', 'test or declaration': 'EITHER', 'prova o dichiarazione': 'EITHER' }
const SOURCE_ALIASES: Readonly<Record<string, RuleSource>> = { legge: 'LAW', law: 'LAW', afirm: 'INDUSTRY', industria: 'INDUSTRY', brand: 'CUSTOMER', cliente: 'CUSTOMER', marchio: 'CUSTOMER' }

export const substanceRulesImporter = defineImporter({
  key: RULES_IMPORTER_KEY,
  label: 'Substance rules',
  description: "The rules over the substance list (a law's, an industry RSL's, a brand's): what each restricts, where, the limit, the method and the evidence; one rule per row, found by its key.",
  columns: {
    key: { label: 'Key', aliases: ['chiave', 'rule', 'regola', 'rule key', 'codice regola'], required: true, type: cell.text({ max: 80 }), description: 'Unique and stable ("REACH-XVII-43", "BRAND-RSL-2026-14").' },
    code: { label: 'Kind', aliases: ['tipo', 'code', 'codice', 'restriction'], type: cell.oneOf(RULE_CODES, CODE_ALIASES), description: 'AZO, NICKEL, PAH, DMFU, NPE, CMR, PFAS, CR6 or OTHER; needed for a new rule.' },
    name: { label: 'Name', aliases: ['nome', 'descrizione', 'description'], type: cell.text({ max: SUBSTANCE_LIMITS.name }), description: 'Needed for a new rule.' },
    nameIt: { label: 'Name (it)', aliases: ['nome (it)'], type: cell.text({ max: SUBSTANCE_LIMITS.name }) },
    nameEn: { label: 'Name (en)', aliases: ['nome (en)'], type: cell.text({ max: SUBSTANCE_LIMITS.name }) },
    substance: { label: 'Substance', aliases: ['sostanza', 'cas', 'cas number', 'numero cas'], type: cell.text({ max: SUBSTANCE_LIMITS.name }), description: 'One substance of the list by its CAS number (or a family by its name); or give the group.' },
    group: { label: 'Group', aliases: ['gruppo', 'substance group'], type: cell.code({ max: 40, upper: true }), description: 'A group of the list ("AZO_AMINES"); or give the substance.' },
    materialKinds: { label: 'Material kinds', aliases: ['tipi di materiale', 'materiali', 'material scope', 'materials'], type: cell.text({ max: 300 }), description: 'LEATHER, TEXTILE, LINING, TRIM … (several with a comma); blank: every kind.' },
    productTypes: { label: 'Product types', aliases: ['tipi di prodotto', 'prodotti'], type: cell.text({ max: 200 }), description: 'JACKET, TROUSERS, SUIT, GLOVES, VEST, OTHER; blank: every type.' },
    markets: { label: 'Markets', aliases: ['mercati', 'market codes'], type: cell.text({ max: 300 }), description: 'Market codes ("FR", "US-CA"); blank: every market.' },
    scopeNote: { label: 'Scope', aliases: ['ambito', 'scope note', 'campo di applicazione'], type: cell.text({ max: SUBSTANCE_LIMITS.scopeNote }) },
    limit: { label: 'Limit', aliases: ['limite', 'limit value', 'valore limite'], type: cell.decimal({ precision: 18, scale: 6, min: '0' }), description: 'Above 0, with its unit and bound; blank for a ban.' },
    unit: { label: 'Unit', aliases: ['unita', 'unità', 'unita di misura'], type: cell.oneOf(SUBSTANCE_UNITS, UNIT_ALIASES), description: 'mg/kg, µg/kg, % w/w, µg/cm²/week or µg/m².' },
    bound: { label: 'At the limit', aliases: ['al limite', 'bound', 'limit bound'], type: cell.oneOf(LIMIT_BOUNDS, BOUND_ALIASES), description: 'BELOW (passes only under it) or AT_MOST (passes at it).' },
    testMethod: { label: 'Test method', aliases: ['metodo', 'metodo di prova', 'method'], type: cell.text({ max: SUBSTANCE_LIMITS.testMethod }) },
    evidence: { label: 'Evidence', aliases: ['prova richiesta', 'evidenza'], type: cell.oneOf(EVIDENCE_KINDS, EVIDENCE_ALIASES), description: 'TEST, DECLARATION or EITHER; needed for a new rule.' },
    exemptPpe: { label: 'PPE exempt', aliases: ['esente dpi', 'ppe exempt', 'esenzione dpi'], type: cell.boolean() },
    exemptNaturalLeather: { label: 'Natural leather exempt', aliases: ['esente pelle naturale', 'natural leather exempt'], type: cell.boolean() },
    source: { label: 'Source', aliases: ['fonte', 'origine'], type: cell.oneOf(RULE_SOURCES, SOURCE_ALIASES), description: 'LAW, INDUSTRY or CUSTOMER (a brand\'s RSL: give the brand).' },
    customer: { label: 'Brand', aliases: ['marchio', 'cliente', 'customer', 'brand code'], type: cell.code({ max: 40 }), description: "The brand's party code, for a CUSTOMER rule." },
    legalReference: { label: 'Legal reference', aliases: ['riferimento normativo', 'riferimento', 'reference'], type: cell.text({ max: SUBSTANCE_LIMITS.legalReference }), description: 'Needed for a new rule ("REACH Annex XVII entry 43").' },
    legalUrl: { label: 'Link', aliases: ['url', 'link'], type: cell.text({ max: SUBSTANCE_LIMITS.url }) },
    note: { label: 'Note', aliases: ['nota'], type: cell.text({ max: SUBSTANCE_LIMITS.note }) },
  },
  keyColumns: ['key'],
  batchSize: 100,
  validateRow: (values) => ruleRowIssues(values),
  plan: (values, existing) => planRuleRow(values, existing),
})

/** A rule as the import sees it (`$record`): the substance by its CAS number or family name, the brand by its code. */
export interface ImportedRule {
  readonly key: string
  readonly code: RuleCode
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string>> | null
  readonly substance: string | null
  readonly substanceGroup: string | null
  readonly materialKinds: readonly string[]
  readonly productTypes: readonly string[]
  readonly marketCodes: readonly string[]
  readonly scopeNote: string | null
  readonly limitValue: string | null
  readonly limitUnit: SubstanceUnit | null
  readonly limitBound: LimitBound | null
  readonly testMethod: string | null
  readonly evidence: EvidenceKind
  readonly exemptPpe: boolean
  readonly exemptNaturalLeather: boolean
  readonly source: RuleSource
  readonly customer: string | null
  readonly legalReference: string
  readonly legalUrl: string | null
  readonly note: string | null
}
type RuleRecord = ImportedRule & { readonly status: SubstanceStatus; readonly foreign: boolean }

function ruleColumns(rule: ImportedRule): Record<string, CellValue | null> {
  return {
    key: rule.key,
    code: rule.code,
    name: rule.name,
    nameIt: rule.nameI18n?.it ?? null,
    nameEn: rule.nameI18n?.en ?? null,
    substance: rule.substance,
    group: rule.substanceGroup,
    materialKinds: rule.materialKinds.length > 0 ? rule.materialKinds.join(', ') : null,
    productTypes: rule.productTypes.length > 0 ? rule.productTypes.join(', ') : null,
    markets: rule.marketCodes.length > 0 ? rule.marketCodes.join(', ') : null,
    scopeNote: rule.scopeNote,
    limit: rule.limitValue,
    unit: rule.limitUnit,
    bound: rule.limitBound,
    testMethod: rule.testMethod,
    evidence: rule.evidence,
    exemptPpe: rule.exemptPpe,
    exemptNaturalLeather: rule.exemptNaturalLeather,
    source: rule.source,
    customer: rule.customer,
    legalReference: rule.legalReference,
    legalUrl: rule.legalUrl,
    note: rule.note,
  }
}

/** The values the adapter's load answers for a rule: its columns and the whole record (`$record`). */
export function ruleRecordValues(record: RuleRecord): RecordValues {
  return { ...ruleColumns(record), [RECORD]: JSON.stringify(record) }
}

function ruleRowIssues(values: RowValues): RowIssue[] {
  const issues: RowIssue[] = []
  if (typeof values.key === 'string' && !RULE_KEY.test(values.key)) issues.push({ column: 'key', message: 'A rule key is a letter or digit, then letters, digits, ".", "_" or "-", up to 80.' })
  if (typeof values.materialKinds === 'string') {
    const { unknown } = readValues(values.materialKinds, RULE_MATERIAL_KINDS, KIND_ALIASES)
    if (unknown.length > 0) issues.push({ column: 'materialKinds', message: `Not a kind of material: ${unknown.join(', ')}.` })
  }
  if (typeof values.productTypes === 'string') {
    const { unknown } = readValues(values.productTypes, RULE_PRODUCT_TYPES, TYPE_ALIASES)
    if (unknown.length > 0) issues.push({ column: 'productTypes', message: `Not a product type: ${unknown.join(', ')}.` })
  }
  if (typeof values.markets === 'string') {
    const { unknown } = marketsOf(values.markets)
    if (unknown.length > 0) issues.push({ column: 'markets', message: `Not a market code: ${unknown.join(', ')} (write "FR", "US-CA").` })
  }
  if (values.substance !== undefined && values.group !== undefined) issues.push({ column: 'group', message: 'Give the substance or the group, not both.' })
  return issues
}

/** The rule a row makes or becomes (over `current`, or nothing for a new one). */
export function ruleFromRow(values: RowValues, current: ImportedRule | null): ImportedRule {
  const base: ImportedRule = current ?? {
    key: String(values.key),
    code: 'OTHER',
    name: '',
    nameI18n: null,
    substance: null,
    substanceGroup: null,
    materialKinds: [],
    productTypes: [],
    marketCodes: [],
    scopeNote: null,
    limitValue: null,
    limitUnit: null,
    limitBound: null,
    testMethod: null,
    evidence: 'EITHER',
    exemptPpe: false,
    exemptNaturalLeather: false,
    source: 'LAW',
    customer: null,
    legalReference: '',
    legalUrl: null,
    note: null,
  }
  const text = (name: string): string | undefined => (typeof values[name] === 'string' ? (values[name] as string) : undefined)
  const nameI18n = wordsOf(values, 'nameIt', 'nameEn', base.nameI18n)
  const substance = text('substance')
  const group = text('group')
  const source = (values.source as RuleSource | undefined) ?? base.source
  return {
    key: base.key,
    code: (values.code as RuleCode | undefined) ?? base.code,
    name: text('name') ?? base.name,
    nameI18n: nameI18n === undefined ? base.nameI18n : nameI18n,
    substance: substance !== undefined ? substance.trim() : group !== undefined ? null : base.substance,
    substanceGroup: group !== undefined ? group : substance !== undefined ? null : base.substanceGroup,
    materialKinds: text('materialKinds') !== undefined ? readValues(text('materialKinds')!, RULE_MATERIAL_KINDS, KIND_ALIASES).values : base.materialKinds,
    productTypes: text('productTypes') !== undefined ? readValues(text('productTypes')!, RULE_PRODUCT_TYPES, TYPE_ALIASES).values : base.productTypes,
    marketCodes: text('markets') !== undefined ? marketsOf(text('markets')!).values : base.marketCodes,
    scopeNote: text('scopeNote') ?? base.scopeNote,
    limitValue: text('limit') ?? base.limitValue,
    limitUnit: (values.unit as SubstanceUnit | undefined) ?? base.limitUnit,
    limitBound: (values.bound as LimitBound | undefined) ?? base.limitBound,
    testMethod: text('testMethod') ?? base.testMethod,
    evidence: (values.evidence as EvidenceKind | undefined) ?? base.evidence,
    exemptPpe: typeof values.exemptPpe === 'boolean' ? values.exemptPpe : base.exemptPpe,
    exemptNaturalLeather: typeof values.exemptNaturalLeather === 'boolean' ? values.exemptNaturalLeather : base.exemptNaturalLeather,
    source,
    customer: text('customer') ?? (source === 'CUSTOMER' ? base.customer : null),
    legalReference: text('legalReference') ?? base.legalReference,
    legalUrl: text('legalUrl') ?? base.legalUrl,
    note: text('note') ?? base.note,
  }
}

const RULE_COLUMN_OF: Readonly<Record<string, string>> = { substanceId: 'substance', substanceGroup: 'group', marketCodes: 'markets', limitValue: 'limit', customerPartyId: 'customer', nameI18n: 'nameIt' }
const ruleIssues = (rule: ImportedRule): RowIssue[] =>
  ruleProblems({ ...rule, substanceId: rule.substance ? 'named' : null, customerPartyId: rule.customer ? 'named' : null }).map((issue) => {
    const head = issue.path.split('/')[1] ?? ''
    const column = RULE_COLUMN_OF[head] ?? head
    return Object.hasOwn(substanceRulesImporter.columns, column) ? { column, message: issue.message } : { message: issue.message }
  })

/** What one rule row does (the importer's `plan`): see the module comment. */
export function planRuleRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) {
    const missing = (['code', 'name', 'evidence', 'legalReference'] as const).filter((name) => values[name] === undefined)
    const issues: RowIssue[] = missing.map((name) => ({ column: name, message: `${substanceRulesImporter.columns[name].label} is needed for a new rule.` }))
    if (values.substance === undefined && values.group === undefined) issues.push({ column: 'substance', message: 'Name the substance (CAS number) or the group the new rule restricts.' })
    if (issues.length > 0) return refused(issues)
    const problems = ruleIssues(ruleFromRow(values, null))
    return problems.length > 0 ? refused(problems) : { action: 'CREATE', after: values }
  }
  const record = recordOf<RuleRecord>(existing, 'substance rules')
  if (record.foreign) return refused([{ column: 'key', message: "This key is another company's rule (or one for every company): import it with that company." }])
  if (record.status !== 'ACTIVE') return refused([{ message: 'This rule is archived: restore it before importing changes.' }])
  const next = ruleFromRow(values, record)
  const problems = ruleIssues(next)
  if (problems.length > 0) return refused(problems)
  return changes(ruleColumns(record), { ...ruleColumns(next), key: null })
}

/** The words a new rule of an import is switched off with (any source but a brand's RSL). */
export const IMPORTED_OFF_REASON = 'Imported switched off: switch it on when a style or a market needs it (Owner answer 11-09, question 5 A).'
