import {
  cleanSizes,
  itemProblems,
  lineProblems,
  normalPpeCode,
  PPE_CATEGORIES,
  PPE_ISSUE_REASONS,
  PPE_LIMITS,
  PPE_REFUSALS,
  RECEIPT_STATES,
  type PpeCategory,
  type PpeIssueReason,
  type ReceiptState,
} from '@nexus/factory-domain/safety/ppe/rules'
import { issuePath, isApiError } from '../../../lib/api/errors'
import type { CountsAnswer, GapLine, GapRow, IssueLine, IssueLineBody, ItemBody, KitsAnswer, PpeItem } from './api'

/**
 * Plant › Health & safety › PPE for workers (SCR-211; B-W2b-147; design plant.ppe): the page's rules, pure. The address ⇄
 * the page's state (one lens at a time — Gaps | Issues | Kits per role | Catalogue — its filters the API's own, every dialog in
 * the address), the tiles, the dialogs' drafts with why their buttons are held and what they send (factory-domain
 * safety/ppe/rules decides what is well formed: the screen and the API say the same), and the API's refusals in our words.
 * A person is named only as the receipt's subject (a legal register, art. 77 c.4): never a figure, a ranking or a total
 * about a person. The only money is an item's unit cost (the cost grain).
 */

// ---- who may do what ------------------------------------------------------------------------------------------------------

export interface PpeCan {
  /** safety.view: every lens, the receipts, the cards. */
  readonly view: boolean
  /** safety.ppe.manage: the catalogue. */
  readonly manage: boolean
  /** safety.ppe.issue: a paper receipt, a void, keeping a PIN receipt's PDF. */
  readonly issue: boolean
  /** money.cost: an item's unit cost. */
  readonly cost: boolean
  /** files.upload: the signed paper's scan. */
  readonly upload: boolean
  /** files.read: opening a stored scan or kept PDF. */
  readonly readFiles: boolean
  /** safety.chemicals.manage: the supplier list the item dialog borrows (see api.ts readSuppliers). */
  readonly suppliers: boolean
}

export const ppeCan = (permissions: readonly string[]): PpeCan => ({
  view: permissions.includes('safety.view'),
  manage: permissions.includes('safety.ppe.manage'),
  issue: permissions.includes('safety.ppe.issue'),
  cost: permissions.includes('money.cost'),
  upload: permissions.includes('files.upload'),
  readFiles: permissions.includes('files.read'),
  suppliers: permissions.includes('safety.chemicals.manage'),
})

/**
 * Whether the floor tablet's "Receive PPE" screen (Floor › Training & PPE sign-off, SCR-231) is built: until it is, "Sign at
 * the floor tablet" is held with its reason in the issue dialog (a person sent there would find nothing). B-W2b-145 sets it
 * true when its floor screen ships.
 */
export const TABLET_RECEIPT_READY = false

// ---- the address ------------------------------------------------------------------------------------------------------------

export const LENSES = ['gaps', 'issues', 'kits', 'catalogue'] as const
export type Lens = (typeof LENSES)[number]
/** Gaps: who misses kit items (the API's `missing`), whose units are past their life, everyone (`all`). */
export const GAP_SHOWS = ['missing', 'replace', 'all'] as const
export type GapShow = (typeof GAP_SHOWS)[number]
/** Issues: every line, the paper receipts whose scan is not on file, the voided lines (the API's `view`). */
export const ISSUE_VIEWS = ['all', 'notSigned', 'voided'] as const
export type IssueView = (typeof ISSUE_VIEWS)[number]
export const ITEM_STATUSES = ['ACTIVE', 'ARCHIVED', 'all'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

/**
 * `?view=gaps|issues|kits|catalogue` and its filters (Gaps `show`, `role`, `q`; Issues `signed`, `person`, `ppe`, `from`, `to`,
 * `q`; Catalogue `status`, `q`), the dialogs: Issue PPE (`issue=new|<employee id>`, prefilled from the person's kit), PPE item
 * (`item=new|<item id>`), Void an issue (`void=<issue line id>`), the signed scan of a paper receipt (`scan=<receipt id>`).
 */
export interface PpeAddress {
  view: Lens
  show: GapShow
  role: string | null
  q: string
  signed: IssueView
  person: string | null
  ppe: string | null
  from: string | null
  to: string | null
  status: ItemStatus
  issue: string | null
  item: string | null
  void: string | null
  scan: string | null
}

export const EMPTY_ADDRESS: PpeAddress = { view: 'gaps', show: 'missing', role: null, q: '', signed: 'all', person: null, ppe: null, from: null, to: null, status: 'ACTIVE', issue: null, item: null, void: null, scan: null }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T => (value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback)
const idOf = (value: string | null): string | null => {
  const id = value?.trim() ?? ''
  return id === '' ? null : id.slice(0, 64)
}

export function addressOf(params: { get(name: string): string | null }): PpeAddress {
  const from = params.get('from')
  const to = params.get('to')
  return {
    view: pick(params.get('view'), LENSES, 'gaps'),
    show: pick(params.get('show'), GAP_SHOWS, 'missing'),
    role: idOf(params.get('role')),
    q: params.get('q')?.trim().slice(0, 100) ?? '',
    signed: pick(params.get('signed'), ISSUE_VIEWS, 'all'),
    person: idOf(params.get('person')),
    ppe: idOf(params.get('ppe')),
    from: from && DAY.test(from) ? from : null,
    to: to && DAY.test(to) ? to : null,
    status: pick(params.get('status'), ITEM_STATUSES, 'ACTIVE'),
    issue: idOf(params.get('issue')),
    item: idOf(params.get('item')),
    void: idOf(params.get('void')),
    scan: idOf(params.get('scan')),
  }
}

/** The address with a change: another lens starts without the words typed in the last one (each lens's search is its own). */
export function withAddress(address: PpeAddress, change: Partial<PpeAddress>): PpeAddress {
  const next = { ...address, ...change }
  if (change.view && change.view !== address.view && !('q' in change)) next.q = ''
  return next
}

export function addressText(address: PpeAddress): string {
  const params = new URLSearchParams()
  if (address.view !== 'gaps') params.set('view', address.view)
  if (address.view === 'gaps') {
    if (address.show !== 'missing') params.set('show', address.show)
    if (address.role) params.set('role', address.role)
  }
  if (address.view === 'issues') {
    if (address.signed !== 'all') params.set('signed', address.signed)
    if (address.person) params.set('person', address.person)
    if (address.ppe) params.set('ppe', address.ppe)
    if (address.from) params.set('from', address.from)
    if (address.to) params.set('to', address.to)
  }
  if (address.view === 'catalogue' && address.status !== 'ACTIVE') params.set('status', address.status)
  if (address.q && address.view !== 'kits') params.set('q', address.q)
  if (address.issue) params.set('issue', address.issue)
  if (address.item) params.set('item', address.item)
  if (address.void) params.set('void', address.void)
  if (address.scan) params.set('scan', address.scan)
  const text = params.toString()
  return text ? `?${text}` : ''
}

// ---- the tiles ----------------------------------------------------------------------------------------------------------------

/**
 * The design's tiles that are built: people missing kit items, receipts not signed, replacements due (the API counts the
 * people with a unit past its life). "Items below minimum" stays Later (PPE stock is not linked to the warehouse: the API
 * answers null), so it is not drawn: never a tile that says nothing.
 */
export const TILES = ['peopleMissingKit', 'receiptsNotSigned', 'replacementsDue'] as const
export type TileId = (typeof TILES)[number]

export interface Tile {
  readonly id: TileId
  readonly value: number | null
  /** Where the tile leads: a lens and its filter. */
  readonly to: Partial<PpeAddress>
}

export const tilesOf = (counts: CountsAnswer | null): Tile[] =>
  TILES.map((id) => ({
    id,
    value: counts ? counts[id] : null,
    to: id === 'receiptsNotSigned' ? { view: 'issues', signed: 'notSigned' } : { view: 'gaps', show: id === 'replacementsDue' ? 'replace' : 'missing' },
  }))

/** Whether a tile's filter is the one on screen. */
export const tileActive = (tile: Tile, address: PpeAddress): boolean =>
  tile.id === 'receiptsNotSigned' ? address.view === 'issues' && address.signed === 'notSigned' : address.view === 'gaps' && address.show === (tile.id === 'replacementsDue' ? 'replace' : 'missing')

// ---- words for codes --------------------------------------------------------------------------------------------------------

/** An item's name in the page's language (the item's own name when it has none in it). */
export const itemName = (item: { readonly name: string; readonly nameI18n: Readonly<Record<string, string>> | null }, locale: string): string => item.nameI18n?.[locale]?.trim() || item.name

export const RECEIPT_TONE: Readonly<Record<ReceiptState, 'success' | 'warning' | 'neutral' | 'danger'>> = { SIGNED_PIN: 'success', SIGNED_PAPER: 'success', NOT_SIGNED: 'warning', VOIDED: 'neutral' }

/** The category's short mark ("I", "II", "III"); an unknown category is said as it came. */
export const categoryMark = (category: string): string => ({ CATEGORY_I: 'I', CATEGORY_II: 'II', CATEGORY_III: 'III' })[category] ?? category

/** Who handed it over, as the API allows: an office user by name, a worker by name only behind the site's gate, else "a worker". */
export function issuedByText(by: IssueLine['issuedBy'], words: { readonly worker: string; readonly none: string }): string {
  if (by.kind === 'NONE') return words.none
  if (by.kind === 'WORKER' && (by.hidden || !by.name)) return words.worker
  return by.name ?? words.none
}

/** The lines a person misses or must replace, in words ("Safety shoes S3 ×1, Gloves ×2"). */
export const missingText = (lines: readonly GapLine[], name: (line: GapLine) => string, show: GapShow): string =>
  lines
    .filter((line) => (show === 'replace' ? line.replace > 0 : line.missing > 0))
    .map((line) => `${name(line)} ×${show === 'replace' ? line.replace : line.missing}`)
    .join(', ')

/** The gaps rows the lens shows (the API answers `missing` or `all`; Replacements due are the `all` rows with a unit past its life). */
export const gapRowsFor = (rows: readonly GapRow[], show: GapShow): GapRow[] => (show === 'replace' ? rows.filter((row) => row.replace > 0) : [...rows])

/** The Issues lens's words typed (the API has no text filter): person, employee number, item code or name, size. */
export function issueMatches(row: IssueLine, q: string, locale: string): boolean {
  const words = q.trim().toLowerCase()
  if (!words) return true
  return [row.employee.name, row.employee.employeeCode ?? '', row.item.code, itemName(row.item, locale), row.size ?? ''].some((text) => text.toLowerCase().includes(words))
}

/** The receipts the chosen issue lines belong to, each once, in the order chosen. */
export const receiptsOfLines = (rows: readonly IssueLine[], ids: readonly string[]): string[] => [...new Set(ids.map((id) => rows.find((row) => row.id === id)?.receiptId).filter((id): id is string => !!id))]

// ---- the kits matrix --------------------------------------------------------------------------------------------------------

export interface KitCell {
  readonly quantity: number
  readonly whenToWear: string
}

/** One row per role, one cell per item of its kit (roles without a kit item still show: their kit is empty). */
export function kitMatrix(kits: KitsAnswer): { roles: KitsAnswer['roles']; items: KitsAnswer['items']; cell: (roleSheetId: string, ppeItemId: string) => KitCell | null } {
  const cells = new Map(kits.cells.map((cell) => [`${cell.roleSheetId}|${cell.ppeItemId}`, { quantity: cell.quantity, whenToWear: cell.whenToWear }]))
  const used = new Set(kits.cells.map((cell) => cell.ppeItemId))
  return { roles: kits.roles, items: kits.items.filter((item) => used.has(item.id)), cell: (roleSheetId, ppeItemId) => cells.get(`${roleSheetId}|${ppeItemId}`) ?? null }
}

// ---- Issue PPE ------------------------------------------------------------------------------------------------------------------

export type IssueMethod = 'paper' | 'tablet'

export interface IssueLineDraft {
  readonly key: string
  readonly ppeItemId: string
  readonly size: string
  readonly quantity: number | ''
  readonly reason: PpeIssueReason
}

export interface IssueDraft {
  readonly employeeId: string | null
  readonly lines: readonly IssueLineDraft[]
  readonly method: IssueMethod
  /** When the paper was signed (ISO instant); '' = now. */
  readonly signedAt: string
  /** The signed paper's scan, as picked (the File stays in the container). */
  readonly scan: { readonly name: string; readonly type: string; readonly size: number } | null
}

export const EMPTY_ISSUE: IssueDraft = { employeeId: null, lines: [], method: 'paper', signedAt: '', scan: null }

let lineCounter = 0
export const lineKey = (): string => `line-${++lineCounter}`

/** An item's one size, when it has exactly one (the line takes it at once); none for a one-size item. */
const onlySize = (sizes: readonly string[]): string => (sizes.length === 1 ? sizes[0]! : '')

/**
 * "Issue now" from a person (design: the dialog prefilled from their role's kit): one line per kit item they miss (the
 * units missing, NEW) or whose units are past their life (the units due, REPLACEMENT); the size is theirs to pick unless
 * the item has only one.
 */
export function prefillLines(row: Pick<GapRow, 'lines'>): IssueLineDraft[] {
  const lines: IssueLineDraft[] = []
  for (const line of row.lines) {
    if (line.item.status !== 'ACTIVE') continue
    if (line.missing > 0) lines.push({ key: lineKey(), ppeItemId: line.ppeItemId, size: onlySize(line.item.sizes), quantity: line.missing, reason: 'NEW' })
    else if (line.replace > 0) lines.push({ key: lineKey(), ppeItemId: line.ppeItemId, size: onlySize(line.item.sizes), quantity: line.replace, reason: 'REPLACEMENT' })
  }
  return lines
}

/** A new line for an item (one unit, NEW). */
export const newLine = (item: Pick<PpeItem, 'id' | 'sizes'>): IssueLineDraft => ({ key: lineKey(), ppeItemId: item.id, size: onlySize(item.sizes), quantity: 1, reason: 'NEW' })

/** What the paper receipt sends. */
export function issueBodyOf(draft: IssueDraft): { employeeId: string; lines: IssueLineBody[]; issuedAt?: string } {
  return {
    employeeId: draft.employeeId ?? '',
    lines: draft.lines.map((line) => ({ ppeItemId: line.ppeItemId, size: line.size.trim() === '' ? null : line.size.trim(), quantity: line.quantity === '' ? 0 : line.quantity, reason: line.reason })),
    ...(draft.signedAt ? { issuedAt: draft.signedAt } : {}),
  }
}

/** The units on the draft ("Issue 3 items" counts what is handed over). */
export const unitsOf = (draft: Pick<IssueDraft, 'lines'>): number => draft.lines.reduce((sum, line) => sum + (line.quantity === '' ? 0 : line.quantity), 0)

export interface LineProblem {
  readonly index: number
  readonly field: 'ppeItemId' | 'size' | 'quantity' | 'line'
  readonly key: string
}

/** Each line's problem against the person's company catalogue (factory-domain `lineProblems`: the API says the same). */
export function issueLineProblems(draft: IssueDraft, items: readonly PpeItem[], companyId: string | null): LineProblem[] {
  if (draft.lines.length === 0 || !companyId) return []
  const catalogue = new Map(items.map((item) => [item.id, { id: item.id, companyId: item.companyId, status: item.status, sizes: item.sizes }]))
  const problems: LineProblem[] = []
  for (const issue of lineProblems(issueBodyOf(draft).lines, catalogue, companyId)) {
    const match = /^lines\/(\d+)(?:\/(ppeItemId|size|quantity))?$/.exec(issue.path)
    if (!match) continue
    const index = Number(match[1])
    const field = (match[2] ?? 'line') as LineProblem['field']
    if (!problems.some((entry) => entry.index === index && entry.field === field)) problems.push({ index, field, key: field === 'line' ? 'held.lineTwice' : `held.line.${field}` })
  }
  return problems
}

/** When a paper receipt may be dated (factory-domain `paperDateRefusal`'s rule, said before sending). */
export function signedAtHeld(signedAt: string, now: Date): string | null {
  if (!signedAt) return null
  const at = new Date(signedAt)
  if (Number.isNaN(at.getTime())) return 'held.signedAt'
  if (at.getTime() > now.getTime() + 60_000) return 'refusal.IN_FUTURE'
  if (now.getTime() - at.getTime() > PPE_LIMITS.lateDays * 86_400_000) return 'refusal.TOO_LATE'
  return null
}

/** The scan's kinds the office takes (a PDF or a photo of the signed paper). */
export const SCAN_ACCEPT = '.pdf,.jpg,.jpeg,.png'
export const scanTypeOk = (type: string, name: string): boolean => (type ? ['application/pdf', 'image/jpeg', 'image/png'].includes(type) : /\.(pdf|jpe?g|png)$/i.test(name))

/** Why the dialog's primary button waits, as a message key (null: it may go). */
export function issueHeld(draft: IssueDraft, input: { readonly can: PpeCan; readonly items: readonly PpeItem[] | null; readonly companyId: string | null; readonly canIssuePerson: boolean; readonly tabletReady: boolean; readonly busy: boolean; readonly now: Date }): string | null {
  if (input.busy) return 'held.busy'
  if (!input.can.issue) return 'held.issue'
  if (!draft.employeeId) return 'held.person'
  if (!input.canIssuePerson) return 'held.personSite'
  if (draft.method === 'tablet') return input.tabletReady ? null : 'held.tabletNotReady'
  if (draft.lines.length === 0) return 'held.lines'
  if (draft.lines.length > PPE_LIMITS.lines) return 'held.tooManyLines'
  if (!input.items) return 'held.itemsLoading'
  const line = issueLineProblems(draft, input.items, input.companyId)[0]
  if (line) return line.key
  const when = signedAtHeld(draft.signedAt, input.now)
  if (when) return when
  if (draft.scan && !scanTypeOk(draft.scan.type, draft.scan.name)) return 'held.scanType'
  return null
}

// ---- PPE item ---------------------------------------------------------------------------------------------------------------------

export interface ItemDraft {
  readonly code: string
  readonly name: string
  readonly nameIt: string
  readonly nameEn: string
  readonly category: PpeCategory | ''
  readonly standard: string
  readonly sizes: readonly string[]
  readonly lifeMonths: string
  readonly supplierPartyId: string | null
  /** In euros as typed ("12,50"); sent in cents, only with the cost grain. */
  readonly unitCost: string
  readonly note: string
}

export const EMPTY_ITEM: ItemDraft = { code: '', name: '', nameIt: '', nameEn: '', category: '', standard: '', sizes: [], lifeMonths: '', supplierPartyId: null, unitCost: '', note: '' }

const euros = (minor: number | null | undefined): string => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2).replace('.', ','))

export function itemDraftOf(item: PpeItem): ItemDraft {
  return {
    code: item.code,
    name: item.name,
    nameIt: item.nameI18n?.it ?? '',
    nameEn: item.nameI18n?.en ?? '',
    category: item.category,
    standard: item.standard ?? '',
    sizes: [...item.sizes],
    lifeMonths: item.lifeMonths === null ? '' : String(item.lifeMonths),
    supplierPartyId: item.supplier?.id ?? null,
    unitCost: euros(item.unitCost),
    note: item.note ?? '',
  }
}

/** "12,50" → 1250 cents; '' → null; anything else → NaN (held). */
export function centsOf(text: string): number | null {
  const typed = text.trim().replace(/\s/g, '').replace(/€/g, '')
  if (typed === '') return null
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(typed)) return Number.NaN
  return Math.round(Number(typed.replace(',', '.')) * 100)
}

const monthsOf = (text: string): number | null => (text.trim() === '' ? null : /^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : Number.NaN)
const textOrNull = (text: string): string | null => (text.trim() === '' ? null : text.trim())

/** What the dialog sends: the unit cost only with the cost grain. */
export function itemBodyOf(draft: ItemDraft, withCost: boolean): ItemBody {
  const names: Record<string, string> = {}
  if (draft.nameIt.trim()) names.it = draft.nameIt.trim()
  if (draft.nameEn.trim()) names.en = draft.nameEn.trim()
  return {
    name: draft.name.trim(),
    nameI18n: Object.keys(names).length > 0 ? names : null,
    category: (draft.category || 'CATEGORY_I') as PpeCategory,
    standard: textOrNull(draft.standard),
    sizes: cleanSizes(draft.sizes),
    lifeMonths: monthsOf(draft.lifeMonths),
    supplierPartyId: draft.supplierPartyId,
    ...(withCost ? { unitCost: centsOf(draft.unitCost) } : {}),
    note: textOrNull(draft.note),
  }
}

/** The fields at fault (the domain's `itemProblems`), each as its message key. */
export function itemDraftProblems(draft: ItemDraft, isNew: boolean, withCost: boolean): { field: string; key: string }[] {
  const problems: { field: string; key: string }[] = []
  if (isNew && draft.code.trim() === '') problems.push({ field: 'code', key: 'held.code' })
  if (draft.name.trim() === '') problems.push({ field: 'name', key: 'held.name' })
  if (draft.category === '') problems.push({ field: 'category', key: 'held.category' })
  const body = itemBodyOf(draft, withCost)
  if (Number.isNaN(body.lifeMonths)) problems.push({ field: 'lifeMonths', key: 'held.lifeMonths' })
  if (withCost && Number.isNaN(body.unitCost)) problems.push({ field: 'unitCost', key: 'held.unitCost' })
  const checked = {
    ...(isNew ? { code: draft.code } : {}),
    name: body.name,
    nameI18n: body.nameI18n,
    standard: body.standard,
    sizes: draft.sizes,
    lifeMonths: Number.isNaN(body.lifeMonths) ? undefined : body.lifeMonths,
    unitCost: withCost && !Number.isNaN(body.unitCost) ? body.unitCost : undefined,
    note: body.note,
  }
  for (const issue of itemProblems(checked)) {
    const field = issue.path.split('/')[0]!
    if (!problems.some((entry) => entry.field === field)) problems.push({ field, key: `held.${field === 'nameI18n' ? 'name' : field}` })
  }
  return problems
}

/** The code as it will be kept (capitals). */
export const codeOf = (draft: ItemDraft): string => normalPpeCode(draft.code)

/** Whether an edit changes anything (Save waits "Nothing changed" otherwise). */
export const itemChanged = (item: PpeItem, draft: ItemDraft, withCost: boolean): boolean => JSON.stringify(itemBodyOf(itemDraftOf(item), withCost)) !== JSON.stringify(itemBodyOf(draft, withCost))

export function itemHeld(draft: ItemDraft, input: { readonly item: PpeItem | null; readonly can: PpeCan; readonly companyId: string | null; readonly busy: boolean }): string | null {
  if (input.busy) return 'held.busy'
  if (!input.can.manage || (input.item && !input.item.canManage)) return 'held.manage'
  if (!input.item && !input.companyId) return 'held.company'
  if (input.item?.status === 'ARCHIVED') return 'refusal.ARCHIVED'
  const problem = itemDraftProblems(draft, !input.item, input.can.cost)[0]
  if (problem) return problem.key
  if (input.item && !itemChanged(input.item, draft, input.can.cost)) return 'held.nothingChanged'
  return null
}

/** Archive is refused while an ACTIVE role's kit names the item (IN_KIT): said before the click. */
export const archiveHeld = (item: Pick<PpeItem, 'inKits' | 'status' | 'canManage'>, can: PpeCan, busy: boolean): string | null =>
  busy ? 'held.busy' : !can.manage || !item.canManage ? 'held.manage' : item.status !== 'ACTIVE' ? 'refusal.ARCHIVED' : item.inKits > 0 ? 'refusal.IN_KIT' : null

// ---- Void an issue ------------------------------------------------------------------------------------------------------------

export const voidHeld = (reason: string, busy: boolean, line: Pick<IssueLine, 'canVoid' | 'voided'> | null): string | null =>
  busy ? 'held.busy' : !line ? 'held.lineGone' : line.voided ? 'refusal.VOIDED_ALREADY' : !line.canVoid ? 'held.issue' : reason.trim() === '' ? 'held.reason' : reason.trim().length > PPE_LIMITS.reason ? 'held.reasonLong' : null

// ---- the API's answers in our words ---------------------------------------------------------------------------------------------

export interface Problem {
  readonly key: string
  /** The body field the API names (`code`, `lines`, `unitCost` …). */
  readonly field: string | null
  /** The line it names (`body/lines/<i>/…`). */
  readonly line: number | null
  readonly unknown?: boolean
}

const REFUSALS = new Set<string>(Object.keys(PPE_REFUSALS))

export function problemOf(error: unknown): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null, line: null, unknown: true }
  let refusal: string | null = null
  let field: string | null = null
  let line: number | null = null
  let lineField: string | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) {
      const code = path.slice('refusal/'.length)
      if (REFUSALS.has(code)) refusal = code
    } else if (/^body[./]/.test(path) && !field) {
      const parts = path.replace(/^body[./]/, '').split(/[./]/)
      field = parts[0] || null
      if (field === 'lines' && parts[1] !== undefined && /^\d+$/.test(parts[1])) {
        line = Number(parts[1])
        lineField = parts[2] ?? null
      }
    }
  }
  if (refusal) return { key: `refusal.${refusal}`, field, line }
  switch (error.kind) {
    case 'invalid':
      if (field === 'lines') return { key: lineField === 'size' ? 'held.line.size' : lineField === 'quantity' ? 'held.line.quantity' : lineField === 'ppeItemId' ? 'held.line.ppeItemId' : 'held.lines', field, line }
      return { key: field ? `held.${field === 'nameI18n' ? 'name' : field}` : 'problem.invalid', field, line }
    case 'signed_out':
      return { key: 'problem.signedOut', field: null, line: null }
    case 'forbidden':
      return { key: 'problem.forbidden', field: null, line: null }
    case 'not_found':
      return { key: 'problem.notFound', field: null, line: null }
    case 'conflict':
      return { key: 'problem.conflict', field: null, line: null }
    case 'rate_limited':
      return { key: 'problem.rateLimited', field: null, line: null }
    case 'unavailable':
      return error.code === 'network' ? { key: 'problem.noAnswer', field: null, line: null, unknown: true } : { key: 'problem.unavailable', field: null, line: null }
    default:
      return { key: 'problem.internal', field: null, line: null }
  }
}

/** A read that failed, in words (a section says it and offers Try again; never drawn as empty). */
export const readProblemOf = (error: unknown): string => {
  const problem = problemOf(error)
  return problem.key === 'problem.forbidden' || problem.key === 'problem.signedOut' || problem.key === 'problem.notFound' ? problem.key : 'problem.read'
}

/** The problem's words at a field, when it names that field. */
export const atField = (problem: Problem | null, ...fields: readonly string[]): string | null => (problem && problem.field && fields.includes(problem.field) ? problem.key : null)

// ---- live ---------------------------------------------------------------------------------------------------------------------

/** What a live change moves: issues and voids the gaps, the issues and the tiles; an item the catalogue and the kits; a role sheet the kits and the gaps. */
export function liveReach(type: string): readonly ('counts' | 'gaps' | 'issues' | 'kits' | 'catalogue')[] {
  switch (type) {
    case 'ppe.issued':
    case 'ppe_issue.voided':
      return ['counts', 'gaps', 'issues']
    case 'ppe_item.changed':
      return ['catalogue', 'kits', 'gaps']
    case 'role_sheet.changed':
    case 'employee.role_changed':
      return ['counts', 'gaps', 'kits']
    default:
      return []
  }
}

/** The role-sheet banner (design "Kit for Cutter changed: 4 people miss cut-resistant gloves"), counted from the gaps read again. */
export function roleBannerOf(roleSheetId: string, kits: KitsAnswer | null, gaps: readonly GapRow[] | null): { role: string; people: number } | null {
  const role = kits?.roles.find((entry) => entry.id === roleSheetId)
  if (!role) return null
  return { role: role.name, people: (gaps ?? []).filter((row) => row.role?.id === roleSheetId && row.missing > 0).length }
}

export { PPE_CATEGORIES, PPE_ISSUE_REASONS, RECEIPT_STATES, PPE_LIMITS }
