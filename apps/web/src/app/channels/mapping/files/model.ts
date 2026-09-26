/**
 * CHMAP (`docs/studies/channel-mappings.md` §8.7) — the File mappings view's pure helpers.
 *
 * Everything the screen SAYS about a mapping version is decided here, once, and tested: the words for
 * a requirement, a decision, a target and a transform; how versions group into forms; what each filter
 * keeps; and what a decision sends. No I/O and no React, so `model.vitest.test.ts` can hold every rule.
 *
 * The contract types come from `@nexus/shared/channel-mapping` — the same module the API builds its
 * answers with — so a field the API renames breaks this file's type check, not the screen.
 */
import type {
  MappingDiff, MappingDirection, MappingFieldRow, MappingFieldState, MappingFormKind, MappingPushImpact, MappingRequirement, MappingSetSummary,
  MappingTargetKind, MappingTransform,
} from '@nexus/shared/channel-mapping'
import type { ActionFinding, ActionReview } from '@/design-system/grid'

/* ── words ──────────────────────────────────────────────────────────────────────────────────────── */

export const CHANNEL_LABEL: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay' }
export const channelLabel = (channel: string) => CHANNEL_LABEL[channel] ?? channel

const FORM_KIND_WORD: Record<MappingFormKind, (formKey: string) => string> = {
  AMAZON_TEMPLATE: key => `${productTypesWord(key)} template`,
  AMAZON_FLAT_FILE: key => `${productTypesWord(key)} flat file (old format)`,
  EBAY_WORKBOOK: key => `category ${key} workbook`,
}
const productTypesWord = (formKey: string) => formKey.split('+').filter(Boolean).join(' + ') || formKey

/** "Amazon IT · COAT + PANTS template" — one channel file form in one market. */
export function formLabel(s: Pick<MappingSetSummary, 'channel' | 'marketplace' | 'formKind' | 'formKey'>): string {
  const kind = FORM_KIND_WORD[s.formKind]?.(s.formKey) ?? `${s.formKind} ${s.formKey}`
  return `${channelLabel(s.channel)} ${s.marketplace} · ${kind}`
}

export const STATUS_WORD = { ACTIVE: 'Active', DRAFT: 'Draft', RETIRED: 'Retired' } as const
export const STATUS_TONE = { ACTIVE: 'success', DRAFT: 'info', RETIRED: 'neutral' } as const

/** The channel schema's requirement, in plain words. `null` = the channel states none for this column. */
export function requirementWord(requirement: MappingRequirement | string | null | undefined): string {
  switch (requirement) {
    case 'required': return 'Required'
    case 'requiredIfRelevant': return 'Required if relevant'
    case 'bestPractice': return 'Best practice'
    case 'optional': return 'Optional'
    case null: case undefined: case '': return 'Not stated'
    default: return String(requirement)
  }
}

export const STATE_WORD: Record<MappingFieldState, string> = {
  mapped: 'Mapped', ignored: 'Ignored', managed: 'Managed elsewhere', unmapped: 'Unmapped',
}

/** The tone of a decision pill. An open REQUIRED column is the one thing that blocks activation. */
export function stateTone(row: Pick<MappingFieldRow, 'state' | 'requirement'>): 'success' | 'neutral' | 'info' | 'warning' | 'danger' {
  if (row.requirement === 'required' && (row.state === 'unmapped' || row.state === 'ignored')) return 'danger'
  return row.state === 'mapped' ? 'success' : row.state === 'managed' ? 'info' : row.state === 'unmapped' ? 'warning' : 'neutral'
}

/** Another Nexus workflow that owns a column (the "door"): named on a managed row. */
const WORKFLOW_WORD: Partial<Record<MappingTargetKind, string>> = {
  price: 'price', sale: 'sale price', currency: 'currency', quantity: 'quantity',
  relationship: 'relationship', identifier: 'identifier', image: 'images',
}

/**
 * Where a column lands, in the screen's words: "Channel field · item_name", "Item specific · team name",
 * "Price door", "Managed · quantity". A column that is ignored or unmapped has no target.
 */
export function targetLabel(row: Pick<MappingFieldRow, 'state' | 'targetKind' | 'targetKey'>, channel?: string): string {
  if (row.state === 'managed') {
    const owner = WORKFLOW_WORD[row.targetKind]
    return owner ? `Managed · ${owner}` : 'Managed elsewhere'
  }
  if (row.state !== 'mapped') return 'No target'
  const key = row.targetKey
  const keyed = (word: string) => (key ? `${word} · ${key}` : word)
  switch (row.targetKind) {
    case 'identity': return 'SKU (row identity)'
    case 'productType': return channel === 'EBAY' ? 'Category' : 'Product type'
    case 'recordAction': return 'Record action'
    case 'channelField': return keyed('Channel field')
    case 'itemSpecific': return keyed('Item specific')
    case 'selector': return keyed('Selector')
    case 'price': return 'Price door'
    case 'sale': return 'Sale price door'
    case 'currency': return 'Currency (price door)'
    case 'quantity': return 'Stock'
    case 'relationship': return 'Parent–child relationship'
    case 'identifier': return keyed('Identifier')
    case 'image': return keyed('Image')
    case 'none': return 'No target'
    default: return keyed(String(row.targetKind))
  }
}

function transformWord(t: MappingTransform): string {
  switch (t.op) {
    case 'copy': return 'copy'
    case 'dictionary': {
      const details = [
        t.write === 'code' ? 'writes Amazon’s codes' : null,
        t.prefer && Object.keys(t.prefer).length
          ? `keeps the file’s labels for ${Object.keys(t.prefer).length} code${Object.keys(t.prefer).length === 1 ? '' : 's'}` : null,
      ].filter(Boolean)
      return details.length ? `dictionary (${details.join('; ')})` : 'dictionary'
    }
    case 'list': return t.slot != null ? `list slot ${t.slot}` : t.join != null ? `list joined by “${t.join}”` : 'list'
    case 'measure': return t.part === 'unit' ? 'measure unit' : 'measure value'
    case 'number': return 'number'
    case 'boolean': return 'yes/no'
    case 'date': return 'date'
    case 'constant': return `constant “${t.value}”`
    default: return String((t as { op: unknown }).op)
  }
}

/** "dictionary · list slot 2". Empty when the value is carried as it is. */
export function transformSummary(transform: readonly MappingTransform[] | null | undefined): string {
  return (transform ?? []).map(transformWord).join(' · ')
}

export const DECIDED_BY_WORD = { rule: 'Rule', owner: 'Owner' } as const

/** A column's direction in the Owner's words. Several columns sharing one field: one writes back, the rest are read. */
export const DIRECTION_WORD: Record<MappingDirection, string> = {
  both: 'Read and write back', in: 'Read on import only', out: 'Write on export only',
}
export const DIRECTIONS: readonly MappingDirection[] = ['both', 'in', 'out']

/** The other MAPPED columns of this version that carry the same target, and which of them write it back. */
export function sharedTarget(fields: readonly MappingFieldRow[], row: Pick<MappingFieldRow, 'channelKey' | 'targetKind' | 'targetKey'>, targetKey = row.targetKey) {
  if (!targetKey) return { others: [] as MappingFieldRow[], writers: [] as MappingFieldRow[] }
  const others = fields.filter(f => f.channelKey !== row.channelKey && f.state === 'mapped' && f.targetKind === row.targetKind && f.targetKey === targetKey)
  return { others, writers: others.filter(f => f.direction !== 'in') }
}

/* ── locked rows ────────────────────────────────────────────────────────────────────────────────── */

const LOCKED_KINDS = new Set<MappingTargetKind>(['identity', 'productType', 'recordAction'])
/** The server's own sentence (`store.ts` `decideField`), so the screen and a refusal say the same thing. */
export const LOCKED_REASON = 'The SKU, product-type and action columns are read by every import; their meaning cannot change.'
export const isLocked = (row: Pick<MappingFieldRow, 'targetKind'>) => LOCKED_KINDS.has(row.targetKind)

/* ── versions, grouped by form ──────────────────────────────────────────────────────────────────── */

export const formKeyOf = (s: Pick<MappingSetSummary, 'channel' | 'marketplace' | 'formKind' | 'formKey'>) =>
  `${s.channel}|${s.marketplace}|${s.formKind}|${s.formKey}`

export interface FormGroup { key: string; label: string; versions: MappingSetSummary[] }

/** One group per form, in channel · market · form order; versions newest first. */
export function groupByForm(sets: readonly MappingSetSummary[]): FormGroup[] {
  const groups = new Map<string, FormGroup>()
  for (const s of sets) {
    const key = formKeyOf(s)
    const group = groups.get(key) ?? { key, label: formLabel(s), versions: [] }
    group.versions.push(s)
    groups.set(key, group)
  }
  const out = [...groups.values()]
  for (const g of out) g.versions.sort((a, b) => b.version - a.version)
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

export function filterSets(sets: readonly MappingSetSummary[], filter: { channel: string; market: string }): MappingSetSummary[] {
  return sets.filter(s => (!filter.channel || s.channel === filter.channel) && (!filter.market || s.marketplace === filter.market))
}

/** The markets present in the list (for the market filter), optionally within one channel. */
export function marketsOf(sets: readonly MappingSetSummary[], channel = ''): string[] {
  return [...new Set(sets.filter(s => !channel || s.channel === channel).map(s => s.marketplace))].sort()
}

/** The other versions of the same form — what "Compare with…" offers. */
export function siblingsOf(set: MappingSetSummary, sets: readonly MappingSetSummary[]): MappingSetSummary[] {
  const key = formKeyOf(set)
  return sets.filter(s => s.id !== set.id && formKeyOf(s) === key).sort((a, b) => b.version - a.version)
}

/** "v2", or "Amazon DE · COAT template v1" when a version was copied from another form or market. */
export function versionName(of: MappingSetSummary, from?: Pick<MappingSetSummary, 'channel' | 'marketplace' | 'formKind' | 'formKey'>): string {
  return from && formKeyOf(from) === formKeyOf(of) ? `v${of.version}` : `${formLabel(of)} v${of.version}`
}

/* ── the column filters ─────────────────────────────────────────────────────────────────────────── */

export const FIELD_FILTERS = ['all', 'unmapped', 'required', 'ignored', 'managed', 'changed'] as const
export type FieldFilter = (typeof FIELD_FILTERS)[number]

/** The columns that differ from the version this one was copied from: added, requirement or decision changed. */
export function changedKeys(diff: MappingDiff | null | undefined): Set<string> {
  if (!diff) return new Set()
  return new Set([...diff.added, ...diff.requirementChanged.map(c => c.channelKey), ...diff.decisionChanged.map(c => c.channelKey)])
}

export function matchesFilter(row: MappingFieldRow, filter: FieldFilter, changed: ReadonlySet<string>): boolean {
  switch (filter) {
    case 'all': return true
    case 'unmapped': return row.state === 'unmapped'
    case 'required': return row.requirement === 'required'
    case 'ignored': return row.state === 'ignored'
    case 'managed': return row.state === 'managed'
    case 'changed': return changed.has(row.channelKey)
  }
}

/** Case-insensitive search over the channel key, the file's header, the label, the aliases and the target. */
export function matchesSearch(row: MappingFieldRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [row.channelKey, row.columnKey, row.label, row.targetKey, ...row.aliases]
    .some(v => typeof v === 'string' && v.toLowerCase().includes(q))
}

export function filterRows(rows: readonly MappingFieldRow[], filter: FieldFilter, query: string, changed: ReadonlySet<string>): MappingFieldRow[] {
  return rows.filter(r => matchesFilter(r, filter, changed) && matchesSearch(r, query))
}

/** How many rows each filter keeps (before the text search), for the chip counts. */
export function filterCounts(rows: readonly MappingFieldRow[], changed: ReadonlySet<string>): Record<FieldFilter, number> {
  const counts = Object.fromEntries(FIELD_FILTERS.map(f => [f, 0])) as Record<FieldFilter, number>
  for (const r of rows) for (const f of FIELD_FILTERS) if (matchesFilter(r, f, changed)) counts[f]++
  return counts
}

/** One page of rows; `page` is 1-based and clamped into range. */
export function pageOf<T>(rows: readonly T[], page: number, pageSize: number): { rows: T[]; page: number; pageCount: number; from: number; to: number } {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const at = Math.min(Math.max(1, page), pageCount)
  const start = (at - 1) * pageSize
  const slice = rows.slice(start, start + pageSize)
  return { rows: slice, page: at, pageCount, from: slice.length ? start + 1 : 0, to: start + slice.length }
}

/* ── a decision ─────────────────────────────────────────────────────────────────────────────────── */

/** What the Owner picks in the decision drawer. `current` = keep a mapping this screen cannot author (a price door, a selector…). */
export type DecisionChoice = 'field' | 'specific' | 'ignored' | 'managed' | 'unmapped' | 'current'

export interface DecisionDraft { choice: DecisionChoice; targetKey: string; specificName: string; reason: string; direction: MappingDirection }

export interface DecisionBody {
  channelKey: string
  state: MappingFieldState
  targetKind?: MappingTargetKind
  targetKey?: string | null
  reason?: string | null
  direction?: MappingDirection
}

/** A decision that maps the column (and so has a direction). */
export const choiceMaps = (choice: DecisionChoice) => choice === 'field' || choice === 'specific' || choice === 'current'

/** The choice a row opens on: what it is today. */
export function initialDraft(row: MappingFieldRow): DecisionDraft {
  const base = { targetKey: '', specificName: '', reason: row.reason ?? '', direction: row.direction }
  if (row.state === 'ignored') return { ...base, choice: 'ignored' }
  if (row.state === 'managed') return { ...base, choice: 'managed' }
  if (row.state === 'unmapped') return { ...base, choice: 'unmapped' }
  if (row.targetKind === 'channelField') return { ...base, choice: 'field', targetKey: row.targetKey ?? '' }
  if (row.targetKind === 'itemSpecific') return { ...base, choice: 'specific', specificName: row.targetKey ?? '' }
  return { ...base, choice: 'current' }
}

/**
 * The PATCH body for a draft, or the reason it cannot be sent yet. The server re-checks every rule;
 * this only stops a request the server would refuse for a reason the operator can already see.
 * `null` body with no problem = nothing changed.
 */
export function decisionBody(row: MappingFieldRow, draft: DecisionDraft): { body: DecisionBody | null; problem: string | null } {
  const channelKey = row.channelKey
  const reason = draft.reason.trim()
  const sameReason = (row.reason ?? '') === reason
  // A mapped decision carries its direction and its (optional) note; the server keeps the target it is not sent.
  const mapped = (extra: Partial<DecisionBody>, sameTarget: boolean) => {
    if (sameTarget && row.state === 'mapped' && row.direction === draft.direction && sameReason) return { body: null, problem: null }
    return { body: { channelKey, state: 'mapped' as const, ...extra, reason: reason || null, direction: draft.direction }, problem: null }
  }
  switch (draft.choice) {
    case 'current': return mapped({}, true)
    case 'field': {
      const targetKey = draft.targetKey.trim()
      if (!targetKey) return { body: null, problem: 'Choose the field this column maps to.' }
      return mapped({ targetKind: 'channelField', targetKey }, row.targetKind === 'channelField' && row.targetKey === targetKey)
    }
    case 'specific': {
      const targetKey = draft.specificName.trim()
      if (!targetKey) return { body: null, problem: 'Name the item specific.' }
      return mapped({ targetKind: 'itemSpecific', targetKey }, row.targetKind === 'itemSpecific' && row.targetKey === targetKey)
    }
    case 'ignored':
    case 'managed': {
      if (!reason) return { body: null, problem: 'Say why: the reason is shown on every import that skips this column.' }
      if (row.state === draft.choice && sameReason) return { body: null, problem: null }
      return { body: { channelKey, state: draft.choice, reason }, problem: null }
    }
    case 'unmapped':
      if (row.state === 'unmapped') return { body: null, problem: null }
      return { body: { channelKey, state: 'unmapped' }, problem: null }
  }
}

/** A short past-tense line for the toast after a decision is saved. */
export function decisionSentence(row: Pick<MappingFieldRow, 'label' | 'channelKey'>, body: DecisionBody): string {
  const name = row.label ?? row.channelKey
  const how = body.direction ? ` (${DIRECTION_WORD[body.direction].toLowerCase()})` : ''
  if (body.state === 'mapped' && !body.targetKey) return `${name} is saved${how}.`
  if (body.state === 'mapped') return `${name} now maps to ${body.targetKind === 'itemSpecific' ? 'item specific' : 'field'} ${body.targetKey}${how}.`
  if (body.state === 'ignored') return `${name} is ignored.`
  if (body.state === 'managed') return `${name} is managed elsewhere.`
  return `${name} is unmapped.`
}

/* ── recent uses ────────────────────────────────────────────────────────────────────────────────── */

export const USE_WORD: Record<string, string> = { IMPORT: 'Import', EXPORT: 'Export', PUSH: 'Push' }

/** A counter recorded with a use (`rows`, `excluded`, `refused`), or null when the use did not record it. */
export function useCount(detail: unknown, key: string): number | null {
  if (!detail || typeof detail !== 'object') return null
  const v = (detail as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/* ── export ─────────────────────────────────────────────────────────────────────────────────────── */

/** Why a version cannot export, or null when it can (the server re-checks). */
export function exportBlocker(set: Pick<MappingSetSummary, 'status' | 'formKind' | 'version'>): string | null {
  if (set.formKind === 'AMAZON_FLAT_FILE') return 'Old Amazon flat files are read only; export with a current template version.'
  if (set.status !== 'ACTIVE') return `Only an active version exports. Activate v${set.version} first.`
  return null
}

/** The SKUs typed into the export drawer: one per line or comma separated, trimmed, each once, in order. */
export function parseSkus(text: string): string[] {
  return [...new Set(text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean))]
}

export interface ExportSummary { rows: number; gaps: number; blankColumns: number; mapping: string }

/** `X-Nexus-Export-Summary`: URL-encoded JSON. Null when absent or not the expected shape — never a guess. */
export function parseExportSummary(header: string | null | undefined): ExportSummary | null {
  if (!header) return null
  try {
    const v = JSON.parse(decodeURIComponent(header)) as Record<string, unknown>
    const n = (k: string) => (typeof v[k] === 'number' && Number.isFinite(v[k]) ? (v[k] as number) : null)
    const rows = n('rows'), gaps = n('gaps'), blankColumns = n('blankColumns')
    if (rows == null || gaps == null || blankColumns == null || typeof v.mapping !== 'string') return null
    return { rows, gaps, blankColumns, mapping: v.mapping }
  } catch { return null }
}

const plural = (n: number, one: string, many: string, fmt: (n: number) => string) => `${fmt(n)} ${n === 1 ? one : many}`

/** "12 rows written with Amazon IT · COAT+PANTS · v3 (active). 4 required cells had no value in Nexus; 21 columns left blank on purpose." */
export function exportSummarySentence(s: ExportSummary, fmt: (n: number) => string = String): string {
  return `${plural(s.rows, 'row', 'rows', fmt)} written with ${s.mapping}. `
    + `${plural(s.gaps, 'required cell', 'required cells', fmt)} had no value in Nexus; ${plural(s.blankColumns, 'column', 'columns', fmt)} left blank on purpose.`
}

/** The file name a `Content-Disposition` header names (RFC 5987 `filename*` first), or null. */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) } catch { /* fall through */ } }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header)
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim()
  return name || null
}

/** The export refusals that an uploaded Amazon template answers (the server's own sentences, `amazon-export-host.ts`). */
export const needsTemplateUpload = (message: string) =>
  /does not hold the Amazon template|Upload the template again|Upload the template this version was made from/.test(message)

/* ── template upload ────────────────────────────────────────────────────────────────────────────── */

export interface TemplateUploadResult {
  setId: string; version: number; status: string; label: string; created: boolean; templateVersion: string | null; warnings: string[]
}

/** "Template 2026.0715 stored; it reads with Amazon DE · COAT+PANTS · v2 (draft)." */
export function templateResultSentence(t: Pick<TemplateUploadResult, 'templateVersion' | 'label' | 'created'>): string {
  return `Template ${t.templateVersion ?? '(version not stated)'} stored; it reads with ${t.label}.${t.created ? ' That version is new: review it before activating.' : ''}`
}

/* ── activation: what the push sends ───────────────────────────────────────────────────────────── */

/** An Amazon attribute with the template's own label when a column carries it (`Colore (color)`); eBay names stay. */
function pushFieldName(fields: readonly Pick<MappingFieldRow, 'targetKind' | 'targetKey' | 'label'>[], name: string): string {
  const row = fields.find(f => f.targetKind === 'channelField' && f.label && f.targetKey?.split('__')[0] === name)
  return row ? `${row.label} (${name})` : name
}

/**
 * The Activate confirmation's difference list (CHMAP M4): which fields the next publish to this channel and market starts
 * or stops sending, and the Owner's stops the push cannot follow. `null` = the check failed: that is said, never guessed.
 */
export function pushImpactReview(set: Pick<MappingSetSummary, 'channel' | 'marketplace'> & { fields: readonly Pick<MappingFieldRow, 'targetKind' | 'targetKey' | 'label'>[] },
  impact: MappingPushImpact | null, failure?: string): { consequences: string[]; review?: ActionReview; findings: ActionFinding[] } {
  const where = `${channelLabel(set.channel)} ${set.marketplace}`
  if (!impact) return { consequences: [], findings: [{ label: `What Nexus sends to ${where}${failure ? ` (${failure})` : ''}`, severity: 'unknown' }] }
  const findings: ActionFinding[] = impact.kept.map(k => ({ label: `Still sent: ${k}`, severity: 'warn' }))
  if (!impact.stops.length && !impact.starts.length) return { consequences: [`What Nexus sends to ${where} does not change.`], findings }
  const rows = [...impact.stops.map(s => ({ label: pushFieldName(set.fields, s), before: 'Sent', after: 'Not sent' })),
    ...impact.starts.map(s => ({ label: pushFieldName(set.fields, s), before: 'Not sent', after: 'Sent' }))]
  return {
    consequences: [`The next publish to ${where} changes for ${impact.listings} listing${impact.listings === 1 ? '' : 's'} of this form.`, impact.note],
    review: { title: `What Nexus sends to ${where}`, rows },
    findings,
  }
}
