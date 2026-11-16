import { plusDays } from '@nexus/factory-domain/calendars/dates'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { levelWorkshop, roomFor, type CapacityRow, type LevelChoice, type WorkshopJob } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { qualificationsFor } from '../../purchasing/qualification/qualifications'
import type { Reader, SiteRow } from '../store'
import { capacityRowOf, closedDaysOf, readCapacityRows, readJobs } from './store'

/**
 * B-W2b-GB29 (G219, B-W2b-321's gap "the plan's proposals do not level by the workshop's capacity"): the run's make and
 * subcontract pass (../planned-orders/pass) asks, for each planned SUBCONTRACT order in turn, which workshop gets it
 * (factory-domain planning/subcontract-capacity `levelWorkshop`): the work already booked at each workshop (live subcontract
 * orders, the allocation board's parts and the plan's firm planned orders: ./store readJobs, without the plan's other earlier
 * proposals, which this run replaces) plus the proposals this run placed before it, against the weekly capacity lines in force on the job's days and
 * the workshop's closed days. Other workshops asked: ACTIVE parties with the SUBCONTRACTOR role and a capacity line, approved
 * (B-W2b-315's qualification) for every step sent. A few reads once per run, then the closed days of each workshop asked.
 */

export interface LevelStep {
  readonly seq: number
  readonly workCentreKind: string
  readonly operationId: string
  readonly standardMinutes: { toString(): string }
}

export interface Leveller {
  /** Who gets a planned subcontract order of `garments` over [from, to] for these steps (the routing's workshop first); the job then counts. */
  place(job: { readonly id: string; readonly routingPartyId: string; readonly from: BusinessDate; readonly to: BusinessDate; readonly garments: number; readonly steps: readonly LevelStep[] }): Promise<LevelChoice>
}

export async function workshopLeveller(db: Reader, site: SiteRow, runDate: BusinessDate, keptIds: readonly string[] = []): Promise<Leveller> {
  // The plan's firm planned orders stay (a run never changes them): they load their workshop too.
  const kept = new Set(keptIds)
  const booked: WorkshopJob[] = (await readJobs(db, site, runDate)).filter((job) => job.kind !== 'PLANNED' || kept.has(job.id))
  const parties = await db.party.findMany({ where: { status: 'ACTIVE', roles: { has: 'SUBCONTRACTOR' }, OR: [{ companyId: site.companyId }, { companyId: null }] }, select: { id: true, code: true }, orderBy: { code: 'asc' } })
  const codeOf = new Map(parties.map((party) => [party.id, party.code]))
  const rows: CapacityRow[] = (await readCapacityRows(db, parties.map((party) => party.id))).map(capacityRowOf)
  const withRows = new Set(rows.map((row) => row.partyId))
  const closed = new Map<string, Set<BusinessDate>>()
  const qualified = new Map<string, boolean>()
  const closedOf = async (partyId: string, from: BusinessDate, to: BusinessDate): Promise<Set<BusinessDate>> => {
    const key = `${partyId}|${from}|${to}`
    if (!closed.has(key)) closed.set(key, (await closedDaysOf(db, [partyId], from, to)).get(partyId) ?? new Set())
    return closed.get(key)!
  }
  const approved = async (partyId: string, steps: readonly LevelStep[]): Promise<boolean> => {
    for (const step of steps) {
      const key = `${partyId}|${step.workCentreKind}|${step.operationId}`
      if (!qualified.has(key)) {
        const answer = (await qualificationsFor(db, { companyId: site.companyId, partyIds: [partyId], need: { workCentreKind: step.workCentreKind as never, operationId: step.operationId }, today: runDate })).get(partyId)
        qualified.set(key, answer?.qualified === true)
      }
      if (!qualified.get(key)) return false
    }
    return true
  }
  return {
    async place(input) {
      const to = input.to < input.from ? input.from : input.to
      const jobOf = (partyId: string): WorkshopJob => ({
        kind: 'PLANNED',
        id: input.id,
        partyId,
        workOrderId: null,
        from: input.from,
        to,
        garments: input.garments,
        operations: input.steps.map((step) => ({ workCentreKind: step.workCentreKind, minutes: new Dec(step.standardMinutes.toString()).times(input.garments).toFixed(3) })),
      })
      // The closed days of the window (a week either side covers the jobs that overlap it).
      const rooms = new Map<string, ReturnType<typeof roomFor>>()
      for (const partyId of [input.routingPartyId, ...parties.map((party) => party.id)]) {
        if (rooms.has(partyId) || !withRows.has(partyId)) continue
        if (partyId !== input.routingPartyId && !(await approved(partyId, input.steps))) continue
        rooms.set(partyId, roomFor(rows, booked, jobOf(partyId), await closedOf(partyId, plusDays(input.from, -7), plusDays(to, 7))))
      }
      const others = [...rooms.keys()].filter((partyId) => partyId !== input.routingPartyId).map((partyId) => ({ partyId, code: codeOf.get(partyId) ?? partyId }))
      const choice = levelWorkshop({ partyId: input.routingPartyId, code: codeOf.get(input.routingPartyId) ?? 'The workshop' }, others, (partyId) => rooms.get(partyId) ?? { partyId, known: false, fits: true, loadPct: null })
      booked.push(jobOf(choice.partyId))
      return choice
    },
  }
}
