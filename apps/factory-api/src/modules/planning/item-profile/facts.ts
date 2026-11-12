import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { arrivalDate, leadTimeWindow } from '@nexus/factory-domain/calendars/suppliers'
import { addWorkingDays, type WorkingCalendar } from '@nexus/factory-domain/calendars/working-time'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { PlannedRequirement, RequirementNetting } from '@nexus/factory-domain/planning/explode'
import { pegMaterial, type MaterialPegging } from '@nexus/factory-domain/planning/mrp/net'
import { itemPlanningFor } from '@nexus/factory-domain/planning/settings/items'
import { sourceFor, sourceRules } from '@nexus/factory-domain/purchasing/sources/sources'
import { supplierCalendarsFor, workingCalendarFor } from '../../../platform/calendars/service'
import type { ItemPlanningRow } from '../inputs'
import type { LivePlan } from '../readiness/service'
import type { Reader } from '../store'

/**
 * What the item profile, the calculated delays and the allocation read of a live plan (B-W2b-318; PLN-082, PLN-084,
 * PLN-088): the plan of the site computed now (../readiness/service `livePlanOf`: the same inputs and netting as a run),
 * per material and colour its lines (several with B-W2b-306's order-specific lines), its row of item parameters, its lead
 * time as the plan and the buyer's queue count it (the site's lead time, else the approved source's, else the item's or
 * supplier's terms; a MAKE line: the site's make lead time) and the calendars: the supplier's closed days for a new
 * order's arrival (calendars/suppliers `arrivalDate`) and the site's for the first working day it can be used.
 */

export interface MaterialPlan {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lines: readonly { readonly requirement: PlannedRequirement; readonly netting: RequirementNetting }[]
  /** Each line's netting; a material with no line: its stock and purchase lines netted against nothing. */
  readonly peggings: readonly MaterialPegging[]
  readonly rule: ItemPlanningRow | null
}

/** The live plan of one material and colour. */
export function materialPlanOf(live: LivePlan, itemId: string, itemColourId: string | null): MaterialPlan {
  const lines = live.plan.requirements.flatMap((requirement, index) => (requirement.itemId === itemId && requirement.itemColourId === itemColourId ? [{ requirement, netting: live.plan.netting[index]! }] : []))
  const input = live.inputs.input
  const lots = new Map(input.lots.map((lot) => [lot.id, lot]))
  const peggings =
    lines.length > 0
      ? lines.map((line) => line.netting.pegging)
      : [
          pegMaterial({
            itemColourId,
            parts: [],
            stock: input.stock.filter((entry) => entry.itemId === itemId),
            lotOf: (lotId) => lots.get(lotId),
            reservations: (input.reservations ?? []).filter((reservation) => reservation.itemId === itemId),
            purchases: input.purchases.filter((line) => line.itemId === itemId && line.itemColourId === itemColourId),
            runDate: live.today,
          }),
        ]
  const rule = itemPlanningFor(live.inputs.itemPlanning.filter((row) => row.itemId === itemId), itemColourId)
  return { itemId, itemColourId, lines, peggings, rule }
}

/** The lead time of a material's line (BUY: to the goods at the site; MAKE: to make it); null: none on record. */
export function leadTimeOf(live: LivePlan, requirement: Pick<PlannedRequirement, 'itemId' | 'itemColourId' | 'action' | 'supplierId'>, rule: ItemPlanningRow | null): number | null {
  if (requirement.action === 'MAKE') return rule?.makeLeadTimeDays ?? null
  const inputs = live.inputs
  const source = requirement.supplierId ? sourceFor(inputs.sources, { companyId: live.site.companyId, itemId: requirement.itemId, itemColourId: requirement.itemColourId }, requirement.supplierId) : null
  return rule?.buyLeadTimeDays ?? (source ? sourceRules(source, inputs.supplierLeadTimes.get(requirement.supplierId!) ?? null).leadTimeDays : (inputs.input.supplyRulesOf?.(requirement.itemId, requirement.supplierId).leadTimeDays ?? null))
}

/** The calendars a delay walks: the suppliers' (by id) and the site's (from today, a year and a bit). */
export interface DelayCalendars {
  readonly suppliers: ReadonlyMap<string, WorkingCalendar | null>
  readonly site: WorkingCalendar | null
}

const YEAR = 400

export async function delayCalendarsOf(db: Reader, live: LivePlan, supplierIds: readonly string[], longestLead: number): Promise<DelayCalendars> {
  const client = db as Prisma.TransactionClient
  const ids = [...new Set(supplierIds)]
  const loaded = ids.length === 0 ? new Map() : await supplierCalendarsFor(client, ids, leadTimeWindow(live.today, Math.min(Math.max(longestLead, 1), YEAR), 'forward'))
  const site = await workingCalendarFor(client, { scope: 'SITE', id: live.site.id }, { from: plusDays(live.today, -1), to: plusDays(live.today, YEAR + Math.min(longestLead, YEAR) + 366) }).catch(() => null)
  return { suppliers: new Map(ids.map((id) => [id, loaded.get(id)?.calendar ?? null])), site: site?.calendar ?? null }
}

/** A new order's earliest arrival, placed today (the supplier's closed days not counted; MAKE: calendar days). */
export function arrivalOf(today: BusinessDate, action: 'BUY' | 'MAKE', supplierId: string | null, leadTimeDays: number | null, calendars: DelayCalendars): BusinessDate {
  if (leadTimeDays === null) return today
  if (action === 'MAKE' || !supplierId) return plusDays(today, leadTimeDays)
  return arrivalDate(calendars.suppliers.get(supplierId) ?? null, today, leadTimeDays).date
}

/** The site's first working day on or after a day (the day itself beyond its calendar or without one). */
export const onWorkingDayOf =
  (calendars: DelayCalendars) =>
  (day: BusinessDate): BusinessDate => {
    if (!calendars.site) return day
    try {
      return addWorkingDays(calendars.site, day, 0).date ?? day
    } catch {
      return day
    }
  }
