import type { Team } from '../../people/_shared/api'
import type { BoardColumn, BoardTeam, OrderTeamPut, OrderTeams, TeamFace, TeamFacts, TeamsBoard } from './api'

/**
 * owb-ss7 (S3 web B; design plan § 5za TEAMS, § 5zd "no limit of two, windows with every option", § 5ze "every button works"; prototype
 * teams.js) — the rules of Production › Teams, "Give to a team…", "Lend a person" and the order's Team part, without a screen. Pure.
 *
 * - Work goes to a TEAM, never to a person. An order has its team(s): ONE team, several that WORK TOGETHER (every team sees every basket,
 *   ONE is in charge), or several that SPLIT THE BASKETS (each its own number; the numbers add up to the planned baskets; each ≥ 1).
 *   Any number of teams (§ 5zd). After the FIRST print the shares are fixed ("The baskets were shared at print"): only teams that work
 *   together may be added or taken off (the server's rule, owb-ss5 5.1).
 * - Marks, never a stop: over its limit · takes no new order · n missing today · late. A team that takes no new order is not suggested,
 *   but it can be picked.
 * - Privacy (the real app's rule): every figure is a TEAM's; the API sends null for a team below the minimum group, and the screen
 *   shows "—" with the ⓘ words "Small teams show no numbers" — it never counts anything itself (no late count from the cards).
 * - A loan: to another team of the same site, until a last day (Today · 3 days · A week · a day you pick, ≤ 31 days), with a reason
 *   (today's loans API needs one); a team with no line → "This team has no line: a loan needs a line for now" (L9).
 * Words are keys of the catalogues `teams-board` (the page, the loan) and `order-teams` (the part, the window, the ask).
 */

export const BOARD_NS = 'teams-board'
export const ORDER_TEAMS_NS = 'order-teams'

/** A key and its values: the views say it in the person's language. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const words = (key: string, params?: Words['params']): Words => (params ? { key, params } : { key })

// ── rights (the board's read has no `may`: the session's rights say what the page offers; the API checks again) ─────────────────

export interface TeamsRights {
  /** Give an order to a team, split, join, change (the production manager): production.teams.assign. */
  readonly give: boolean
  /** Lend a person to another team: today's loans API (people.loans.manage). */
  readonly lend: boolean
  /** Make a new team = a new unit that takes orders (People › Factory structure, people.structure.manage). */
  readonly newTeam: boolean
  /** The teams' people (today's GET /people/teams, people.view): the person chips of each column. */
  readonly people: boolean
}

export function teamsRightsOf(permissions: readonly string[]): TeamsRights {
  const has = (permission: string) => permissions.includes(permission)
  return { give: has('production.teams.assign'), lend: has('people.loans.manage'), newTeam: has('people.structure.manage'), people: has('people.view') }
}

// ── marks and load ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MARK_CODES = ['OVER_LIMIT', 'NO_NEW_ORDERS', 'MISSING_TODAY', 'LATE'] as const
export type MarkCode = (typeof MARK_CODES)[number]

/** Codes the server may also send for the same mark (read as one; never drawn as a code). */
const MARK_ALIASES: Readonly<Record<string, MarkCode>> = {
  OVER_LIMIT: 'OVER_LIMIT',
  OVER_ITS_LIMIT: 'OVER_LIMIT',
  NO_NEW_ORDERS: 'NO_NEW_ORDERS',
  NO_NEW_ORDER: 'NO_NEW_ORDERS',
  TAKES_NO_NEW_ORDER: 'NO_NEW_ORDERS',
  PAUSED: 'NO_NEW_ORDERS',
  MISSING_TODAY: 'MISSING_TODAY',
  MISSING: 'MISSING_TODAY',
  LATE: 'LATE',
}

export interface Mark {
  readonly code: MarkCode
  /** "2 missing today", "3 late": the number the server sent with the code (`MISSING_TODAY:2`), else null (the words without one). */
  readonly count: number | null
}

/** The marks of a column from the server's codes: known codes only (an unknown one is left out, never drawn), once each, in a fixed order. */
export function marksOf(codes: readonly string[]): Mark[] {
  const found = new Map<MarkCode, number | null>()
  for (const raw of codes) {
    const [name = '', tail] = String(raw).trim().toUpperCase().split(':')
    const code = MARK_ALIASES[name]
    if (!code) continue
    const count = tail !== undefined && /^\d+$/.test(tail) ? Number(tail) : null
    if (count === 0) continue
    if (!found.has(code) || (found.get(code) === null && count !== null)) found.set(code, count)
  }
  return MARK_CODES.filter((code) => found.has(code)).map((code) => ({ code, count: found.get(code) ?? null }))
}

/** The mark's tone: red over its limit and late, yellow people missing, quiet (neutral) a team that takes no new order. */
export function markToneOf(code: MarkCode): 'danger' | 'warning' | 'neutral' {
  return code === 'NO_NEW_ORDERS' ? 'neutral' : code === 'MISSING_TODAY' ? 'warning' : 'danger'
}

/** The mark in words: `mark.<CODE>` (no number) or `mark.<CODE>_n` with the count. */
export function markWordsOf(mark: Mark): Words {
  return mark.count === null ? words(`mark.${mark.code}`) : words(`mark.${mark.code}_n`, { count: mark.count })
}

/** A team's load: "9 of 12 baskets", "9 baskets" (no limit), or "—" (a small team: the API sent no figure). */
export type LoadModel = { readonly kind: 'small' } | { readonly kind: 'of'; readonly inWork: number; readonly max: number } | { readonly kind: 'count'; readonly inWork: number }

export function loadOf(load: { readonly inWork: number | null; readonly maxBaskets: number | null }): LoadModel {
  if (load.inWork === null) return { kind: 'small' }
  return load.maxBaskets !== null ? { kind: 'of', inWork: load.inWork, max: load.maxBaskets } : { kind: 'count', inWork: load.inWork }
}

export function loadWordsOf(load: LoadModel): Words {
  if (load.kind === 'small') return words('load.small')
  return load.kind === 'of' ? words('load.of', { count: load.inWork, max: load.max }) : words('load.count', { count: load.inWork })
}

// ── the board (7.1) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A person of a team, as today's GET /people/teams has them (names only: no figure about a person, ever). */
export interface MemberModel {
  readonly employeeId: string
  readonly name: string
  readonly isLead: boolean
  /** Lent to another line today: the chip says "on loan". */
  readonly onLoan: boolean
}

/** What today's teams read adds to a column: its people and its line (a loan needs one). */
export interface TeamPeople {
  readonly members: readonly MemberModel[]
  readonly lineId: string | null
}

/** Today's teams read by team id (null: the person may not read people, or the read failed). */
export function peopleByTeamOf(teams: readonly Team[] | null | undefined): ReadonlyMap<string, TeamPeople> | null {
  if (!teams) return null
  return new Map(
    teams.map((team) => {
      const members = [...team.members].sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name))
      return [team.id, { members: members.map((member) => ({ employeeId: member.employeeId, name: member.name, isLead: member.isLead, onLoan: member.onLoan !== null })), lineId: team.line?.id ?? null }]
    }),
  )
}

export interface CardModel {
  readonly orderId: string
  readonly number: string
  /** The floor's customer CODE (never the name). */
  readonly customerCode: string
  /** The order's baskets for this column (null: a small team, no figure). */
  readonly baskets: number | null
  readonly due: string | null
  readonly late: boolean
  /** This column's team is in charge of an order that several teams make (one team alone is not marked). */
  readonly inCharge: boolean
}

export interface ColumnModel {
  /** `none` for "No team yet", else the team's id. */
  readonly key: string
  readonly team: TeamFace | null
  readonly load: LoadModel
  readonly marks: readonly Mark[]
  readonly cards: readonly CardModel[]
  /** The team's people with the leader first (null: not read — no chip, no loan from the board). */
  readonly people: readonly MemberModel[] | null
  /** The team's line (a loan needs one); null without one or unknown. */
  readonly lineId: string | null
}

export interface BoardModel {
  readonly columns: readonly ColumnModel[]
  readonly teams: number
  /** Orders with at least one team (each once, however many teams it has). */
  readonly withTeam: number
  /** Orders in the column "No team yet". */
  readonly noTeam: number
}

export const NO_TEAM_KEY = 'none'

/** "No team yet" when the read sent no such column: drawn first, empty. */
const EMPTY_NONE: BoardColumn = { team: null, load: { inWork: null, maxBaskets: null }, marks: [], orders: [] }

/** The board: "No team yet" first, then the teams in the API's order. Nothing is counted for a team that the API did not count. */
export function boardModelOf(board: TeamsBoard, people: ReadonlyMap<string, TeamPeople> | null): BoardModel {
  const none = board.columns.find((column) => column.team === null)
  const teams = board.columns.filter((column) => column.team !== null)
  const onTeams = new Map<string, number>()
  for (const column of teams) for (const order of column.orders) onTeams.set(order.orderId, (onTeams.get(order.orderId) ?? 0) + 1)
  const columnOf = (column: BoardColumn): ColumnModel => {
    const own = column.team ? (people?.get(column.team.id) ?? null) : null
    return {
      key: column.team?.id ?? NO_TEAM_KEY,
      team: column.team,
      load: loadOf(column.load),
      marks: column.team ? marksOf(column.marks) : [],
      cards: column.orders.map((order) => ({ orderId: order.orderId, number: order.number, customerCode: order.customerCode, baskets: order.baskets, due: order.due, late: order.late, inCharge: order.inCharge && (onTeams.get(order.orderId) ?? 0) > 1 })),
      people: column.team && people ? (own?.members ?? []) : null,
      lineId: own?.lineId ?? null,
    }
  }
  const columns = [none ?? EMPTY_NONE, ...teams].map(columnOf)
  const withTeam = new Set(teams.flatMap((column) => column.orders.map((order) => order.orderId)))
  return { columns, teams: teams.length, withTeam: withTeam.size, noTeam: none?.orders.length ?? 0 }
}

/** The phone's filter: every column, "No team yet", or one team. An unknown filter (a team gone) shows every column. */
export function filterColumns(columns: readonly ColumnModel[], filter: string): readonly ColumnModel[] {
  if (filter === 'all') return columns
  const hit = columns.filter((column) => column.key === filter)
  return hit.length > 0 ? hit : columns
}

/** The order's Production tab address (its Team part): a card opens it. */
export const orderHref = (prefix: string, orderId: string): string => `${prefix}/sales/orders/${encodeURIComponent(orderId)}?tab=production`

// ── "Give to a team…" (7.2) ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface GiveRow {
  readonly teamId: string
  /** Its baskets while they are split; null while the teams work together (or for a team added after the print). */
  readonly share: number | null
  /** A share fixed at the first print: the row cannot be taken off and its number does not change. */
  readonly locked: boolean
}

export interface GiveDraft {
  readonly orderId: string
  readonly version: number
  readonly printed: boolean
  /** The baskets the order will have (the read's `plannedBaskets`). */
  readonly planned: number
  readonly mode: 'TOGETHER' | 'SPLIT'
  readonly rows: readonly GiveRow[]
  readonly inCharge: string | null
  readonly why: string
  /** The rows as read: Save is held while nothing changed. */
  readonly start: string
}

const keyOf = (draft: Pick<GiveDraft, 'mode' | 'rows' | 'inCharge'>): string =>
  JSON.stringify({ mode: draft.rows.length > 1 ? draft.mode : 'TOGETHER', rows: draft.rows.map((row) => [row.teamId, draft.mode === 'SPLIT' || row.locked ? row.share : null]), inCharge: draft.rows.length > 0 ? draft.inCharge : null })

/** The key of an order with no team (an empty start). */
const EMPTY_KEY = keyOf({ mode: 'TOGETHER', rows: [], inCharge: null })

/** The order had no team when the window opened ("Add a team below…"); with teams, an empty list means "no team at all". */
export const startedEmpty = (draft: Pick<GiveDraft, 'start'>): boolean => draft.start === EMPTY_KEY

/** The window's draft from the order's read: its rows as they are; split when any row has a share; ONE in charge. */
export function giveDraftOf(read: OrderTeams): GiveDraft {
  const split = read.rows.some((row) => row.basketShare !== null)
  const rows = read.rows.map((row) => ({ teamId: row.team.id, share: split ? row.basketShare : null, locked: read.printed && row.basketShare !== null }))
  const inCharge = read.rows.find((row) => row.inCharge)?.team.id ?? read.rows[0]?.team.id ?? null
  const draft: GiveDraft = { orderId: read.orderId, version: read.version, printed: read.printed, planned: read.plannedBaskets, mode: split ? 'SPLIT' : 'TOGETHER', rows, inCharge, why: '', start: '' }
  return { ...draft, start: keyOf(draft) }
}

/** n baskets over k teams as evenly as can be: the first teams take one more ("12 over 5" → 3 3 2 2 2). */
export function evenShares(n: number, k: number): number[] {
  if (k <= 0) return []
  const base = Math.floor(Math.max(0, n) / k)
  const rest = Math.max(0, n) % k
  return Array.from({ length: k }, (_, index) => base + (index < rest ? 1 : 0))
}

/** The baskets may be split: two teams or more, a basket for each, and not after the print (the shares were made at print). */
export function canSplitOf(draft: Pick<GiveDraft, 'rows' | 'planned' | 'printed'>): boolean {
  return !draft.printed && draft.rows.length >= 2 && draft.planned >= draft.rows.length
}

/** Why "They split the baskets" cannot be pressed (null: it can). */
export function splitHeldOf(draft: Pick<GiveDraft, 'rows' | 'planned' | 'printed'>): Words | null {
  if (draft.printed) return words('give.held.sharedAtPrint')
  if (draft.rows.length < 2) return words('give.held.splitTwo')
  return draft.planned < draft.rows.length ? words('give.held.splitTooFew', { count: draft.planned, teams: draft.rows.length }) : null
}

const withEven = (draft: GiveDraft): GiveDraft => {
  const shares = evenShares(draft.planned, draft.rows.length)
  return { ...draft, rows: draft.rows.map((row, index) => ({ ...row, share: shares[index] ?? 0 })) }
}

/** Add a team (once). The first team is in charge. While split (before the print) the baskets are shared evenly again. */
export function addTeam(draft: GiveDraft, teamId: string): GiveDraft {
  if (draft.rows.some((row) => row.teamId === teamId)) return draft
  const next: GiveDraft = { ...draft, rows: [...draft.rows, { teamId, share: null, locked: false }], inCharge: draft.inCharge ?? teamId }
  if (next.mode !== 'SPLIT' || draft.printed) return next
  return canSplitOf(next) ? withEven(next) : { ...next, mode: 'TOGETHER', rows: next.rows.map((row) => ({ ...row, share: null })) }
}

/** Take a team off (never a row whose share was fixed at the print). In charge moves to the first row; under two teams they work together. */
export function removeTeam(draft: GiveDraft, teamId: string): GiveDraft {
  const row = draft.rows.find((each) => each.teamId === teamId)
  if (!row || row.locked) return draft
  const rows = draft.rows.filter((each) => each.teamId !== teamId)
  const next: GiveDraft = { ...draft, rows, inCharge: draft.inCharge === teamId ? (rows[0]?.teamId ?? null) : draft.inCharge }
  if (draft.printed) return next
  if (rows.length < 2) return { ...next, mode: 'TOGETHER', rows: rows.map((each) => ({ ...each, share: null })) }
  return next.mode === 'SPLIT' ? withEven(next) : next
}

/** ONE team is in charge: its leader answers for the order. */
export function putInCharge(draft: GiveDraft, teamId: string): GiveDraft {
  return draft.rows.some((row) => row.teamId === teamId) ? { ...draft, inCharge: teamId } : draft
}

/** They work together · They split the baskets (only when it can: then shared evenly unless the numbers already add up, each ≥ 1). */
export function setMode(draft: GiveDraft, mode: 'TOGETHER' | 'SPLIT'): GiveDraft {
  if (draft.printed || mode === draft.mode) return draft
  if (mode === 'TOGETHER') return { ...draft, mode, rows: draft.rows.map((row) => ({ ...row, share: null })) }
  if (!canSplitOf(draft)) return draft
  const next: GiveDraft = { ...draft, mode }
  const fits = next.rows.every((row) => row.share !== null && row.share >= 1) && givenOf(next) === next.planned
  return fits ? next : withEven(next)
}

/** A team's baskets, typed or by its − / + (a whole number, 0 … the planned baskets); never a row fixed at the print. */
export function setShare(draft: GiveDraft, teamId: string, value: number): GiveDraft {
  if (draft.mode !== 'SPLIT' || draft.printed || !Number.isFinite(value)) return draft
  const share = Math.max(0, Math.min(draft.planned, Math.round(value)))
  return { ...draft, rows: draft.rows.map((row) => (row.teamId === teamId && !row.locked ? { ...row, share } : row)) }
}

/** "Share them evenly". */
export function shareEvenly(draft: GiveDraft): GiveDraft {
  return draft.mode === 'SPLIT' && !draft.printed && draft.rows.length >= 2 ? withEven(draft) : draft
}

export function withWhy(draft: GiveDraft, why: string): GiveDraft {
  return { ...draft, why: why.slice(0, GIVE_WHY_MAX) }
}

export const GIVE_WHY_MAX = 140

/** The baskets given so far (the split's shares). */
export function givenOf(draft: Pick<GiveDraft, 'rows'>): number {
  return draft.rows.reduce((sum, row) => sum + (row.share ?? 0), 0)
}

/** The line "9 of 12 baskets are given": ok, n more to give, or n too many (only while split before the print). */
export function sumLineOf(draft: GiveDraft): { readonly state: 'ok' | 'short' | 'over'; readonly words: Words } | null {
  if (draft.mode !== 'SPLIT' || draft.rows.length < 2 || draft.printed) return null
  const given = givenOf(draft)
  if (given === draft.planned) return { state: 'ok', words: words('give.sum.ok', { given, planned: draft.planned }) }
  return given < draft.planned ? { state: 'short', words: words('give.sum.short', { given, planned: draft.planned, count: draft.planned - given }) } : { state: 'over', words: words('give.sum.over', { given, planned: draft.planned, count: given - draft.planned }) }
}

/** Why Save waits (null: it saves). Held, never a stop without words. */
export function giveHeldOf(draft: GiveDraft): Words | null {
  if (draft.rows.length === 0 && startedEmpty(draft)) return words('give.held.addTeam')
  if (keyOf(draft) === draft.start) return words('give.held.unchanged')
  if (draft.mode === 'SPLIT' && draft.rows.length > 1 && !draft.printed) {
    if (draft.rows.some((row) => (row.share ?? 0) < 1)) return words('give.held.shareZero')
    const given = givenOf(draft)
    if (given !== draft.planned) return words('give.held.notAddUp', { given, planned: draft.planned })
  }
  return null
}

/** The body of PUT …/teams: ONE in charge, a share only when split (and the shares fixed at the print), the why when typed. */
export function putBodyOf(draft: GiveDraft): { version: number; rows: OrderTeamPut[]; why?: string } {
  const split = draft.mode === 'SPLIT' && draft.rows.length > 1
  const inCharge = draft.rows.some((row) => row.teamId === draft.inCharge) ? draft.inCharge : (draft.rows[0]?.teamId ?? null)
  const rows = draft.rows.map((row) => ({ teamId: row.teamId, inCharge: row.teamId === inCharge, basketShare: row.locked ? row.share : split && !draft.printed ? row.share : null }))
  const why = draft.why.trim()
  return why ? { version: draft.version, rows, why } : { version: draft.version, rows }
}

/** What the rows say together, for one line under them ("Every team sees every basket…", "Each team makes its own baskets…"). */
export function modeNoteOf(draft: GiveDraft): Words | null {
  if (draft.rows.length < 2) return draft.rows.length === 0 && !startedEmpty(draft) ? words('give.note.noTeam') : null
  if (draft.printed) return words(draft.mode === 'SPLIT' ? 'give.note.sharedAtPrint' : 'give.note.together')
  return words(draft.mode === 'SPLIT' ? 'give.note.split' : 'give.note.together')
}

// ── a row's facts: from the order's read (a team on it) or from the board (a team added in the window) ──────────────────────

export interface RowFacts {
  readonly face: TeamFace
  readonly leaderName: string | null
  /** The team's people (null: a small team or not sent). */
  readonly people: number | null
  readonly load: LoadModel
  readonly workedForCustomer: boolean
  readonly takesNewOrders: boolean
  readonly overLimit: boolean
  readonly missingToday: number | null
  readonly late: number | null
}

/** The marks of a row's facts (the window's chips), in the board's order. */
export function factMarksOf(facts: RowFacts): { readonly worked: boolean; readonly marks: readonly Mark[] } {
  const marks: Mark[] = []
  if (facts.overLimit) marks.push({ code: 'OVER_LIMIT', count: null })
  if (!facts.takesNewOrders) marks.push({ code: 'NO_NEW_ORDERS', count: null })
  if (facts.missingToday) marks.push({ code: 'MISSING_TODAY', count: facts.missingToday })
  if (facts.late) marks.push({ code: 'LATE', count: facts.late })
  return { worked: facts.workedForCustomer, marks }
}

const factsOfRead = (face: TeamFace, facts: TeamFacts): RowFacts => ({
  face,
  leaderName: face.leader?.name ?? null,
  people: face.people,
  load: loadOf(facts),
  workedForCustomer: facts.workedForCustomer,
  takesNewOrders: facts.takesNewOrders,
  overLimit: facts.overLimit,
  missingToday: facts.missingToday,
  late: facts.late,
})

/** The order's customer code as the board knows it (the order's own card), else null. */
export function customerCodeOf(board: TeamsBoard | null, orderId: string): string | null {
  for (const column of board?.columns ?? []) for (const order of column.orders) if (order.orderId === orderId) return order.customerCode
  return null
}

const factsOfBoard = (team: BoardTeam, board: TeamsBoard, orderId: string, customerCode: string | null): RowFacts => {
  const column = board.columns.find((each) => each.team?.id === team.id)
  const marks = column ? marksOf(column.marks) : []
  const count = (code: MarkCode) => marks.find((mark) => mark.code === code)?.count ?? null
  return {
    face: team,
    leaderName: team.leader?.name ?? null,
    people: team.people,
    load: column ? loadOf(column.load) : { kind: 'small' },
    workedForCustomer: !!customerCode && !!column && column.orders.some((order) => order.orderId !== orderId && order.customerCode === customerCode),
    takesNewOrders: team.takesNewOrders,
    overLimit: marks.some((mark) => mark.code === 'OVER_LIMIT'),
    missingToday: count('MISSING_TODAY'),
    late: count('LATE'),
  }
}

/** Each row of the draft with its facts: the read's for a team that was on the order, the board's for one added here. */
export function rowFactsOf(draft: GiveDraft, read: OrderTeams, board: TeamsBoard | null): ReadonlyMap<string, RowFacts> {
  const out = new Map<string, RowFacts>()
  const customerCode = customerCodeOf(board, draft.orderId)
  for (const row of draft.rows) {
    const onOrder = read.rows.find((each) => each.team.id === row.teamId)
    const onBoard = board?.teams.find((team) => team.id === row.teamId)
    if (onOrder) out.set(row.teamId, factsOfRead(onOrder.team, onOrder.facts))
    else if (onBoard && board) out.set(row.teamId, factsOfBoard(onBoard, board, draft.orderId, customerCode))
  }
  return out
}

export interface Candidate {
  readonly facts: RowFacts
  /** The team that worked for this customer (now) and takes new orders: first in the list, marked "Suggested". */
  readonly suggested: boolean
}

/**
 * "Add a team": every team of the board not on the order yet, the suggested one first (it worked for this customer and takes new
 * orders; a team that takes no new order is never suggested, but it stays in the list), then the API's order; the search keeps the
 * names that hold every word typed (letter case and accents aside).
 */
export function candidatesOf(draft: GiveDraft, board: TeamsBoard | null, query: string): readonly Candidate[] {
  if (!board) return []
  const customerCode = customerCodeOf(board, draft.orderId)
  const all = board.teams.filter((team) => !draft.rows.some((row) => row.teamId === team.id)).map((team) => factsOfBoard(team, board, draft.orderId, customerCode))
  const pick = all.find((facts) => facts.workedForCustomer && facts.takesNewOrders)?.face.id ?? null
  const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
  const terms = fold(query).split(/\s+/).filter(Boolean)
  const shown = all.filter((facts) => terms.every((term) => fold(facts.face.name).includes(term)))
  return [...shown.filter((facts) => facts.face.id === pick), ...shown.filter((facts) => facts.face.id !== pick)].map((facts) => ({ facts, suggested: facts.face.id === pick }))
}

// ── "Lend a person" (7.2) ────────────────────────────────────────────────────────────────────────────────────────────────────

export const LEND_UNTIL = ['TODAY', 'THREE_DAYS', 'WEEK', 'DAY'] as const
export type LendUntil = (typeof LEND_UNTIL)[number]

/** A loan lasts at most 31 days (today's loans rule): the last day is at most 30 days after today. */
export const LEND_MAX_DAYS = 31
export const LEND_REASON_MAX = 300

/** A calendar day (YYYY-MM-DD) plus n days. */
export function plusDays(day: string, days: number): string {
  const at = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(at) ? day : new Date(at + days * 86_400_000).toISOString().slice(0, 10)
}

/** The last day the person may be lent until (today counts as the first of the 31). */
export const lendMaxDayOf = (today: string): string => plusDays(today, LEND_MAX_DAYS - 1)

/** The loan's last day: today · 3 days (today + 2) · a week (today + 6) · the day picked. */
export function lastDayOf(until: LendUntil, today: string, picked: string): string | null {
  if (until === 'TODAY') return today
  if (until === 'THREE_DAYS') return plusDays(today, 2)
  if (until === 'WEEK') return plusDays(today, 6)
  return /^\d{4}-\d{2}-\d{2}$/.test(picked) ? picked : null
}

export interface LendDraft {
  readonly employeeId: string
  readonly name: string
  /** The person's home team: never offered as "to which team". */
  readonly homeTeamId: string | null
  readonly toTeamId: string | null
  readonly until: LendUntil
  readonly picked: string
  readonly reason: string
}

export function lendDraftOf(person: { employeeId: string; name: string }, homeTeamId: string | null): LendDraft {
  return { employeeId: person.employeeId, name: person.name, homeTeamId, toTeamId: null, until: 'TODAY', picked: '', reason: '' }
}

/** The teams a person may be lent to: every team of the board but the home team. */
export function lendTeamsOf(draft: Pick<LendDraft, 'homeTeamId'>, board: TeamsBoard | null): readonly BoardTeam[] {
  return (board?.teams ?? []).filter((team) => team.id !== draft.homeTeamId)
}

/** Why "Lend" waits (null: it lends). A team without a line cannot take a loan for now (L9). */
export function lendHeldOf(draft: LendDraft, toLineId: string | null | undefined, today: string): Words | null {
  if (!draft.toTeamId) return words('lend.held.team')
  if (!toLineId) return words('lend.held.noLine')
  const last = lastDayOf(draft.until, today, draft.picked)
  if (!last || last < today || last > lendMaxDayOf(today)) return words('lend.held.day', { count: LEND_MAX_DAYS })
  const reason = draft.reason.trim()
  if (!reason) return words('lend.held.reason')
  return reason.length > LEND_REASON_MAX ? words('lend.held.reasonLong', { count: LEND_REASON_MAX }) : null
}

/** The body of today's POST /people/loans: from now (the next quarter hour) to the end of the last day in the site's zone. */
export function lendBodyOf(draft: LendDraft, toLineId: string, today: string, startsAt: string, endOfDay: (day: string) => string): { employeeId: string; toLineId: string; toTeamId: string; startsAt: string; endsAt: string; reason: string } | null {
  const last = lastDayOf(draft.until, today, draft.picked)
  if (!draft.toTeamId || !last) return null
  return { employeeId: draft.employeeId, toLineId, toTeamId: draft.toTeamId, startsAt, endsAt: endOfDay(last), reason: draft.reason.trim() }
}

/** A loan refusal in words: today's loans codes (`refusal/<CODE>`), else the kind of the failure. */
export const LEND_REFUSALS = ['LEFT', 'LINE_NOT_OF_SITE', 'TEAM_OTHER_SITE', 'TEAM_ARCHIVED', 'TEAM_OTHER_LINE', 'LOAN_OVERLAP', 'TEAM_NO_LINE', 'NO_LINE'] as const

// ── the order's Team part (7.3) ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PartChip {
  readonly face: TeamFace
  readonly leaderName: string | null
  /** Said only when several teams work together. */
  readonly inCharge: boolean
  /** Its baskets while split (null together). */
  readonly share: number | null
}

export type PartButton = 'GIVE' | 'CHANGE' | 'ASK' | 'ASKED' | null

export interface PartModel {
  readonly empty: boolean
  readonly answer: Words
  readonly chips: readonly PartChip[]
  /** Before the first print the baskets are still to come ("6 baskets to come"). */
  readonly soon: boolean
  readonly byRule: boolean
  /** The ONE button the person may press: give / change (the production manager), ask / asked (sales). */
  readonly button: PartButton
}

/** The words of an order's teams: "No team yet" · the team · "A: 6 baskets · B: 6 baskets" · "A + B together · A is in charge". */
export function teamsAnswerOf(read: Pick<OrderTeams, 'rows' | 'printed'>): Words {
  const rows = read.rows
  if (rows.length === 0) return words('part.none')
  if (rows.length === 1) return words('part.one', { team: rows[0]!.team.name })
  const soon = !read.printed
  if (rows.some((row) => row.basketShare !== null)) return words(soon ? 'part.splitSoon' : 'part.split', { teams: rows.map((row) => `${row.team.name}: ${row.basketShare ?? 0}`).join(' · ') })
  const boss = rows.find((row) => row.inCharge) ?? rows[0]!
  return words('part.together', { teams: rows.map((row) => row.team.name).join(' + '), team: boss.team.name })
}

export function partModelOf(read: OrderTeams, asked: boolean): PartModel {
  const together = read.rows.length > 1 && !read.rows.some((row) => row.basketShare !== null)
  const button: PartButton = read.may.give ? (read.rows.length > 0 ? 'CHANGE' : 'GIVE') : read.may.ask ? (asked ? 'ASKED' : 'ASK') : null
  return {
    empty: read.rows.length === 0,
    answer: teamsAnswerOf(read),
    chips: read.rows.map((row) => ({ face: row.team, leaderName: row.team.leader?.name ?? null, inCharge: together && row.inCharge, share: row.basketShare })),
    soon: !read.printed,
    byRule: read.rows.length > 0 && read.rows.every((row) => row.givenBy === 'RULE'),
    button,
  }
}

/** The why of "Ask for another team": needed, at most 300 characters. */
export const ASK_WHY_MAX = 300
export function askHeldOf(why: string): Words | null {
  const text = why.trim()
  if (!text) return words('ask.held.why')
  return text.length > ASK_WHY_MAX ? words('ask.held.long', { count: ASK_WHY_MAX }) : null
}

// ── failures in words ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A failed call as a key of the catalogue: no right · no answer · changed meanwhile · refused · anything else. */
export function problemKeyOf(error: unknown, write: boolean): string {
  const kind = typeof error === 'object' && error !== null && 'kind' in error ? String((error as { kind: unknown }).kind) : ''
  if (kind === 'forbidden' || kind === 'step_up') return 'error.forbidden'
  if (kind === 'unavailable') return 'error.offline'
  if (kind === 'not_found') return 'error.notFound'
  if (write && kind === 'conflict') return 'error.conflict'
  if (write && kind === 'invalid') return 'error.invalid'
  return write ? 'error.write' : 'error.read'
}

/** A refusal code of the answer (`refusal/<CODE>`), else null. */
export function refusalOf(error: unknown): string | null {
  const issues = typeof error === 'object' && error !== null && 'issues' in error ? (error as { issues: unknown }).issues : null
  if (!Array.isArray(issues)) return null
  for (const issue of issues) {
    const path = typeof issue === 'object' && issue !== null && 'path' in issue ? (issue as { path: unknown }).path : null
    const text = typeof path === 'string' ? path : Array.isArray(path) ? path.join('/') : ''
    if (text.startsWith('refusal/')) return text.slice('refusal/'.length).split(/[/.]/)[0] || null
  }
  return null
}

/** A loan refusal in words: a known code its own words, else the failure's kind. */
export function lendProblemOf(error: unknown): string {
  const code = refusalOf(error)
  if (code && (LEND_REFUSALS as readonly string[]).includes(code)) return code === 'TEAM_NO_LINE' || code === 'NO_LINE' ? 'lend.held.noLine' : `lend.refusal.${code}`
  return problemKeyOf(error, true)
}
