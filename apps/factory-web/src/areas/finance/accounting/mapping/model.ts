import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import { ACCOUNT_CODE, MAPPING_KINDS, MAPPING_NOTE_MAX, REASON_MAX, type AddMappingBody, type JournalsSettings, type MappingAnswer, type MappingKey, type MappingKind, type MappingRow } from './api'

/**
 * B-W2b-426 — Account mapping (SCR-480), the pure rules: who may do what (read: accounting.view; a row:
 * accounting.mapping.manage; the journals switch: accounting.journals.switch and a fresh code), the page's address
 * (`?kind=&view=&q=&open=`), the keys a view shows and their counts, a key's words in the person's language, what holds
 * adding a row (a key Nexus does not post, the account's shape, a day before today for a key mapped already, a second row
 * on one day), changing or removing one (fixed from its first day), the switch and the bulk "Map N keys", the CSV a person
 * hands the accountant to confirm, the API's refusals as words, and the live events that concern the page. No fetching,
 * no React. Nothing is sent to the accountant: the CSV is a file a person downloads.
 */

/** A message key and its values (`finance-accounting-depth`). */
export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}
const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface MappingCan {
  readonly view: boolean
  readonly manage: boolean
  readonly switch: boolean
}

/** The person's rights; the API's answer (scoped to the company) wins once it is read. */
export function mappingCanOf(permissions: readonly string[], answer: Pick<MappingAnswer, 'can' | 'journals'> | null = null): MappingCan {
  const held = new Set(permissions)
  return {
    view: held.has('accounting.view'),
    manage: answer ? answer.can.manage : held.has('accounting.mapping.manage'),
    switch: answer ? answer.journals.can.switch : held.has('accounting.journals.switch'),
  }
}

// ---- the address ---------------------------------------------------------------------------------------------------------

export const MAPPING_VIEWS = ['all', 'unmapped', 'upcoming', 'other'] as const
export type MappingView = (typeof MAPPING_VIEWS)[number]

export interface MappingAddress {
  readonly kind: MappingKind | null
  readonly view: MappingView
  readonly q: string
  /** The key open in its dialog: `KIND/KEY` (a check's fix) or a row's id (an audit row). */
  readonly open: string | null
}

export function mappingAddressOf(params: { get(name: string): string | null } | null): MappingAddress {
  const kind = params?.get('kind') ?? ''
  const view = params?.get('view') ?? ''
  const open = (params?.get('open') ?? '').trim()
  return {
    kind: (MAPPING_KINDS as readonly string[]).includes(kind) ? (kind as MappingKind) : null,
    view: (MAPPING_VIEWS as readonly string[]).includes(view) ? (view as MappingView) : 'all',
    q: (params?.get('q') ?? '').slice(0, 80),
    open: open !== '' && open.length <= 200 ? open : null,
  }
}

export function mappingHref(prefix: string, address: Partial<MappingAddress> = {}): string {
  const query = new URLSearchParams()
  if (address.kind) query.set('kind', address.kind)
  if (address.view && address.view !== 'all') query.set('view', address.view)
  if (address.q) query.set('q', address.q)
  if (address.open) query.set('open', address.open)
  const qs = query.toString()
  return `${prefix}/finance/accounting/mapping${qs ? `?${qs}` : ''}`
}

/** A key's id in the list and in the address (`TAX_CODE/22`). */
export const keyId = (key: Pick<MappingKey, 'kind' | 'key'>): string => `${key.kind}/${key.key}`

/** The key `?open=` names: `KIND/KEY`, or the key one of whose rows has this id. */
export function keyOfOpen(keys: readonly MappingKey[], open: string | null): MappingKey | null {
  if (!open) return null
  return keys.find((key) => keyId(key) === open) ?? keys.find((key) => [key.current, ...key.upcoming, ...key.earlier].some((row) => row?.id === open)) ?? null
}

// ---- the keys ---------------------------------------------------------------------------------------------------------------

/** What the key is, in the person's language; null for a key Nexus does not post (the screen says so). */
export const keyWordsOf = (key: Pick<MappingKey, 'words'>, locale: Locale): string | null => (key.words ? (locale === 'it' ? key.words.it : key.words.en) : null)

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** The keys of a view, a kind and a search (key, words in either language, account). */
export function keysOf(keys: readonly MappingKey[], address: Pick<MappingAddress, 'kind' | 'view' | 'q'>): MappingKey[] {
  const q = fold(address.q.trim())
  return keys.filter((key) => {
    if (address.kind && key.kind !== address.kind) return false
    if (address.view === 'other' ? key.posted : !key.posted) return false
    if (address.view === 'unmapped' && key.current) return false
    if (address.view === 'upcoming' && key.upcoming.length === 0) return false
    if (!q) return true
    const haystack = [key.key, key.words?.en ?? '', key.words?.it ?? '', key.current?.accountCode ?? '', ...key.upcoming.map((row) => row.accountCode)].join(' ')
    return fold(haystack).includes(q)
  })
}

/** The views' counts, within the chosen kind. */
export function viewCounts(keys: readonly MappingKey[], kind: MappingKind | null): Record<MappingView, number> {
  const of = (view: MappingView) => keysOf(keys, { kind, view, q: '' }).length
  return { all: of('all'), unmapped: of('unmapped'), upcoming: of('upcoming'), other: of('other') }
}

// ---- what holds a change ----------------------------------------------------------------------------------------------------

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
export const isDay = (value: string): boolean => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`))

/** The account as typed: trimmed (the API trims too). */
export const cleanAccount = (text: string): string => text.trim()

/** Why the account typed cannot be used (null: it can). */
export function accountHeld(text: string): Phrase | null {
  const account = cleanAccount(text)
  if (account === '') return phrase('mapping.held.account')
  if (!ACCOUNT_CODE.test(account)) return phrase('mapping.held.accountShape')
  return null
}

const rowsOf = (key: Pick<MappingKey, 'current' | 'upcoming' | 'earlier'>): MappingRow[] => [...key.earlier, ...(key.current ? [key.current] : []), ...key.upcoming]

export interface AddDraft {
  readonly accountCode: string
  readonly validFrom: string
  readonly note: string
}

/** Why a row cannot be added to this key (null: it can): the permission, a key Nexus does not post, the account, the day. */
export function addHeld(key: MappingKey, draft: AddDraft, facts: { readonly today: string; readonly can: Pick<MappingCan, 'manage'>; readonly busy: boolean }): Phrase | null {
  if (!facts.can.manage) return phrase('mapping.held.noManage')
  if (!key.posted) return phrase('mapping.held.notPosted')
  if (facts.busy) return phrase('mapping.held.busy')
  const account = accountHeld(draft.accountCode)
  if (account) return account
  if (!isDay(draft.validFrom)) return phrase('mapping.held.day')
  const rows = rowsOf(key)
  if (rows.length > 0 && draft.validFrom < facts.today) return phrase('mapping.held.backdated')
  if (rows.some((row) => row.validFrom === draft.validFrom)) return phrase('mapping.held.sameDay')
  if (draft.note.trim().length > MAPPING_NOTE_MAX) return phrase('mapping.held.note', { max: MAPPING_NOTE_MAX })
  return null
}

export function addBody(companyId: string, key: Pick<MappingKey, 'kind' | 'key'>, draft: AddDraft): AddMappingBody {
  const note = draft.note.trim()
  return { companyId, kind: key.kind, key: key.key, accountCode: cleanAccount(draft.accountCode), validFrom: draft.validFrom, ...(note ? { note } : {}) }
}

/** Why an upcoming row cannot be changed (null: it can): fixed from its first day; nothing changes; the account. */
export function changeHeld(row: MappingRow, draft: { readonly accountCode: string; readonly note: string }, facts: { readonly can: Pick<MappingCan, 'manage'>; readonly busy: boolean }): Phrase | null {
  if (!facts.can.manage) return phrase('mapping.held.noManage')
  if (row.fixed) return phrase('mapping.held.fixed', { day: row.validFrom })
  if (facts.busy) return phrase('mapping.held.busy')
  const account = accountHeld(draft.accountCode)
  if (account) return account
  if (draft.note.trim().length > MAPPING_NOTE_MAX) return phrase('mapping.held.note', { max: MAPPING_NOTE_MAX })
  if (cleanAccount(draft.accountCode) === row.accountCode && (draft.note.trim() || null) === row.note) return phrase('mapping.held.nothingChanges')
  return null
}

/** Why a row cannot be removed (null: it can): only an upcoming row, before its first day. */
export function removeHeld(row: MappingRow, facts: { readonly can: Pick<MappingCan, 'manage'>; readonly busy: boolean }): Phrase | null {
  if (!facts.can.manage) return phrase('mapping.held.noManage')
  if (row.fixed) return phrase('mapping.held.fixed', { day: row.validFrom })
  if (facts.busy) return phrase('mapping.held.busy')
  return null
}

/** Why "Map N keys" cannot run (null: it can): the permission, keys Nexus does not post, the account, the day. */
export function bulkHeld(keys: readonly MappingKey[], draft: AddDraft, facts: { readonly today: string; readonly can: Pick<MappingCan, 'manage'>; readonly busy: boolean }): Phrase | null {
  if (!facts.can.manage) return phrase('mapping.held.noManage')
  if (keys.length === 0) return phrase('mapping.held.noneChosen')
  const other = keys.filter((key) => !key.posted).length
  if (other > 0) return phrase('mapping.held.bulkNotPosted', { count: other })
  if (facts.busy) return phrase('mapping.held.busy')
  const account = accountHeld(draft.accountCode)
  if (account) return account
  if (!isDay(draft.validFrom)) return phrase('mapping.held.day')
  const mapped = keys.filter((key) => rowsOf(key).length > 0)
  if (mapped.length > 0 && draft.validFrom < facts.today) return phrase('mapping.held.bulkBackdated', { count: mapped.length })
  const same = keys.filter((key) => rowsOf(key).some((row) => row.validFrom === draft.validFrom)).length
  if (same > 0) return phrase('mapping.held.bulkSameDay', { count: same })
  if (draft.note.trim().length > MAPPING_NOTE_MAX) return phrase('mapping.held.note', { max: MAPPING_NOTE_MAX })
  return null
}

// ---- the journals switch -------------------------------------------------------------------------------------------------------

export interface SwitchDraft {
  readonly reason: string
  readonly busy: boolean
}

/** Why the journals cannot be switched now (null: they can): the permission, a running switch, a reason too long. */
export function switchHeld(draft: SwitchDraft, can: Pick<MappingCan, 'switch'>): Phrase | null {
  if (!can.switch) return phrase('journals.held.noSwitch')
  if (draft.busy) return phrase('mapping.held.busy')
  if (draft.reason.trim().length > REASON_MAX) return phrase('journals.held.reason', { max: REASON_MAX })
  return null
}

/** What switching does, in words: on → the entries files and the two checks; off → the journals go without entries. */
export function switchConsequences(settings: Pick<JournalsSettings, 'journalsOn'>, unmapped: number): Phrase[] {
  if (settings.journalsOn) return [phrase('journals.off.what'), phrase('journals.off.handedOver')]
  return [phrase('journals.on.what'), phrase('journals.on.checks'), ...(unmapped > 0 ? [phrase('journals.on.unmapped', { count: unmapped })] : []), phrase('journals.on.gate')]
}

export const switchBody = (companyId: string, settings: Pick<JournalsSettings, 'journalsOn' | 'version' | 'from'>, reason: string) => {
  const why = reason.trim()
  return { companyId, journalsOn: !settings.journalsOn, ...(settings.from === 'COMPANY' && settings.version !== null ? { version: settings.version } : {}), ...(why ? { reason: why } : {}) }
}

// ---- the CSV ---------------------------------------------------------------------------------------------------------------------

const cell = (value: string): string => (/[";\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/**
 * The mapping as a CSV a person hands the accountant to confirm (semicolons, as Italian spreadsheets read them): kind, key,
 * what it is, the account today and since when, the next account and from when, the note. Headers in the person's words.
 */
export function mappingCsv(keys: readonly MappingKey[], words: { readonly headers: readonly string[]; readonly kind: (kind: MappingKind) => string; readonly notPosted: string }, locale: Locale): string {
  const lines = [words.headers.map(cell).join(';')]
  for (const key of keys) {
    const next = key.upcoming[0] ?? null
    lines.push([words.kind(key.kind), key.key, keyWordsOf(key, locale) ?? words.notPosted, key.current?.accountCode ?? '', key.current?.validFrom ?? '', next?.accountCode ?? '', next?.validFrom ?? '', key.current?.note ?? ''].map(cell).join(';'))
  }
  return `${lines.join('\r\n')}\r\n`
}

// ---- the API in this page's words -----------------------------------------------------------------------------------------------

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid'].includes(error.kind)) return `problem.read.${error.kind}`
  return 'problem.read.internal'
}

export interface WriteProblem extends Phrase {
  /** The mapping changed meanwhile: read it again. */
  readonly reload: boolean
}

/** A refused write as words (never the API's English). */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false }
  const paths = error.issues.map(issuePath)
  const refusal = paths.map((path) => /^problem[/.]([A-Z_]+)$/.exec(path)?.[1]).find((code): code is string => !!code && ['FIXED', 'BACKDATED', 'SAME_DAY', 'NOTHING_CHANGES'].includes(code))
  if (refusal) return { key: `mapping.refusal.${refusal}`, reload: refusal !== 'NOTHING_CHANGES' }
  if (paths.some((path) => /^body[/.]key/.test(path))) return { key: 'mapping.refusal.UNKNOWN_KEY', reload: true }
  if (paths.some((path) => /^body[/.]accountCode/.test(path))) return { key: 'mapping.held.accountShape', reload: false }
  if (error.kind === 'conflict') return { key: 'problem.write.moved', reload: true }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'step_up', 'invalid'].includes(error.kind)) return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found' }
  return { key: 'problem.write.internal', reload: false }
}

// ---- live --------------------------------------------------------------------------------------------------------------------

/** A row added, changed or removed, or the switch flipped (by someone else): "N updates · Show". */
export const mappingTouches = (change: { type: string }): boolean => change.type === 'account_mapping.changed' || change.type === 'accounting_settings.changed'
