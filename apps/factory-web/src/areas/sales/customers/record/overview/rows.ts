import { WARNING_ACTION, type NextAction } from '../../../../parties/_shared/model'
import { openAfterSales } from '../../money/model'
import type { DesignerPerson } from '../../portal/designer/api' // F-CO-201
import { changeHeldOf, personTagOf, portalLineOf, type Phrase } from '../../portal/designer/model' // F-CO-201
import { supervisorHeld } from '../../portal/limits/model' // F-CO-201
import { requestsDoorOf, tileOf, type TileRead } from '../use-customer-work'
import { valueOf as tileValueOf } from '../work-band'
import { complaintDoor, complaintsDoor, depositDoor, moneyDoor, ordersDoor, projectsDoor, promiseDoor, quotesDoor, receivablesDoor, repairsDoor, sampleDoor, samplesDoor, tabDoor, termsDoor, workOrdersDoor } from './doors'
import { peopleAddDoor, peopleDoor } from './doors' // F-CA-121: People & addresses' section ids
import { boardNumbersOf, boardOf, headlineOf, nextPromiseOf } from './headline'
import { overAmountsOf, stepDoorOf, stripsOf } from './strips'
import {
  amountOf,
  dayOf,
  daysBetween,
  daySay,
  depth,
  glanceOf,
  joined,
  linkDoor,
  ov,
  readyOf,
  say,
  stepDoor,
  text,
  type BandState,
  type CustomerOverviewModel,
  type DatesCard,
  type FactRow,
  type FactsCard,
  type LabelledDoor,
  type LinkedCard,
  type LooksAfter,
  type OverviewDoor,
  type OverviewInput,
  type OverviewRow,
  type Param,
  type PeopleCard,
  type RequestGroup,
  type RequestRow,
  type RequestsCard,
  type RowPart,
  type RowTag,
  type Say,
  wholeComplaints,
  wholeReturns,
} from './model'

/**
 * F-CO-101 (customer page › Overview; 10-design §3–§8; lead settles S5, S9, S24, S25, S28) — the cards under the standing, as rows:
 * People (their contacts; a rider's team), Next dates (the next one of each kind, a late one first), Requests & changes (grouped by
 * who waits: the Work band's own counts, `tileOf`, and the page's ONE count read), Linked records (one row per kind whose VALUE names
 * the next one) and Customer facts. Pure: a row is words, a tone and a door; the view draws it with the kit's parts.
 *
 * The orders' and quotes' numbers are the board's and the count reads' own (the API's rules, walled to the customer): this file
 * walks a list only to find the NEXT or the OLDEST one of a kind (a date and a name, never a count of orders or quotes).
 */

const href = (address: string): OverviewDoor => ({ kind: 'href', href: address })

/** The item with the earliest day among those that have one (null: none has). */
function earliestOf<T>(items: readonly T[], at: (item: T) => string | null | undefined): { readonly item: T; readonly at: string } | null {
  let best: { item: T; at: string } | null = null
  for (const item of items) {
    const when = at(item)
    if (when && (best === null || when < best.at)) best = { item, at: when }
  }
  return best
}

/**
 * S37 (with S35): the reads a row names "the next" or "the oldest" one from, and whether each is ORDERED earliest first by that day
 * where it is cut — checked in the API, 2026-11-24. Only such a read cannot hide the earliest one behind its cut.
 */
export const EARLIEST_FIRST = Object.freeze({
  /** GET /sales/orders?partyId&open=true: newest order first (`id` desc); cut: `more` (a next page). */
  deposits: false,
  /** GET /tasks?scope=PARTY: the 200 NEWEST by creation are read, THEN sorted by due day; cut: `complete` false. */
  tasks: false,
  /** GET /partners/:partyId/tasks?status=OPEN: the 1,000 NEWEST by creation, THEN sorted by due day; cut: `complete` false. */
  asks: false,
  /** GET /quality/complaints?view=open: newest received first; cut: the read's 50 rows filled (S35). */
  complaints: false,
  /** The glance's sample rounds: by due day, nearest first (5 rows); cut: fewer rows than its count. */
  samples: true,
  /** The glance's repairs: newest first (5 rows); cut: fewer rows than its count — the oldest is exactly what the cut hides. */
  repairs: false,
} as const)
export type NamedRead = keyof typeof EARLIEST_FIRST

/**
 * S37: the earliest one of a read — from a WHOLE read always; from a read that may be cut only when that read is ordered earliest first
 * by that day (else null: the row, or the part that names it, is left out — never a wrong "next" or "oldest").
 */
export function earliestKeptOf<T>(read: NamedRead, whole: boolean, items: readonly T[], at: (item: T) => string | null | undefined): { readonly item: T; readonly at: string } | null {
  return whole || EARLIEST_FIRST[read] ? earliestOf(items, at) : null
}

// ---- card 2: the bigger picture ----------------------------------------------------------------------------------------------

/** The band, or — for a customer with no order at all — one quiet line and the "Before an order" doors; `off` without orders.view. */
export function bandStateOf(input: Pick<OverviewInput, 'can' | 'reads'>): BandState {
  const board = boardOf(input)
  if (board.status === 'off') return 'off'
  return board.status === 'ready' && boardNumbersOf(board.value).total === 0 ? 'none' : 'band'
}

// ---- card 3: People ----------------------------------------------------------------------------------------------------------

/**
 * People, both sides (10-design §4; lead settle S10): who looks after the customer here — the production supervisor ("Office only"),
 * its backup, the factory designer and its backup ("<customer> sees this name") — then the customer's own contacts for orders and for
 * invoices (each person ONCE; nobody: "Nobody yet" with Add contact, parties.manage), whether its portal is on, a rider's team.
 * "Who looks after" is read with partners.view only (`looksAfter` null without: its rows and the Portal row are left out). Its two
 * Change… open ONE window each, each under its OWN right (production.brand.manage, partners.manage: without it, no button); held with
 * words only by state or reach. While the supervisor's read is out the card is a skeleton; when it failed, the card says so.
 */
export function peopleOf(input: OverviewInput): PeopleCard {
  const { party, can, prefix } = input
  const id = party.id
  const head = linkDoor('people', say('customers.tab.people'), peopleDoor(prefix, id, 'people')) // F-CA-121
  const looksAfter = input.looksAfter
  if (looksAfter && !looksAfter.supervisor.read) {
    const supervisor = looksAfter.supervisor
    if (supervisor.state === 'error') return { rows: [], head, state: 'failed', problem: say(`portal-access:${supervisor.problem ?? 'failed.title'}`) }
    return { rows: [], head, state: 'reading', problem: null }
  }
  const contacts: OverviewRow[] = []
  let orders = false
  let invoices = false
  // The contacts for orders first (a person with both roles is listed once, here), then those for invoices only.
  for (const pass of ['ORDERS', 'INVOICES'] as const) {
    for (const contact of party.contacts) {
      if (contact.status !== 'ACTIVE') continue
      const forOrders = contact.roles.includes('ORDERS')
      const forInvoices = contact.roles.includes('INVOICES')
      if (pass === 'ORDERS' ? !forOrders : forOrders || !forInvoices) continue
      orders ||= forOrders
      invoices ||= forInvoices
      contacts.push({
        key: `contact-${contact.id}`,
        label: ov(forOrders && forInvoices ? 'people.contactBoth' : forOrders ? 'people.contactOrders' : 'people.contactInvoices'),
        parts: [{ say: text(contact.name) }],
        ...(contact.email ? { under: [text(contact.email)] } : {}),
      })
    }
  }
  const add: LabelledDoor[] = can.manage ? [stepDoor('contact', say('step.action.contact'), href(peopleAddDoor(prefix, id, 'contact')) /* F-CA-121 */, party.status === 'ARCHIVED' ? say('held.archived') : null)] : []
  const nobody = (key: string, label: string): OverviewRow => ({ key, label: ov(label), parts: [{ say: ov('people.nobody') }], ...(add.length > 0 ? { doors: add } : {}) })
  if (!orders && !invoices) contacts.push(nobody('nobody', 'people.contactBoth'))
  else if (!orders) contacts.unshift(nobody('nobody-orders', 'people.contactOrders'))
  else if (!invoices) contacts.push(nobody('nobody-invoices', 'people.contactInvoices'))
  const rows: OverviewRow[] = [...(looksAfter ? officeRowsOf(input, looksAfter) : []), ...contacts]
  const portal = looksAfter ? portalRowOf(input, looksAfter) : null
  if (portal) rows.push(portal)
  // A rider: its team (named only when the glance sends it: the reader may see that customer).
  const team = glanceOf(input.glance)?.team ?? null
  if (team) rows.push({ key: 'team', label: depth('team.title'), parts: [{ say: text(team.name), door: href(tabDoor(prefix, team.id, 'overview')) }] })
  return { rows, head, state: 'ready', problem: null }
}

/** F-CO-201: a designer word (its own `Phrase`: the parties catalogue with the customer named, or the partners screens' own). */
function phraseSay(phrase: Phrase, customer: string): Say {
  return say(phrase.ns ? `${phrase.ns}:${phrase.key}` : phrase.key, { customer, ...(phrase.params ?? {}) })
}

/**
 * F-CO-201: our people for this customer — office only, read with partners.view. Production supervisor (the name + "Office only"; a
 * person no longer active says so) · Backup · Factory designer (the name + what the customer sees of it, " · backup <name>", the line
 * of what the portal names now). Each Change… is the page's own window.
 */
function officeRowsOf(input: OverviewInput, looksAfter: LooksAfter): OverviewRow[] {
  const { party } = input
  const customer = party.tradeName ?? party.legalName
  const archived = party.status === 'ARCHIVED' ? say('held.archived') : null
  const supervisor = looksAfter.supervisor
  const production = supervisor.read!.production
  const rows: OverviewRow[] = []
  const inactive = (person: { readonly active: boolean }): RowPart[] => (person.active ? [] : [{ say: say('production-supervisor:fact.inactive'), quiet: true }])
  // Change… (the supervisor) only with production.brand.manage; held by state (archived) or reach (not at every company).
  const reach = supervisorHeld(supervisor.supervise, supervisor.pick)
  const changeSupervisor: LabelledDoor[] = supervisor.supervise ? [stepDoor('changeSupervisor', say('production-supervisor:fact.change'), { kind: 'act', act: 'changeSupervisor' }, archived ?? (reach ? say(`${reach.ns}:${reach.key}`) : null))] : []
  const named = production.supervisor
  rows.push({
    key: 'supervisor',
    label: say('portal-access:limits.supervisor.label'),
    parts: named ? [{ say: text(named.name) }, ...inactive(named)] : [{ say: say('portal-access:limits.supervisor.none') }],
    ...(named ? { tag: { say: say('portal-access:limits.supervisor.officeOnly'), tone: 'info' as const, mark: 'office' as const } } : {}),
    ...(changeSupervisor.length > 0 ? { doors: changeSupervisor } : {}),
  })
  rows.push({ key: 'backup', label: say('portal-access:limits.supervisor.backup'), parts: production.backup ? [{ say: text(production.backup.name) }, ...inactive(production.backup)] : [{ say: text('—') }] })

  const designer = looksAfter.designer
  if (!designer) return rows
  const label = say('customers.designer.label')
  const read = designer.read
  if (read.status === 'loading') {
    rows.push({ key: 'designer', label, parts: [], state: 'reading' })
    return rows
  }
  if (read.status === 'error') {
    // Its own words and Try again (the supervisor's rows stand: a designer read that failed never hides them).
    rows.push({ key: 'designer', label, parts: [{ say: say('customers.designer.readFailed'), quiet: true }], doors: [stepDoor('retryDesigner', say('portal-access:common.retry'), { kind: 'act', act: 'retryDesigner' })] })
    return rows
  }
  const slot = read.slot
  const tagOf = (person: DesignerPerson): RowTag => {
    const tag = personTagOf(person)
    return { say: phraseSay(tag.words, customer), tone: tag.tone, mark: tag.tone === 'info' ? 'seen' : 'warning' }
  }
  const parts: RowPart[] = [{ say: slot.designer ? text(slot.designer.name) : say('customers.designer.none') }]
  if (slot.backup) {
    parts.push({ say: ov('people.backupNamed', { name: slot.backup.name }) })
    if (slot.backup.state !== 'OK') parts.push({ say: phraseSay(personTagOf(slot.backup).words, customer), quiet: true })
  }
  // Change… (the designer) only with partners.manage; held by state (archived) or reach (not at every company the customer works with).
  const reachDesigner = changeHeldOf(true, read)
  rows.push({
    key: 'designer',
    label,
    parts,
    ...(slot.designer ? { tag: tagOf(slot.designer) } : {}),
    // F-CO-301 (co-t T.1): after a change, its receipt stays under the row ("Saved: …"), as the card drew it under its rows.
    under: [phraseSay(portalLineOf(slot), customer), ...(designer.notice ? [phraseSay(designer.notice, customer)] : [])],
    ...(designer.manage ? { doors: [stepDoor('changeDesigner', say('customers.designer.change'), { kind: 'act', act: 'changeDesigner' }, archived ?? (reachDesigner ? phraseSay(reachDesigner, customer) : null))] } : {}),
  })
  return rows
}

/** F-CO-201: whether the customer's portal is on (the designer's slot says it) and the door to Portal settings (partners.view). */
function portalRowOf(input: OverviewInput, looksAfter: LooksAfter): OverviewRow | null {
  const designer = looksAfter.designer
  if (!designer) return null
  const label = say('portal-access:settings.title')
  const read = designer.read
  if (read.status !== 'ready') return { key: 'portal', label, parts: [], state: read.status === 'loading' ? 'reading' : 'unread' }
  return {
    key: 'portal',
    label,
    parts: [{ say: say(read.slot.portalOn ? 'portal-access:settings.on' : 'portal-access:settings.off') }, { say: say('customers.tab.portal'), door: href(tabDoor(input.prefix, input.party.id, 'portal')) }],
  }
}

// ---- card 4: Next dates ------------------------------------------------------------------------------------------------------

/** A date's tag: late by N days (danger), today (warning), in N days (neutral). */
export function dayTagOf(day: string, today: string): RowTag {
  const days = daysBetween(today, day)
  if (days < 0) return { say: ov('dates.tag.daysLate', { count: -days }), tone: 'danger' }
  if (days === 0) return { say: say('customers-list:prom.today'), tone: 'warning' }
  return { say: say('customers-list:prom.in', { days }), tone: 'neutral' }
}

interface DatedRow {
  readonly row: OverviewRow
  /** The row's day (null: none — it stands last; empty: before every date); `late` rows stand first. */
  readonly at: string | null
  readonly late: boolean
}

/**
 * The next date of each kind, a late one first, then the nearest first (S5: short labels, the VALUE is the door, "n without a
 * promise date" as plain words in the next-promise row; S25: "next promise"). null: no date at all and nothing still read — the
 * card is LEFT OUT (S24). A failed glance is never silent: its rows are left out and one line says so.
 */
export function datesOf(input: OverviewInput): DatesCard | null {
  const { party, can, prefix, today } = input
  const id = party.id
  const dated: DatedRow[] = []
  const put = (row: OverviewRow, at: string | null, late = at !== null && at < today) => dated.push({ row, at, late })
  const named = (number: string, day: string): Say => joined([text(number), dayOf(day)])
  let reading = false

  // The board's late orders, and the next promise over every company (this customer's row of the joined read).
  const board = boardOf(input)
  if (board.status === 'reading') reading = true
  const numbers = board.status === 'ready' ? boardNumbersOf(board.value) : null
  if (numbers && numbers.late > 0) {
    // The late orders stand first of all (no day of their own: the empty day sorts before every date).
    put({ key: 'late', label: say('customers.work.tile.late'), parts: [{ say: ov('dates.late', { count: numbers.late }), door: href(ordersDoor(prefix, id, { kind: 'late' })) }], tag: { say: ov('dates.tag.late'), tone: 'danger' } }, '', true)
  }
  if (input.standing.status === 'reading') reading = true
  const glance = glanceOf(input.glance)
  if (input.glance.status === 'loading') reading = true
  if (numbers && numbers.open > 0 && readyOf(input.standing)) {
    const next = nextPromiseOf(input)
    const without = glance?.promises?.noPromise ?? 0
    const quiet: RowPart[] = without > 0 ? [{ say: depth('promises.without', { count: without }), quiet: true }] : []
    if (next !== null) put({ key: 'promise', label: say('customers-list:col.nextPromise'), parts: [{ say: daySay(next), door: href(promiseDoor(prefix, id)) }, ...quiet], tag: dayTagOf(next, today) }, next)
    else put({ key: 'promise', label: say('customers-list:col.nextPromise'), parts: [{ say: depth('promises.noneComing'), door: href(promiseDoor(prefix, id)) }, ...quiet] }, null)
  }

  // The next deposit an open order waits for (the open orders' own read: orders.view).
  const deposits = can.orders ? input.money.orders : null
  if (deposits && deposits.items === null && !deposits.problem) reading = true
  const deposit = deposits?.items ? earliestKeptOf('deposits', deposits.more !== true, deposits.items, (order) => (order.deposit.state === 'OPEN' ? order.deposit.dueDate : null)) : null
  if (deposit) put({ key: 'deposit', label: ov('dates.deposit'), parts: [{ say: named(deposit.item.number, deposit.at), door: href(depositDoor(prefix, id, can.moneyTab)) }], tag: dayTagOf(deposit.at, today) }, deposit.at)

  // The next sample round due (the glance sends them earliest due first; withheld without the samples right).
  const sample = glance?.samples ? earliestKeptOf('samples', glance.samples.rows.length >= glance.samples.count, glance.samples.rows, (round) => round.dueDate) : null
  if (sample) put({ key: 'sample', label: ov('dates.sample'), parts: [{ say: named(sample.item.number, sample.at), door: href(sampleDoor(prefix, sample.item.id)) }], tag: dayTagOf(sample.at, today) }, sample.at)

  // What we asked of the customer (partners.view) and the open tasks: their windows open on the Work tab.
  const asks = input.reads.asks
  if (asks.status === 'reading') reading = true
  const ask = asks.status === 'ready' ? earliestKeptOf('asks', asks.value.complete, asks.value.items, (item) => (item.status === 'OPEN' ? item.dueAt : null)) : null
  if (ask) put({ key: 'ask', label: ov('dates.ask'), parts: [{ say: ov('dates.titled', { title: ask.item.words, date: dayOf(ask.at) }), door: { kind: 'window', window: 'customer' } }], tag: dayTagOf(ask.at, today) }, ask.at)
  const tasks = input.reads.tasks
  if (tasks.status === 'reading') reading = true
  const task = tasks.status === 'ready' ? earliestKeptOf('tasks', tasks.value.complete, tasks.value.items, (item) => item.dueDate) : null
  if (task) put({ key: 'task', label: ov('dates.task'), parts: [{ say: ov('dates.titled', { title: task.item.title, date: dayOf(task.at) }), door: { kind: 'window', window: 'tasks' } }], tag: dayTagOf(task.at, today) }, task.at)

  // The next answer a complaint waits for (quality.complaints.view): its door is the NAMED complaint's own page (S28). S33: only from
  // a whole read — the read is newest first, so a cut one may miss the complaint whose answer is due first (Linked records says "Open").
  const complaints = can.complaints ? input.money.complaints : null
  if (complaints && complaints.items === null && !complaints.problem) reading = true
  const complaint = complaints?.items ? earliestKeptOf('complaints', wholeComplaints(complaints), openAfterSales([], complaints.items).complaints, (entry) => entry.answerDueOn) : null
  if (complaint) put({ key: 'complaint', label: ov('dates.complaint'), parts: [{ say: named(complaint.item.number, complaint.at), door: href(complaintDoor(prefix, complaint.item.id)) }], tag: dayTagOf(complaint.at, today) }, complaint.at)

  // Until when the VIES proof counts (a fact of the party: no door).
  const vies = party.vies
  if (vies.state === 'VALID' && vies.validUntil) put({ key: 'vies', label: ov('dates.vies'), parts: [{ say: daySay(vies.validUntil) }] }, vies.validUntil, false)

  const rows = [...dated].sort((a, b) => Number(b.late) - Number(a.late) || (a.at ?? '9999').localeCompare(b.at ?? '9999')).map((entry) => entry.row)
  // The failed line names the sample dates: only for a reader who may read them (a part without its right is left out).
  const failed = can.samples && input.glance.status === 'error' ? ov('dates.failed') : null
  if (rows.length === 0 && !reading && failed === null) return null
  return { rows, reading: rows.length === 0 && reading, failed }
}

// ---- card 5: Requests & changes ----------------------------------------------------------------------------------------------

const counted = (read: TileRead): boolean => read.status === 'ready' && (read.count > 0 || read.more)

/**
 * What waits, grouped by who waits — the SAME counts as the Work band's chips (`tileOf`) and the page's ONE count read; each row
 * its count, the oldest one's age and the door that opens exactly those. A row or a group with 0 is left out; nothing waits: null —
 * the card is LEFT OUT (S24). While a read is out: the reading state; a failed read: the failed state with Try again.
 */
export function requestsOf(input: OverviewInput): RequestsCard | null {
  const { party, can, prefix, reads } = input
  const id = party.id
  const customer = party.tradeName ?? party.legalName
  const tile = (kind: 'requests' | 'replies' | 'tasks'): TileRead | null => (reads[kind].status === 'off' ? null : tileOf(kind, reads))
  const requests = tile('requests')
  const replies = tile('replies')
  const tasks = tile('tasks')
  const waiting = reads.asks.status === 'off' && reads.requests.status === 'off' && reads.board.status === 'off' ? null : tileOf('customer', reads)
  const page = input.counts
  const before = page.counts
  const toAnswer = before?.groups.TO_ANSWER ?? null
  const orderWaits = before?.groups.ORDER_WAITS ?? null
  const tiles = [requests, replies, tasks, waiting].flatMap((read) => (read ? [read] : []))
  if (tiles.length === 0 && before !== null && toAnswer === null && orderWaits === null) return null
  if (tiles.some((read) => read.status === 'reading') || (before === null && !page.failed)) return { state: 'reading', groups: [] }
  if (tiles.some((read) => read.status === 'failed') || page.failed) return { state: 'failed', groups: [] }

  // The Work tab's own doors (it exists only with orders.view): the review window, the customer's thread, the two windows.
  const work = (key: string, door: OverviewDoor): LabelledDoor | null => (can.orders ? { key, label: say('customers.tab.work'), arrow: true, door, held: null } : null)
  const quotes = (key: string, group: 'TO_ANSWER' | 'ORDER_WAITS'): LabelledDoor | null => (can.quotesTab ? linkDoor(key, say('customers.tab.quotes'), quotesDoor(prefix, id, group)) : null)
  const asked = readyOf(reads.requests)?.items ?? []
  const us: RequestRow[] = []
  if (requests && counted(requests)) {
    const oldest = earliestOf(asked, (request) => (request.waitingOn === 'US' ? request.askedAt : null))
    us.push({ key: 'requests', words: say('customers.work.tile.requests'), count: tileValueOf(requests), since: oldest?.at ?? null, door: work('requests', href(ordersDoor(prefix, id, { kind: 'requests', firstId: requestsDoorOf(asked).ids[0] ?? null }))) })
  }
  if (replies && counted(replies)) {
    const oldest = earliestOf(readyOf(reads.replies)?.rows ?? [], (row) => row.waiting.since)
    us.push({ key: 'replies', words: say('customers.work.tile.replies'), count: tileValueOf(replies), since: oldest?.at ?? null, door: work('replies', href(ordersDoor(prefix, id, { kind: 'replies' }))) })
  }
  if (toAnswer !== null && toAnswer > 0) us.push({ key: 'toAnswer', words: say('before-order:group.TO_ANSWER'), count: String(toAnswer), since: null, door: quotes('toAnswer', 'TO_ANSWER') })
  if (orderWaits !== null && orderWaits > 0) us.push({ key: 'orderWaits', words: say('before-order:group.ORDER_WAITS'), count: String(orderWaits), since: null, door: quotes('orderWaits', 'ORDER_WAITS') })
  const them: RequestRow[] = []
  if (waiting && counted(waiting)) {
    const ours = earliestOf(readyOf(reads.asks)?.items ?? [], (item) => (item.status === 'OPEN' ? item.createdAt : null))
    const countered = earliestOf(asked, (request) => (request.waitingOn === 'CUSTOMER' ? request.askedAt : null))
    const since = ours && countered ? (ours.at < countered.at ? ours.at : countered.at) : (ours?.at ?? countered?.at ?? null)
    them.push({ key: 'customer', words: say('customers.work.tile.customer', { customer }), count: tileValueOf(waiting), since, door: work('customer', { kind: 'window', window: 'customer' }) })
  }
  const todo: RequestRow[] = []
  if (tasks && counted(tasks)) {
    const oldest = earliestOf(readyOf(reads.tasks)?.items ?? [], (item) => item.createdAt)
    todo.push({ key: 'tasks', words: say('customers.work.tile.tasks'), count: tileValueOf(tasks), since: oldest?.at ?? null, door: work('tasks', { kind: 'window', window: 'tasks' }) })
  }

  // A group's number: its rows added up ("100+" when one of them is past a capped read).
  const total = (rows: readonly RequestRow[]): string => {
    let sum = 0
    let more = false
    for (const row of rows) {
      sum += Number.parseInt(row.count, 10) || 0
      if (row.count.endsWith('+')) more = true
    }
    return `${sum}${more ? '+' : ''}`
  }
  const groups: RequestGroup[] = []
  if (us.length > 0) groups.push({ key: 'us', title: say('customers.work.strip.us'), count: total(us), rows: us })
  if (them.length > 0) groups.push({ key: 'them', title: say('customers.work.strip.them', { customer }), count: total(them), rows: them })
  if (todo.length > 0) groups.push({ key: 'tasks', title: say('customers.work.strip.tasks'), count: total(todo), rows: todo })
  return groups.length > 0 ? { state: 'ready', groups } : null
}

// ---- card 6: Linked records --------------------------------------------------------------------------------------------------

/**
 * One row per kind — its label, then a value that is the door: the count and its state in words; samples, repairs, returns and
 * complaints name the next (or the oldest) one (S9). A kind without its right is left out; a kind with nothing joins ONE quiet line
 * ("None yet: …"); a failed read says "Could not be read" in its row.
 */
export function linkedOf(input: OverviewInput): LinkedCard {
  const { party, can, prefix } = input
  const id = party.id
  const customer = party.tradeName ?? party.legalName
  const rows: OverviewRow[] = []
  const none: Say[] = []
  const kind = (key: string, label: Say, parts: readonly RowPart[]) => {
    if (parts.length > 0) rows.push({ key, label, parts })
    else none.push(label)
  }
  const stated = (key: string, label: Say, state: 'reading' | 'unread') => rows.push({ key, label, parts: [], state })
  const through = (address: string | null): Pick<RowPart, 'door'> => (address ? { door: href(address) } : {})

  // Orders: the board's numbers, then this customer's row of the joined read (customer-urgent, Priority Top / High).
  const board = boardOf(input)
  const ordersLabel = ov('linked.orders')
  if (board.status === 'reading') stated('orders', ordersLabel, 'reading')
  else if (board.status === 'failed') stated('orders', ordersLabel, 'unread')
  else if (board.status === 'ready') {
    const numbers = boardNumbersOf(board.value)
    const parts: RowPart[] = []
    if (numbers.total > 0) {
      parts.push({ say: ov('linked.openOf', { open: numbers.open, total: numbers.total }), door: href(ordersDoor(prefix, id, { kind: 'open' })) })
      if (numbers.late > 0) parts.push({ say: depth('promises.late', { count: numbers.late }), door: href(ordersDoor(prefix, id, { kind: 'late' })) })
      const standing = readyOf(input.standing)
      if (standing) {
        if (standing.customerUrgent.count > 0) parts.push({ say: joined([say('orders-sheet:urgency.bare'), standing.customerUrgent.count], ' '), door: href(ordersDoor(prefix, id, { kind: 'customerUrgent' })) })
        if (standing.priority.top > 0) parts.push({ say: ov('linked.priorityTop', { count: standing.priority.top }), door: href(ordersDoor(prefix, id, { kind: 'priority', level: 'URGENT' })) })
        if (standing.priority.high > 0) parts.push({ say: ov('linked.priorityHigh', { count: standing.priority.high }), door: href(ordersDoor(prefix, id, { kind: 'priority', level: 'HIGH' })) })
      }
    }
    kind('orders', ordersLabel, parts)
  }

  // Quotes and Incoming: the page's ONE count read (a part the reader has no right for is null: left out).
  const quotesLabel = ov('linked.quotes')
  const incomingLabel = ov('linked.incoming')
  const before = input.counts.counts
  if (before === null) {
    // Both kinds live on Quotes & incoming: while its count read is out, each says so in its row (picture 20, reading).
    if (can.quotesTab) {
      stated('quotes', quotesLabel, input.counts.failed ? 'unread' : 'reading')
      stated('incoming', incomingLabel, input.counts.failed ? 'unread' : 'reading')
    }
  } else if (can.quotesTab) {
    // co-fx2 (walk CO-W-2; 10-design §7, §9): both kinds are the Quotes & incoming tab's — without its right neither row is drawn nor
    // named in "None yet", whatever the count read answers (it answers the portal drafts' count with orders.view).
    const group = (name: 'WRITING' | 'TO_ANSWER' | 'OPEN_QUOTES' | 'ORDER_WAITS'): Pick<RowPart, 'door'> => through(quotesDoor(prefix, id, name))
    if (before.openQuotes !== null) {
      const parts: RowPart[] = []
      if (before.openQuotes > 0) parts.push({ say: ov('linked.open', { count: before.openQuotes }), ...group('OPEN_QUOTES') })
      const waits = before.groups.ORDER_WAITS ?? 0
      if (waits > 0) parts.push({ say: say('customers.work.band.before.orderWaits', { count: waits }), ...group('ORDER_WAITS') })
      kind('quotes', quotesLabel, parts)
    }
    const toAnswer = before.groups.TO_ANSWER
    const drafts = before.groups.WRITING
    if (toAnswer !== null || drafts !== null) {
      const parts: RowPart[] = []
      if (toAnswer !== null && toAnswer > 0) parts.push({ say: say('customers.work.band.before.toAnswer', { count: toAnswer }), ...group('TO_ANSWER') })
      if (drafts !== null && drafts > 0) parts.push({ say: say('customers.work.band.before.drafts', { count: drafts }), ...group('WRITING') })
      kind('incoming', incomingLabel, parts)
    }
  }

  // Sample rounds and repairs: the glance's own counts, each under its own right (without it: left out); the glance still read: the
  // row's skeleton; failed: "Could not be read" in the row; null in the answer: withheld — left out. The next / the oldest one named.
  const glance = glanceOf(input.glance)
  const glanceState = (key: string, label: Say): boolean => {
    if (input.glance.status === 'ready') return false
    stated(key, label, input.glance.status === 'loading' ? 'reading' : 'unread')
    return true
  }
  if (can.samples && !glanceState('samples', ov('linked.samples')) && glance?.samples) {
    const next = earliestKeptOf('samples', glance.samples.rows.length >= glance.samples.count, glance.samples.rows, (round) => round.dueDate)
    const said: Param[] = [ov('linked.inProgress', { count: glance.samples.count })]
    if (next) said.push(next.at.slice(0, 10) === input.today ? ov('linked.nextDueToday', { number: next.item.number }) : ov('linked.nextDue', { number: next.item.number, date: dayOf(next.at) }))
    kind('samples', ov('linked.samples'), glance.samples.count > 0 ? [{ say: joined(said), door: href(samplesDoor(prefix, id)) }] : [])
  }
  if (can.repairs && !glanceState('repairs', ov('linked.repairs')) && glance?.repairs) {
    const oldest = earliestKeptOf('repairs', glance.repairs.rows.length >= glance.repairs.count, glance.repairs.rows, (repair) => repair.createdAt)
    const said: Param[] = [ov('linked.inProgress', { count: glance.repairs.count })]
    if (oldest) said.push(ov('linked.oldestOpened', { number: oldest.item.number, date: dayOf(oldest.at) }))
    kind('repairs', ov('linked.repairs'), glance.repairs.count > 0 ? [{ say: joined(said), door: href(repairsDoor(prefix, party.code)) }] : [])
  }

  // Returns and complaints: the customer's own after-sales reads (the Money lane's rule for "open"). S33: "n open" and the oldest /
  // next one are said only when the read is whole; a cut read (both are newest first: the cut is the OLDEST end) says "Open" and its
  // door, with no number and no named one — and a cut read with no open one in it is left out (no claim either way).
  if (can.returns) {
    const label = ov('linked.returns')
    const read = input.money.returns
    if (read.items === null) stated('returns', label, read.problem ? 'unread' : 'reading')
    else {
      const open = openAfterSales(read.items, []).returns
      if (!wholeReturns(read)) {
        if (open.length > 0) rows.push({ key: 'returns', label, parts: [{ say: ov('linked.someOpen'), ...through(input.money.returnsHref) }] })
      } else {
        const oldest = earliestOf(open, (entry) => entry.requestedAt)
        const said: Param[] = [ov('linked.open', { count: open.length })]
        if (oldest) said.push(ov('linked.oldestAsked', { number: oldest.item.number, date: dayOf(oldest.at) }))
        kind('returns', label, open.length > 0 ? [{ say: joined(said), ...through(input.money.returnsHref) }] : [])
      }
    }
  }
  if (can.complaints) {
    const label = ov('linked.complaints')
    const read = input.money.complaints
    if (read.items === null) stated('complaints', label, read.problem ? 'unread' : 'reading')
    else {
      const open = openAfterSales([], read.items).complaints
      // S28: the customer's complaints list (it reads the customer as its term); not built here: the NAMED complaint's own page.
      const list = complaintsDoor(prefix, id)
      if (!wholeComplaints(read)) {
        const newest = open[0] ?? null
        const address = list ?? (newest ? complaintDoor(prefix, newest.id) : null)
        if (open.length > 0) rows.push({ key: 'complaints', label, parts: [{ say: ov('linked.someOpen'), ...through(address) }] })
      } else {
        const next = earliestOf(open, (entry) => entry.answerDueOn)
        const said: Param[] = [ov('linked.open', { count: open.length })]
        if (next) said.push(ov('linked.nextAnswer', { number: next.item.number, date: dayOf(next.at) }))
        const named = next?.item ?? open[0] ?? null
        const address = list ?? (named ? complaintDoor(prefix, named.id) : null)
        kind('complaints', label, open.length > 0 ? [{ say: joined(said), ...through(address) }] : [])
      }
    }
  }

  // Projects (threads.read), then a team's riders and the measurement profiles (only when there are some).
  if (input.projects) kind('projects', ov('linked.projects'), input.projects.all > 0 ? [{ say: ov('linked.openOf', { open: input.projects.open, total: input.projects.all }), door: href(projectsDoor(prefix, id)) }] : [])
  if (glance?.riders && glance.riders.count > 0) rows.push({ key: 'riders', label: depth('riders.title'), parts: [{ say: text(String(glance.riders.count)), door: href(peopleDoor(prefix, id, 'riders')) /* F-CA-121 */ }] })
  if (glance?.profiles && glance.profiles.count > 0) rows.push({ key: 'profiles', label: depth('profiles.title'), parts: [{ say: text(String(glance.profiles.count)), door: href(peopleDoor(prefix, id, 'riders')) /* F-CA-121 */ }] })

  // Plain doors with no count read.
  const quiet: LabelledDoor[] = []
  if (can.workorders) quiet.push({ key: 'workOrders', label: say('customers.band.workOrders', { customer }), arrow: false, door: href(workOrdersDoor(prefix, id)), held: null })
  if (can.receivables) quiet.push(linkDoor('receivables', ov('linked.receivables'), receivablesDoor(prefix, id)))
  return { rows, none, quiet }
}

// ---- card 7: Customer facts --------------------------------------------------------------------------------------------------

/** The warnings that block nothing and are said nowhere else on the tab (VIES is a strip; the orders contact is People's). */
const TO_COMPLETE: readonly string[] = ['FISCAL_DRAWER', 'TAX_COUNTRY_DIFFERS', 'NO_DEFAULT_BILL_TO', 'NO_DEFAULT_SHIP_TO']

/**
 * The facts found nowhere else on the page (the band above says the code, the country and the roles): names, kind · language,
 * payment · currency, the tax identity in force, the requirements in force, the credit (only when the read carries it), since
 * when, what is still to complete (each with today's own step), the office note. ONE Edit in the head (today's Edit window).
 */
export function factsOf(input: OverviewInput): FactsCard {
  const { party, can, prefix } = input
  const id = party.id
  const archived = party.status === 'ARCHIVED'
  const held = archived ? say('held.archived') : null
  const rows: FactRow[] = []
  rows.push({ key: 'legalName', label: say('field.legalName'), parts: [{ say: text(party.legalName) }] })
  rows.push({ key: 'tradeName', label: say('field.tradeName'), parts: [{ say: text(party.tradeName ?? '—') }], empty: party.tradeName === null })
  rows.push({ key: 'kind', label: ov('facts.kindLanguage'), parts: [{ say: joined([say(`kind.${party.kind}`), { language: party.language }]) }] })
  rows.push({ key: 'payment', label: ov('facts.payment'), parts: [{ say: joined([text(party.paymentTerms?.trim() || '—'), text(party.currency)]) }] })

  // The tax identity in force: a door to its part of Terms & requirements.
  const identity = party.taxIdentities.find((entry) => entry.current) ?? null
  const identityDoor = href(termsDoor(prefix, id, 'identity'))
  if (identity) {
    const said: Param[] = [say(`taxMode.${identity.taxMode}`)]
    if (identity.vatNumber) said.push(ov('facts.vat', { number: identity.vatNumber }))
    // co-fx2 (walk CO-W-6): the codice fiscale with its label (the identity form's own word), as VAT and SDI carry theirs.
    if (identity.fiscalCode && identity.fiscalCode !== identity.vatNumber) said.push(joined([say('field.fiscalCode'), text(identity.fiscalCode)], ' '))
    if (identity.sdiRecipientCode) said.push(ov('facts.sdi', { code: identity.sdiRecipientCode }))
    if (identity.pec) said.push(ov('facts.pec', { pec: identity.pec }))
    // "valid from …" as quiet words after the door, on the same line (10-design §8; picture 20), as the next promise's quiet part.
    rows.push({ key: 'identity', label: say('identity.title'), parts: [{ say: joined(said), door: identityDoor }, { say: ov('facts.validFrom', { date: dayOf(identity.validFrom) }), quiet: true }] })
  } else rows.push({ key: 'identity', label: say('identity.title'), parts: [{ say: say('list.noIdentity'), door: identityDoor }] })

  // The requirements in force and the credit: the glance's (the credit part is absent without sales.credit.view). The glance still
  // read: the fact's skeleton; failed: "Could not be read" in the fact (the requirements need no right beyond the page's own).
  const glance = glanceOf(input.glance)
  if (input.glance.status !== 'ready') {
    const state = input.glance.status === 'loading' ? 'reading' : 'unread'
    rows.push({ key: 'requirements', label: say('customers.requirementsLabel'), parts: [], state })
    if (can.credit) rows.push({ key: 'credit', label: say('customer-money:tab.credit'), parts: [], state })
  }
  if (glance) {
    const count = glance.requirements.count
    rows.push(
      count > 0
        ? { key: 'requirements', label: say('customers.requirementsLabel'), parts: [{ say: text(String(count)), door: href(termsDoor(prefix, id, 'requirements')) }] }
        : { key: 'requirements', label: say('customers.requirementsLabel'), parts: [{ say: depth('reqSide.none') }], empty: true },
    )
    const credit = can.credit ? glance.credit : null
    if (credit) {
      const door: Pick<RowPart, 'door'> = can.moneyTab ? { door: href(moneyDoor(prefix, id, 'credit')) } : {}
      const over = can.price && credit.state === 'OVER' ? overAmountsOf(credit) : null
      const free = can.price && credit.state === 'WITHIN' && credit.currency !== null && typeof credit.available === 'number' && typeof credit.limit === 'number' ? { amount: amountOf(credit.available, credit.currency), limit: amountOf(credit.limit, credit.currency) } : null
      const words: Say =
        credit.state === 'NONE' ? say('customer-money:tab.noLimit') : credit.state === 'OVER' ? (over ? ov('strip.overLimit', { amount: over.over, limit: over.limit }) : depth('credit.over')) : free ? ov('facts.creditFree', free) : depth('credit.within')
      rows.push({ key: 'credit', label: say('customer-money:tab.credit'), parts: [{ say: words, ...(credit.state === 'NONE' ? {} : door) }] })
    }
  }
  rows.push({ key: 'since', label: ov('facts.since'), parts: [{ say: ov('facts.sinceValue', { date: dayOf(party.createdAt), changed: dayOf(party.updatedAt) }) }] })

  // To complete: one wide row per warning, ONE button per kind of step (three address warnings get one "Add address").
  const seen = new Set<NextAction>()
  for (const warning of party.warnings) {
    if (warning.blocksInvoice || !TO_COMPLETE.includes(warning.code)) continue
    const action = WARNING_ACTION[warning.code]
    const door = can.manage && !seen.has(action) ? stepDoorOf(action, prefix, id, held) : null
    seen.add(action)
    rows.push({ key: `complete-${warning.code}`, label: ov('facts.toComplete'), parts: [{ say: say(`warning.${warning.code}`) }], wide: true, ...(door ? { door } : {}) })
  }

  // The office note, the whole row (shown even when empty: a note that can be typed is shown somewhere).
  const note = party.internalNote?.trim() ?? ''
  rows.push({ key: 'note', label: say('field.internalNote'), labelTag: ov('facts.noteTag'), parts: [{ say: note !== '' ? text(note) : ov('facts.noNote') }], wide: true, empty: note === '' })

  return { rows, edit: can.manage ? stepDoor('edit', say('common.edit'), { kind: 'act', act: 'edit' }, held) : null }
}

// ---- the whole tab -----------------------------------------------------------------------------------------------------------

/** The Overview as it is drawn, from the reads the page already holds (the container builds it; a design case hands made-up reads). */
export function overviewOf(input: OverviewInput): CustomerOverviewModel {
  return {
    customer: input.party.tradeName ?? input.party.legalName,
    headline: headlineOf(input),
    strips: stripsOf(input),
    band: bandStateOf(input),
    people: peopleOf(input),
    dates: datesOf(input),
    requests: requestsOf(input),
    linked: linkedOf(input),
    facts: factsOf(input),
  }
}
