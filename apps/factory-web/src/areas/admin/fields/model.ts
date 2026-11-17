import { GRAINS, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { FIELD_CODE, FIELD_LIMITS, FIELD_TYPES, OPTION_CODE, PICKING_TYPES, type FieldAudience, type FieldType } from '@nexus/factory-domain/fields/rules'
import { CUSTOMER_FIELD_RECORD_KEYS } from '@nexus/factory-domain/fields/access' // B-TH-242
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import { RECORD_KEYS, type EditorField, type Field, type FieldChange, type ListValue, type NewFieldBody, type NewValueBody, type Picklist, type RecordKey } from './api'

/**
 * Admin › Fields & lists (B-W2b-431, SCR-164; design admin.fields), pure: the address, the field draft of "Add field to …"
 * and what it sends, why a button waits (message keys of the `admin-fields` catalogue: `wait.*`), the API's refusals in
 * our words (`fault.*`), the grid's order and moves, the form preview's sections, and the list values' drafts. The rules
 * themselves are factory-domain fields/rules (B-W2b-421): the screen says them before the API would refuse the same.
 *
 * Keys never start with an Admin prefix (`problem.`, `held.`, `list.`, `record.`, `status.`, `form.` …): the Admin key
 * test reads those as `admin` keys.
 */

export const FIELDS_NS = 'admin-fields'

// ── the address ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The tabs of the design's segmented control; Statuses, Tags and Validation are W3 (held with when). */
export const TABS = ['fields', 'picklists', 'statuses', 'tags', 'validation'] as const
export type FieldsTab = (typeof TABS)[number]
export const BUILT_TABS: ReadonlySet<FieldsTab> = new Set(['fields', 'picklists'])

export interface FieldsAddress {
  /** The record type (`?type=ORDER`); null: the API's first. */
  type: RecordKey | null
  tab: 'fields' | 'picklists'
  /** The list shown on Picklists (`?list=<id>`); null: the first. */
  list: string | null
  /** The field dialog (`?field=<id>` or `new`). */
  field: string | null
  /** Archived fields shown too (`?archived=1`). */
  archived: boolean
}

const isRecordKey = (value: string | null): value is RecordKey => value !== null && (RECORD_KEYS as readonly string[]).includes(value)

export function addressOf(search: { get(name: string): string | null }): FieldsAddress {
  const type = search.get('type')
  const tab = search.get('tab')
  return {
    type: isRecordKey(type) ? type : null,
    tab: tab === 'picklists' ? 'picklists' : 'fields',
    list: search.get('list') || null,
    field: search.get('field') || null,
    archived: search.get('archived') === '1',
  }
}

/** The page's query (`?type=ORDER&tab=picklists&list=…`), the defaults left out. */
export function fieldsQuery(address: FieldsAddress): string {
  const query = new URLSearchParams()
  if (address.type) query.set('type', address.type)
  if (address.tab !== 'fields') query.set('tab', address.tab)
  if (address.tab === 'picklists' && address.list) query.set('list', address.list)
  if (address.field) query.set('field', address.field)
  if (address.archived) query.set('archived', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

// ── words ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const labelIn = (thing: { readonly labelIt: string; readonly labelEn: string }, locale: Locale): string => (locale === 'it' ? thing.labelIt : thing.labelEn)

/** A section code in words: `custom` has its own words (`section.custom`), another code reads as written (`fit_notes` → "Fit notes"). */
export function sectionText(code: string): string | null {
  if (code === 'custom') return null
  const text = code.replace(/_/g, ' ').trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The record types whose partners read the fields shown in the portal (factory-api platform/fields/records.ts `portal`). */
export const PORTAL_RECORDS: ReadonlySet<RecordKey> = new Set(['CUSTOMER', 'SUPPLIER', 'QUOTE', 'ORDER', 'PURCHASE_ORDER'])

/** The grains the person holds (`money.<grain>` in the session's permissions). */
export const grainsOf = (permissions: readonly string[]): ReadonlySet<Grain> => new Set(GRAINS.filter((grain) => permissions.includes(`money.${grain}`)))

/** Who sees a field, as one key: `audience.INTERNAL`, `audience.MONEY` (with the grain's words beside it), `audience.PERSONAL`. */
export const audienceKey = (audience: FieldAudience): string => `audience.${audience}`

// ── the field draft ("Add field to …" and a field's dialog) ──────────────────────────────────────────────────────────

export interface FieldDraft {
  type: FieldType | null
  code: string
  /** The key was typed by hand: the English label no longer writes it. */
  codeTyped: boolean
  labelIt: string
  labelEn: string
  section: string
  required: boolean
  unit: string
  audience: FieldAudience
  grain: Grain | null
  shownInPortal: boolean
  picklistId: string | null
  linkTo: RecordKey | null
  /** Whose field: null = every company. */
  companyId: string | null
  // ── B-TH-242 (threads plan TH-4, SHEET-G06, X-ADM-FIELDS.dialog-F01): for every customer, or for one customer only ──
  /** "For: every customer · one customer". */
  forCustomer: 'every' | 'one'
  /** The one customer (null until picked; always null for every customer). */
  partyId: string | null
  /** Its name, as the picker or the field's line read it (for the dialog's words only; never sent). */
  partyName: string | null
  // ── end B-TH-242 ──
}

export const newDraft = (section = 'custom'): FieldDraft => ({
  type: null,
  code: '',
  codeTyped: false,
  labelIt: '',
  labelEn: '',
  section,
  required: false,
  unit: '',
  audience: 'INTERNAL',
  grain: null,
  shownInPortal: false,
  picklistId: null,
  linkTo: null,
  companyId: null,
  forCustomer: 'every', // B-TH-242
  partyId: null,
  partyName: null,
})

export const draftOfField = (field: Field): FieldDraft => ({
  type: field.type,
  code: field.code,
  codeTyped: true,
  labelIt: field.labelIt,
  labelEn: field.labelEn,
  section: field.section,
  required: field.required,
  unit: field.unit ?? '',
  audience: field.audience,
  grain: field.grain,
  shownInPortal: field.shownInPortal,
  picklistId: field.picklist?.id ?? null,
  linkTo: field.linkRecordType,
  companyId: field.companyId,
  // B-TH-242: a field's customer never changes (shown fixed in its dialog).
  forCustomer: field.partyId ? 'one' : 'every',
  partyId: field.partyId,
  partyName: 'partyName' in field ? ((field as EditorField).partyName ?? null) : null,
})

/** A key from a label: lower-case letters, digits and underscores from a letter (`Heat number` → `heat_number`). */
export function codeFrom(label: string): string {
  const folded = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
  return folded.slice(0, 40).replace(/_+$/, '')
}

/** What typing a key leaves: lower-case, spaces as underscores, nothing else. */
export const typedCode = (text: string): string => text.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 40)
/** What typing a list value's code leaves: upper-case letters, digits and underscores. */
export const typedValueCode = (text: string): string => text.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '').slice(0, 40)

/** The draft after one change: a new type sets what it needs (a money field is seen with a grain), the label writes the key. */
export function withDraft(draft: FieldDraft, patch: Partial<FieldDraft>, grains: ReadonlySet<Grain>): FieldDraft {
  const next = { ...draft, ...patch }
  if (patch.type !== undefined && patch.type !== draft.type) {
    if (patch.type === 'MONEY') next.audience = 'MONEY'
    else if (draft.type === 'MONEY') next.audience = 'INTERNAL'
    if (next.audience === 'MONEY' && next.grain === null) next.grain = [...grains][0] ?? null
    if (next.audience !== 'MONEY') next.grain = null
    if (patch.type !== 'NUMBER') next.unit = ''
    if (patch.type === null || !PICKING_TYPES.includes(patch.type)) next.picklistId = null
    if (patch.type !== 'LINK') next.linkTo = null
  }
  if (patch.audience !== undefined) {
    if (patch.audience === 'MONEY' && next.grain === null) next.grain = [...grains][0] ?? null
    if (patch.audience !== 'MONEY') next.grain = null
  }
  // B-TH-242: back to every customer drops the customer picked.
  if (patch.forCustomer === 'every') {
    next.partyId = null
    next.partyName = null
  }
  if (patch.labelEn !== undefined && !next.codeTyped) next.code = codeFrom(patch.labelEn)
  if (patch.code !== undefined) next.codeTyped = true
  if (portalHeld(next, true) !== null) next.shownInPortal = false
  return next
}

/** Why "Show in the portal" waits: a record type partners never read, personal data, a cost or pay. */
export function portalHeld(draft: Pick<FieldDraft, 'audience' | 'grain'>, portalRecord: boolean): string | null {
  if (!portalRecord) return 'wait.portalRecord'
  if (draft.audience === 'PERSONAL') return 'wait.portalPersonal'
  if (draft.audience === 'MONEY' && draft.grain !== 'price') return 'wait.portalMoney'
  return null
}

export interface DraftContext {
  /** The field being changed (null: a new one). */
  editing: Field | null
  /** The record type's keys already taken (archived fields keep theirs). */
  codes: readonly string[]
  grains: ReadonlySet<Grain>
  picklists: readonly Picklist[]
  busy: boolean
}

/** Why the dialog's primary waits (a message key), or null. The API checks the same again. */
export function draftHeld(draft: FieldDraft, context: DraftContext): string | null {
  if (context.busy) return 'wait.busy'
  if (draft.type === null) return 'wait.type'
  if (!context.editing) {
    if (!FIELD_CODE.test(draft.code)) return 'wait.code'
    if (context.codes.includes(draft.code)) return 'wait.codeTaken'
  }
  if (draft.labelIt.trim() === '') return 'wait.labelIt'
  if (draft.labelEn.trim() === '') return 'wait.labelEn'
  if (draft.labelIt.trim().length > FIELD_LIMITS.label || draft.labelEn.trim().length > FIELD_LIMITS.label) return 'wait.labelLong'
  if (!FIELD_CODE.test(draft.section)) return 'wait.section'
  if (draft.type === 'NUMBER' && draft.unit.trim().length > FIELD_LIMITS.unit) return 'wait.unit'
  if (draft.audience === 'MONEY') {
    if (draft.grain === null) return context.grains.size === 0 ? 'wait.noGrain' : 'wait.grain'
    if (!context.grains.has(draft.grain)) return 'wait.grainNotHeld'
  }
  if (!context.editing && PICKING_TYPES.includes(draft.type)) {
    if (!context.picklists.some((list) => list.status === 'ACTIVE')) return 'wait.noList'
    if (draft.picklistId === null) return 'wait.list'
  }
  if (!context.editing && draft.type === 'LINK' && draft.linkTo === null) return 'wait.linkTo'
  // B-TH-242: "For: one customer" waits for the customer.
  if (!context.editing && draft.forCustomer === 'one' && draft.partyId === null) return 'wait.customer'
  if (context.editing && fieldChangeOf(context.editing, draft) === null) return 'wait.nothingChanged'
  return null
}

/** POST /fields: what "Add field" sends. */
export function newFieldBody(recordType: RecordKey, draft: FieldDraft): NewFieldBody {
  const type = draft.type ?? 'TEXT'
  return {
    recordType,
    companyId: draft.companyId,
    code: draft.code,
    type,
    labelIt: draft.labelIt.trim(),
    labelEn: draft.labelEn.trim(),
    section: draft.section,
    required: draft.required,
    unit: type === 'NUMBER' && draft.unit.trim() !== '' ? draft.unit.trim() : null,
    audience: type === 'MONEY' ? 'MONEY' : draft.audience,
    grain: type === 'MONEY' || draft.audience === 'MONEY' ? draft.grain : null,
    shownInPortal: draft.shownInPortal,
    picklistId: PICKING_TYPES.includes(type) ? draft.picklistId : null,
    linkTo: type === 'LINK' ? draft.linkTo : null,
    // B-TH-242: only on a record type whose records name their customer; for every customer: null.
    partyId: customerChoiceOn(recordType) && draft.forCustomer === 'one' ? draft.partyId : null,
  }
}

/** PATCH /fields/:id: only what changed (type, key, list, link and company never change), or null when nothing did. */
export function fieldChangeOf(field: Field, draft: FieldDraft): FieldChange | null {
  const change: FieldChange = { version: field.version }
  if (draft.labelIt.trim() !== field.labelIt) change.labelIt = draft.labelIt.trim()
  if (draft.labelEn.trim() !== field.labelEn) change.labelEn = draft.labelEn.trim()
  if (draft.section !== field.section) change.section = draft.section
  if (draft.required !== field.required) change.required = draft.required
  const unit = field.type === 'NUMBER' && draft.unit.trim() !== '' ? draft.unit.trim() : null
  if (unit !== field.unit) change.unit = unit
  if (draft.audience !== field.audience) change.audience = draft.audience
  const grain = draft.audience === 'MONEY' ? draft.grain : null
  if (grain !== field.grain) change.grain = grain
  if (draft.shownInPortal !== field.shownInPortal) change.shownInPortal = draft.shownInPortal
  return Object.keys(change).length > 1 ? change : null
}

// ── the API's refusals in our words ──────────────────────────────────────────────────────────────────────────────────

const PATH_FAULTS: Readonly<Record<string, string>> = {
  'body/code': 'fault.code',
  'body/labelIt': 'fault.labelIt',
  'body/labelEn': 'fault.labelEn',
  'body/section': 'fault.section',
  'body/unit': 'fault.unit',
  'body/audience': 'fault.audience',
  'body/grain': 'fault.grain',
  'body/shownInPortal': 'fault.portal',
  'body/picklistId': 'fault.list',
  'body/linkTo': 'fault.linkTo',
  'body/colour': 'fault.colour',
  'body/icon': 'fault.icon',
  'body/description': 'fault.description',
}

/** A refused or failed write in our words (a key of `fault.*`); `unknown`: no answer came, the write may have landed. */
export function faultOf(error: unknown): { key: string; unknown: boolean } {
  if (!isApiError(error)) return { key: 'fault.failed', unknown: false }
  const issues = error.issues.map((issue) => ({ path: issuePath(issue).replace(/\./g, '/'), message: issue.message ?? '' }))
  const at = (path: string) => issues.find((issue) => issue.path === path || issue.path.startsWith(`${path}/`))
  switch (error.kind) {
    case 'conflict': {
      if (at('version') || at('body/fields') || at('body/values')) return { key: 'fault.stale', unknown: false }
      const code = at('body/code')
      if (code) return { key: code.message === 'taken, inactive' ? 'fault.valueTakenInactive' : code.message === 'full' ? 'fault.listFull' : 'fault.codeTaken', unknown: false }
      if (at('body/recordType')) return { key: 'fault.typeFull', unknown: false }
      const status = at('body/status')
      if (status) return { key: status.message === 'in use' ? 'fault.listInUse' : status.message === 'full' ? 'fault.typeFull' : 'fault.restoreList', unknown: false }
      if (at('body/picklistId')) return { key: 'fault.listGone', unknown: false }
      if (at('refusal/ARCHIVED')) return { key: 'fault.listArchived', unknown: false }
      if (at('refusal/FIELDS')) return { key: 'fault.database', unknown: false }
      return { key: 'fault.stale', unknown: false }
    }
    case 'invalid': {
      for (const issue of issues) {
        const key = PATH_FAULTS[issue.path]
        if (key) return { key, unknown: false }
      }
      return { key: 'fault.invalid', unknown: false }
    }
    case 'forbidden':
      return { key: 'fault.forbidden', unknown: false }
    case 'step_up':
      return { key: 'fault.stepUp', unknown: false }
    case 'not_found':
      return { key: 'fault.gone', unknown: false }
    case 'signed_out':
      return { key: 'fault.signedOut', unknown: false }
    case 'rate_limited':
      return { key: 'fault.rateLimited', unknown: false }
    case 'unavailable':
      return { key: 'fault.offline', unknown: error.code === 'network' }
    default:
      return { key: 'fault.failed', unknown: false }
  }
}

/** A failed read in our words (`fault.read*`). */
export function readFaultOf(error: unknown): string {
  if (!isApiError(error)) return 'fault.read'
  if (error.kind === 'forbidden') return 'fault.readForbidden'
  if (error.kind === 'unavailable') return 'fault.offline'
  if (error.kind === 'signed_out') return 'fault.signedOut'
  return 'fault.read'
}

// ── the fields grid ──────────────────────────────────────────────────────────────────────────────────────────────────

/** By section (in the order the sections first come), then place, then key. */
export function sortedFields<T extends Pick<Field, 'section' | 'sortOrder' | 'code'>>(fields: readonly T[]): T[] {
  const first = new Map<string, number>()
  for (const field of fields) first.set(field.section, Math.min(first.get(field.section) ?? Number.POSITIVE_INFINITY, field.sortOrder))
  return [...fields].sort((a, b) => {
    if (a.section !== b.section) return (first.get(a.section)! - first.get(b.section)!) || (a.section < b.section ? -1 : 1)
    return a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : 1)
  })
}

/** The rows shown: archived ones only when asked, then the search over key, labels and section. */
export function shownFields(fields: readonly EditorField[], options: { archived: boolean; query: string }): EditorField[] {
  const words = options.query.trim().toLowerCase()
  return sortedFields(fields).filter((field) => {
    if (!options.archived && field.status === 'ARCHIVED') return false
    if (!words) return true
    return [field.code, field.labelIt, field.labelEn, field.section].some((text) => text.toLowerCase().includes(words))
  })
}

/** The sections of a record type's active fields (for the dialog's pick), `custom` always among them. */
export function sectionsOf(fields: readonly Pick<Field, 'section' | 'sortOrder' | 'code' | 'status'>[]): string[] {
  const sections = sortedFields(fields.filter((field) => field.status === 'ACTIVE')).map((field) => field.section)
  return [...new Set(['custom', ...sections])]
}

/** Why Move up / Move down waits: busy, a search on, nothing or archived rows picked, two sections, or at the edge. */
export function moveHeld(fields: readonly EditorField[], selected: readonly string[], delta: -1 | 1, busy: boolean, searching: boolean): string | null {
  if (busy) return 'wait.busy'
  if (selected.length === 0) return 'wait.pick'
  if (searching) return 'wait.moveSearching'
  const picked = fields.filter((field) => selected.includes(field.id))
  if (picked.some((field) => field.status !== 'ACTIVE')) return 'wait.moveArchived'
  if (new Set(picked.map((field) => field.section)).size > 1) return 'wait.moveSections'
  return moveOf(fields, selected, delta) === null ? (delta < 0 ? 'wait.moveTop' : 'wait.moveBottom') : null
}

/** The section's new order after moving the picked fields one place (POST /fields/order), or null at the edge. */
export function moveOf(fields: readonly EditorField[], selected: readonly string[], delta: -1 | 1): { section: string; fields: { id: string; version: number }[] } | null {
  const picked = fields.filter((field) => selected.includes(field.id) && field.status === 'ACTIVE')
  if (picked.length === 0) return null
  const section = picked[0]!.section
  const group = sortedFields(fields.filter((field) => field.section === section && field.status === 'ACTIVE'))
  const order = group.map((field) => field.id)
  const chosen = new Set(picked.map((field) => field.id))
  const indexes = order.map((id, index) => (chosen.has(id) ? index : -1)).filter((index) => index >= 0)
  if (delta < 0 ? indexes[0] === 0 : indexes[indexes.length - 1] === order.length - 1) return null
  const next = [...order]
  for (const index of delta < 0 ? indexes : [...indexes].reverse()) {
    const other = index + delta
    ;[next[index], next[other]] = [next[other]!, next[index]!]
  }
  const byId = new Map(group.map((field) => [field.id, field]))
  return { section, fields: next.map((id) => ({ id, version: byId.get(id)!.version })) }
}

/** Why Archive N / Restore N waits. */
export function stateHeld(picked: readonly EditorField[], to: Field['status'], busy: boolean): string | null {
  if (busy) return 'wait.busy'
  if (picked.length === 0) return 'wait.pick'
  if (!picked.some((field) => field.status !== to)) return to === 'ARCHIVED' ? 'wait.allArchived' : 'wait.allActive'
  return null
}

// ── the form preview ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface PreviewSection {
  section: string
  fields: Field[]
}

/** The record's form with these fields: active fields by section, in order. */
export function previewSections(fields: readonly Field[]): PreviewSection[] {
  const sections: PreviewSection[] = []
  for (const field of sortedFields(fields.filter((entry) => entry.status === 'ACTIVE'))) {
    const last = sections[sections.length - 1]
    if (last && last.section === field.section) last.fields.push(field)
    else sections.push({ section: field.section, fields: [field] })
  }
  return sections
}

/** The field a draft would make, for the dialog's own preview. */
export function previewField(draft: FieldDraft, picklists: readonly Picklist[], editing: Field | null): Field {
  const list = picklists.find((entry) => entry.id === draft.picklistId) ?? null
  const type = draft.type ?? 'TEXT'
  return {
    id: editing?.id ?? 'draft',
    companyId: draft.companyId,
    code: draft.code,
    columnId: `cf:${draft.code}`,
    type,
    labelIt: draft.labelIt,
    labelEn: draft.labelEn,
    section: draft.section,
    sortOrder: editing?.sortOrder ?? FIELD_LIMITS.sortOrder,
    required: draft.required,
    unit: type === 'NUMBER' && draft.unit.trim() ? draft.unit.trim() : null,
    audience: type === 'MONEY' ? 'MONEY' : draft.audience,
    grain: draft.grain,
    shownInPortal: draft.shownInPortal,
    status: 'ACTIVE',
    version: editing?.version ?? 1,
    picklist: list ? { id: list.id, code: list.code, labelIt: list.labelIt, labelEn: list.labelEn, values: list.values } : null,
    linkTo: null,
    linkRecordType: draft.linkTo,
    partyId: draft.forCustomer === 'one' ? draft.partyId : null, // B-TH-242
  }
}

// ── B-TH-242 (threads plan TH-4, SHEET-G06 / WALL-G08; features X-ADM-FIELDS.dialog-F01, -F02, SHEET.brand-fields-F06; wall W17) ──
/** "For: every customer · one customer" is offered on the record types whose records name their customer (customers, quotes, orders). */
export const customerChoiceOn = (recordType: RecordKey): boolean => (CUSTOMER_FIELD_RECORD_KEYS as readonly string[]).includes(recordType)

/**
 * The dialog's line under "Show in the portal": a field for every customer that the portal shows puts its NAME in every
 * customer's portal ('Every customer will see this column name in its portal.'), so no customer's name or code reaches the
 * others through a label. A field for one customer, or one the portal does not show: no line.
 */
export function portalLineOf(draft: Pick<FieldDraft, 'shownInPortal' | 'forCustomer' | 'audience' | 'grain'>, portalRecord: boolean): 'portalLine.every' | null {
  if (!draft.shownInPortal || portalHeld(draft, portalRecord) !== null) return null
  return draft.forCustomer === 'every' ? 'portalLine.every' : null
}

/** Where the column will appear, for the preview: on every customer's records, or on one customer's only. */
export function whereLineOf(draft: Pick<FieldDraft, 'forCustomer' | 'partyName' | 'partyId'>): { key: string; params?: Record<string, string> } {
  if (draft.forCustomer === 'one') return draft.partyId ? { key: 'customer.previewOne', params: { customer: draft.partyName ?? '…' } } : { key: 'customer.previewPick' }
  return { key: 'customer.previewEvery' }
}

/** The customer picker's search refused or failed, in our words (customers are read with the customers' own right). */
export function customerSearchFault(error: unknown): string {
  if (isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up')) return 'customer.cannotSearch'
  if (isApiError(error) && error.kind === 'unavailable') return 'fault.offline'
  return 'customer.searchFailed'
}

/** The field's line in the grid: its customer ('Brand Alpha only'), or every customer. */
export const customerLineOf = (field: Pick<EditorField, 'partyId' | 'partyName'>): { key: string; params?: Record<string, string> } =>
  field.partyId ? { key: 'customer.lineOne', params: { customer: field.partyName ?? '—' } } : { key: 'customer.lineEvery' }
// ── end B-TH-242 ──

// ── picklists ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The list shown: the address's, else the first active one, else the first. */
export function shownList(picklists: readonly Picklist[], wanted: string | null): Picklist | null {
  return picklists.find((list) => list.id === wanted) ?? picklists.find((list) => list.status === 'ACTIVE') ?? picklists[0] ?? null
}

/** The fields of the record type shown that pick from a list. */
export const fieldsOfList = (fields: readonly Field[], listId: string): Field[] => fields.filter((field) => field.picklist?.id === listId && field.status === 'ACTIVE')

/** Why Archive list waits: an active field picks from it (it names them), or busy. */
export function archiveListHeld(list: Picklist, busy: boolean): string | null {
  if (busy) return 'wait.busy'
  if (list.status === 'ACTIVE' && list.fieldCount > 0) return 'wait.listInUse'
  return null
}

export interface ListDraft {
  code: string
  codeTyped: boolean
  labelIt: string
  labelEn: string
  companyId: string | null
}

export const newListDraft = (): ListDraft => ({ code: '', codeTyped: false, labelIt: '', labelEn: '', companyId: null })

export function listDraftHeld(draft: ListDraft, codes: readonly string[], busy: boolean): string | null {
  if (busy) return 'wait.busy'
  if (!FIELD_CODE.test(draft.code)) return 'wait.listCode'
  if (codes.includes(draft.code)) return 'wait.listCodeTaken'
  if (draft.labelIt.trim() === '') return 'wait.labelIt'
  if (draft.labelEn.trim() === '') return 'wait.labelEn'
  return null
}

export interface ValueDraft {
  code: string
  codeTyped: boolean
  labelIt: string
  labelEn: string
  colour: string | null
  icon: string | null
  description: string
}

export const newValueDraft = (): ValueDraft => ({ code: '', codeTyped: false, labelIt: '', labelEn: '', colour: null, icon: null, description: '' })

/** A value's code from its English label (`Full grain` → `FULL_GRAIN`). */
export const valueCodeFrom = (label: string): string => codeFrom(label).toUpperCase()

export function valueDraftHeld(draft: ValueDraft, list: Picklist, busy: boolean): string | null {
  if (busy) return 'wait.busy'
  if (list.status !== 'ACTIVE') return 'wait.listArchived'
  if (list.values.length >= FIELD_LIMITS.perList) return 'wait.listFull'
  if (!OPTION_CODE.test(draft.code)) return 'wait.valueCode'
  if (list.values.some((value) => value.code === draft.code)) return 'wait.valueCodeTaken'
  if (draft.labelIt.trim() === '') return 'wait.labelIt'
  if (draft.labelEn.trim() === '') return 'wait.labelEn'
  if (draft.description.trim().length > FIELD_LIMITS.description) return 'wait.description'
  return null
}

export const newValueBody = (draft: ValueDraft): NewValueBody => ({
  code: draft.code,
  labelIt: draft.labelIt.trim(),
  labelEn: draft.labelEn.trim(),
  colour: draft.colour,
  icon: draft.icon,
  description: draft.description.trim() === '' ? null : draft.description.trim(),
})

/** Why Deactivate N / Activate N waits. */
export function valuesActiveHeld(picked: readonly ListValue[], active: boolean, busy: boolean): string | null {
  if (busy) return 'wait.busy'
  if (picked.length === 0) return 'wait.pick'
  if (!picked.some((value) => value.active !== active)) return active ? 'wait.allOn' : 'wait.allOff'
  return null
}

/** The list's order after moving the picked values one place, or null at the edge. */
export function valueMoveOf(values: readonly ListValue[], selected: readonly string[], delta: -1 | 1): { id: string; version: number }[] | null {
  const order = [...values].sort((a, b) => a.sortOrder - b.sortOrder).map((value) => value.id)
  const chosen = new Set(selected)
  const indexes = order.map((id, index) => (chosen.has(id) ? index : -1)).filter((index) => index >= 0)
  if (indexes.length === 0) return null
  if (delta < 0 ? indexes[0] === 0 : indexes[indexes.length - 1] === order.length - 1) return null
  const next = [...order]
  for (const index of delta < 0 ? indexes : [...indexes].reverse()) {
    const other = index + delta
    ;[next[index], next[other]] = [next[other]!, next[index]!]
  }
  const byId = new Map(values.map((value) => [value.id, value]))
  return next.map((id) => ({ id, version: byId.get(id)!.version }))
}

export function valueMoveHeld(values: readonly ListValue[], selected: readonly string[], delta: -1 | 1, busy: boolean, searching: boolean): string | null {
  if (busy) return 'wait.busy'
  if (selected.length === 0) return 'wait.pick'
  if (searching) return 'wait.moveSearching'
  return valueMoveOf(values, selected, delta) === null ? (delta < 0 ? 'wait.moveTop' : 'wait.moveBottom') : null
}

// ── save marks of the cells that save by themselves ──────────────────────────────────────────────────────────────────

export type Mark = { state: 'saving' } | { state: 'saved' } | { state: 'refused'; fault: string } | { state: 'unknown'; fault: string }
export const markKey = (id: string, cell: string): string => `${id}:${cell}`

/** The field types in the gallery's order (factory-domain FIELD_TYPES). */
export const GALLERY: readonly FieldType[] = FIELD_TYPES
