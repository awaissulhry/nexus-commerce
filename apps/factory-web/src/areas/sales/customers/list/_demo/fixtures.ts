import type { UnreadMap } from '../../../../../lib/last-message-cell/model'
import { VIES } from '../../../../parties/_shared/fixtures'
import type { PartyRow, PartyWorkBand, PartyWorkGroup } from '../../../../parties/_shared/api'
import type { CustomerWork, OrderPhase } from '../api'
import type { CustomerRights, CustomersWorkModel } from '../model'
import type { SupervisorManyModel, SupervisorTarget } from '../supervisor/model'

/**
 * T.1 (customers list 13-backend §8.10, 10-design §17): the gallery's busy list — 14 made-up customers in every state the list
 * draws (waiting on us, late, a yes, a deposit, the customer's urgent mark, our Top / High, every phase, no order, a prospect, a
 * blocked one, office data missing, one the reader's orders.view does not reach), the band they make, the limited reader's two,
 * and the windows' steps. Seed names only, example.com nowhere needed, never a real company or person.
 */

/** Today in the gallery (the promises count from it). */
export const DEMO_TODAY = '2026-11-24'

const pid = (n: number) => `0190f0e2-c1c1-7000-8000-${String(n).padStart(12, '0')}`
const oid = (n: number) => `0190f0e2-0d0d-7000-8000-${String(n).padStart(12, '0')}`

interface Seed {
  readonly n: number
  readonly code: string
  readonly name: string
  readonly status?: PartyRow['status']
  readonly kind?: PartyRow['kind']
  readonly roles?: PartyRow['roles']
  readonly country?: string
  readonly attention?: PartyRow['attention']
  readonly invoiceBlocked?: boolean
  readonly eu?: boolean
}

function rowOfSeed(seed: Seed): PartyRow {
  return {
    id: pid(seed.n),
    companyId: null,
    code: seed.code,
    kind: seed.kind ?? 'ORGANISATION',
    legalName: seed.kind === 'PERSON' ? seed.name : `${seed.name} S.r.l.`,
    tradeName: seed.kind === 'PERSON' ? null : seed.name,
    roles: seed.roles ?? ['CUSTOMER'],
    status: seed.status ?? 'ACTIVE',
    country: seed.country ?? 'IT',
    currency: 'EUR',
    language: seed.country === 'DE' ? 'de' : 'it',
    taxMode: seed.eu ? 'EU_B2B' : seed.kind === 'PERSON' ? 'IT_B2C' : 'IT_B2B',
    vatNumber: seed.kind === 'PERSON' ? null : seed.eu ? 'DE111111111' : '00000000000',
    fiscalCode: null,
    city: null,
    vies: seed.eu ? VIES.unchecked : VIES.none,
    attention: seed.attention ?? [],
    invoiceBlocked: seed.invoiceBlocked ?? false,
    version: 3,
    updatedAt: '2026-11-20T09:00:00.000Z',
  }
}

/** The busy list, in the order "Most urgent first" puts it (10-design §5). */
const SEEDS: readonly Seed[] = [
  { n: 1, code: 'SEED-C1', name: 'Seed Racing', roles: ['CUSTOMER', 'BRAND'] },
  { n: 3, code: 'SEED-C3', name: 'Seed Moto Club' },
  { n: 10, code: 'SEED-C10', name: 'Seed Customer Ten' },
  { n: 7, code: 'SEED-C7', name: 'Seed Track Days' },
  { n: 8, code: 'SEED-C8', name: 'Seed Customer Eight', status: 'BLOCKED' },
  { n: 5, code: 'SEED-C5', name: 'Seed Brand Five', roles: ['BRAND'], attention: ['VIES_NOT_PROVEN'], eu: true, country: 'DE' },
  { n: 23, code: 'SEED-R3', name: 'Seed Rider Three', kind: 'PERSON' },
  { n: 6, code: 'SEED-C6', name: 'Seed Customer Six' },
  { n: 4, code: 'SEED-C4', name: 'Seed Customer Four' },
  { n: 21, code: 'SEED-R1', name: 'Seed Private Rider', kind: 'PERSON' },
  { n: 13, code: 'SEED-C13', name: 'Seed Customer Three GmbH', status: 'PROSPECT', eu: true, country: 'DE' },
  { n: 9, code: 'SEED-C9', name: 'Seed Customer Nine', status: 'PROSPECT', attention: ['FISCAL_DRAWER', 'NO_TAX_IDENTITY'], invoiceBlocked: true },
  { n: 2, code: 'SEED-C2', name: 'Seed Customer Two' },
  { n: 11, code: 'SEED-C11', name: 'Seed Customer Eleven' },
]
export const BUSY_ROWS: readonly PartyRow[] = SEEDS.map(rowOfSeed)
export const busyId = (code: string): string => BUSY_ROWS.find((row) => row.code === code)!.id

type Phases = Partial<Record<OrderPhase, number>>
interface Facts {
  readonly phases?: Phases
  readonly late?: number
  readonly waitsForYes?: number
  readonly depositOpen?: number
  readonly requests?: number
  readonly replies?: number
  readonly urgent?: number
  readonly top?: number
  readonly high?: number
  readonly next?: string | null
  readonly last?: string | null
  readonly newest?: number | null
  readonly toAnswer?: number
  readonly openQuotes?: number
}

const PHASES: readonly OrderPhase[] = ['NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE', 'CANCELLED']

function workOf(code: string, facts: Facts): CustomerWork {
  const phases = PHASES.map((phase) => ({ phase, count: facts.phases?.[phase] ?? 0 }))
  const orders = phases.reduce((sum, entry) => sum + entry.count, 0)
  return {
    partyId: busyId(code),
    orders,
    phases,
    late: facts.late ?? 0,
    waitsForYes: facts.waitsForYes ?? 0,
    depositOpen: facts.depositOpen ?? 0,
    requests: { open: facts.requests ?? 0, firstId: facts.requests ? oid(900 + Number(code.replace(/\D/g, ''))) : null },
    replies: facts.replies ?? 0,
    customerUrgent: { count: facts.urgent ?? 0, byCompany: facts.urgent ? [{ companyId: '0190f0e2-co00-7000-8000-000000000001', count: facts.urgent }] : [] },
    priority: { top: facts.top ?? 0, high: facts.high ?? 0 },
    nextPromise: facts.next ?? null,
    lastOrderDate: facts.last ?? null,
    newestOrder: facts.newest ? { id: oid(facts.newest), number: `SEED-SO-${String(facts.newest).padStart(4, '0')}` } : null,
    beforeOrder: { ...(facts.toAnswer !== undefined ? { toAnswer: facts.toAnswer } : {}), ...(facts.openQuotes !== undefined ? { openQuotes: facts.openQuotes } : {}) },
  }
}

/** Each customer's work (Seed Customer Eleven is absent: the reader's orders.view does not reach it — its cells say "—"). */
const BUSY_FACTS: readonly CustomerWork[] = [
  workOf('SEED-C1', { phases: { NOT_SENT: 2, NOT_STARTED: 1, IN_PRODUCTION: 4, READY: 1, SHIPPED: 3, DONE: 5 }, requests: 2, toAnswer: 1, late: 1, waitsForYes: 1, depositOpen: 1, replies: 0, next: '2026-11-27', last: '2026-11-21', newest: 12, openQuotes: 2 }),
  workOf('SEED-C3', { phases: { NOT_SENT: 1, IN_PRODUCTION: 3, READY: 2, SHIPPED: 1, DONE: 12 }, replies: 2, high: 1, next: '2026-11-26', last: '2026-11-18', newest: 31 }),
  workOf('SEED-C10', { phases: { IN_PRODUCTION: 1, READY: 1, DONE: 3 }, requests: 1, replies: 1, high: 1, next: '2026-11-30', last: '2026-11-10', newest: 44 }),
  workOf('SEED-C7', { phases: { NOT_STARTED: 1, IN_PRODUCTION: 2, SHIPPED: 1, DONE: 8 }, requests: 1, late: 2, next: '2026-12-02', last: '2026-11-04', newest: 18 }),
  workOf('SEED-C8', { phases: { IN_PRODUCTION: 1, DONE: 6 }, late: 1, next: null, last: '2026-10-01', newest: 7 }),
  workOf('SEED-C5', { phases: { NOT_SENT: 1, IN_PRODUCTION: 1, READY: 1, DONE: 2 }, waitsForYes: 1, top: 1, next: '2026-12-01', last: '2026-11-19', newest: 52 }),
  workOf('SEED-R3', { phases: { READY: 1, DONE: 1 }, next: '2026-11-27', last: '2026-11-02', newest: 60 }),
  workOf('SEED-C6', { phases: { IN_PRODUCTION: 2, SHIPPED: 1, DONE: 20 }, next: '2026-12-04', last: '2026-11-12', newest: 61 }),
  workOf('SEED-C4', { phases: { NOT_SENT: 2, IN_PRODUCTION: 1, DONE: 4 }, depositOpen: 2, urgent: 1, next: '2026-12-10', last: '2026-11-15', newest: 63 }),
  workOf('SEED-R1', { phases: { NOT_SENT: 1 }, waitsForYes: 1, next: '2026-12-15', last: '2026-11-22', newest: 70 }),
  workOf('SEED-C13', { toAnswer: 1, openQuotes: 1 }),
  workOf('SEED-C9', {}),
  workOf('SEED-C2', { phases: { DONE: 9, CANCELLED: 1 }, last: '2026-06-03', newest: 5 }),
]

export function workModel(codes?: readonly string[], over: Partial<CustomersWorkModel> = {}): CustomersWorkModel {
  const facts = codes ? BUSY_FACTS.filter((work) => codes.includes(BUSY_ROWS.find((row) => row.id === work.partyId)!.code)) : BUSY_FACTS
  return { byParty: new Map(facts.map((work) => [work.partyId, work])), problem: null, repliesComplete: true, limited: false, ...over }
}

/** The band the facts make (the server's workBandOf, over these customers: customers per group, that phase's orders). */
export function bandOf(model: CustomersWorkModel, limited = false): PartyWorkBand {
  const all = [...(model.byParty?.values() ?? [])]
  const count = (phase: OrderPhase) => (work: CustomerWork) => work.phases.find((entry) => entry.phase === phase)?.count ?? 0
  const group = (name: PartyWorkGroup): PartyWorkBand['groups'][number] => {
    if (name === 'NEEDS_US') return { group: name, customers: all.filter((work) => work.requests.open + (work.replies ?? 0) + work.late > 0).length, orders: null }
    const of = count(name)
    return { group: name, customers: all.filter((work) => of(work) > 0).length, orders: all.reduce((sum, work) => sum + of(work), 0) }
  }
  const groups = (['NEEDS_US', 'NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE'] as const).map(group)
  return {
    groups,
    needsUs: { requests: all.reduce((sum, work) => sum + work.requests.open, 0), replies: all.reduce((sum, work) => sum + (work.replies ?? 0), 0), late: all.reduce((sum, work) => sum + work.late, 0), repliesComplete: true },
    notSent: { waitsForYes: all.reduce((sum, work) => sum + work.waitsForYes, 0), waitsForDeposit: 3 },
    limited,
  }
}

/** The reader's own new messages (made up). */
export const BUSY_UNREAD: UnreadMap = {
  [busyId('SEED-C1')]: { newCount: 1, lastAt: '2026-11-24T08:12:00.000Z' },
  [busyId('SEED-C3')]: { newCount: 3, lastAt: '2026-11-23T16:40:00.000Z' },
  [busyId('SEED-C10')]: { newCount: 4, lastAt: '2026-11-23T11:05:00.000Z' },
  [busyId('SEED-R3')]: { newCount: 1, lastAt: '2026-11-22T09:30:00.000Z' },
}

/** The limited reader (orders.view and parties.view over Seed Racing and Seed Moto Club only): "Your customers". */
export const LIMITED_CODES: readonly string[] = ['SEED-C1', 'SEED-C3']

/** Each role's own rights on the list (C3 §1a: the role templates). */
export const ROLE_RIGHTS: Readonly<Record<'owner' | 'sales' | 'finance' | 'productionManager' | 'warehouse' | 'readOnly', { readonly rights: CustomerRights; readonly can: { view: boolean; manage: boolean; block: boolean; vies: boolean; export: boolean } }>> = {
  owner: { rights: { threads: true, orders: true, tasks: true, supervisor: true }, can: { view: true, manage: true, block: true, vies: true, export: true } },
  sales: { rights: { threads: true, orders: true, tasks: true, supervisor: false }, can: { view: true, manage: true, block: false, vies: true, export: true } },
  finance: { rights: { threads: true, orders: true, tasks: true, supervisor: false }, can: { view: true, manage: true, block: true, vies: true, export: true } },
  productionManager: { rights: { threads: true, orders: true, tasks: true, supervisor: true }, can: { view: true, manage: false, block: false, vies: false, export: true } },
  warehouse: { rights: { threads: true, orders: true, tasks: true, supervisor: false }, can: { view: true, manage: false, block: false, vies: false, export: true } },
  readOnly: { rights: { threads: true, orders: true, tasks: false, supervisor: false }, can: { view: true, manage: false, block: false, vies: false, export: false } },
}

/** The office people who may supervise (made up: office roles only, never a floor worker). */
const MARIO = { id: '0190f0e2-u5e7-7000-8000-000000000001', name: 'Mario Production', active: true }
const ANNA = { id: '0190f0e2-u5e7-7000-8000-000000000002', name: 'Anna Office', active: true }
export const SUPERVISOR_PEOPLE = [
  { id: MARIO.id, name: MARIO.name, me: false },
  { id: ANNA.id, name: ANNA.name, me: true },
]

/** The six ticked customers of the supervisor window, as read: two already Mario's, one out of reach. */
export function supervisorTargets(reading = false): SupervisorTarget[] {
  const name = (code: string) => BUSY_ROWS.find((row) => row.code === code)!.tradeName ?? code
  if (reading) return ['SEED-C1', 'SEED-C3', 'SEED-C10'].map((code) => ({ id: busyId(code), name: name(code), state: 'reading' as const }))
  return [
    { id: busyId('SEED-C1'), name: name('SEED-C1'), state: 'read', version: 3, supervisor: null, backup: null },
    { id: busyId('SEED-C3'), name: name('SEED-C3'), state: 'read', version: 5, supervisor: MARIO, backup: ANNA },
    { id: busyId('SEED-C10'), name: name('SEED-C10'), state: 'read', version: 2, supervisor: ANNA, backup: null },
    { id: busyId('SEED-C7'), name: name('SEED-C7'), state: 'read', version: 1, supervisor: MARIO, backup: null },
    { id: busyId('SEED-C6'), name: name('SEED-C6'), state: 'read', version: 4, supervisor: null, backup: null },
    { id: busyId('SEED-C4'), name: name('SEED-C4'), state: 'unread', why: { ns: 'customers-list', key: 'supervisor.notReached' } },
  ]
}

/** The supervisor window at each step: read → pick → running → done (with one refused and one not run: "Run the rest again"). */
export function supervisorWindow(step: SupervisorManyModel['step']): SupervisorManyModel {
  const people = { status: 'ready' as const, people: SUPERVISOR_PEOPLE, complete: true }
  if (step === 'read') return { step, targets: supervisorTargets(true), people: { status: 'loading' }, picked: null, outcomes: {}, done: 0, stopping: false }
  if (step === 'pick') return { step, targets: supervisorTargets(), people, picked: MARIO.id, outcomes: {}, done: 0, stopping: false }
  if (step === 'running') return { step, targets: supervisorTargets(), people, picked: MARIO.id, outcomes: { [busyId('SEED-C1')]: { kind: 'done' } }, done: 1, stopping: false }
  return {
    step,
    targets: supervisorTargets(),
    people,
    picked: MARIO.id,
    outcomes: { [busyId('SEED-C1')]: { kind: 'done' }, [busyId('SEED-C10')]: { kind: 'failed', why: { ns: 'production-supervisor', key: 'skip.NO_REACH' } }, [busyId('SEED-C6')]: { kind: 'notRun' } },
    done: 2,
    stopping: false,
  }
}
