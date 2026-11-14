import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { SHIPPING_SETTINGS_MANAGE, SHIPPING_SETTINGS_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { cutOffProblems, ISO_WEEKDAYS, type IsoWeekday } from '@nexus/factory-domain/shipping/queue/cutoff'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { assertMay, officeContextOf } from '../access'

/**
 * A site's carrier cut-offs (B-W2b-386; LOG-018; factory-db CarrierCutOff, B-W2b-364): per carrier and weekday the time of
 * day (HH:MM, the site's zone) by which its parcels must be ready; a carrier without one takes the site's default
 * (ShippingSettings.cutOffTime, W1's settings route). shipping.settings.view reads them; shipping.settings.manage saves the
 * whole table at once (ONE command under the site's cut-off lock: rows gone are deleted, changed ones updated, new ones
 * inserted; each change audited).
 */

const COLUMNS = { id: true, carrierCode: true, weekday: true, cutOffTime: true } as const

const order = (a: { carrierCode: string; weekday: string }, b: { carrierCode: string; weekday: string }) =>
  a.carrierCode.localeCompare(b.carrierCode) || ISO_WEEKDAYS.indexOf(a.weekday as IsoWeekday) - ISO_WEEKDAYS.indexOf(b.weekday as IsoWeekday)

async function readTable(db: CommandTx, siteId: string) {
  const settings = await db.shippingSettings.findUnique({ where: { id: siteId }, select: { cutOffTime: true, defaultCarrierCode: true } })
  const rows = await db.carrierCutOff.findMany({ where: { siteId }, select: COLUMNS })
  return {
    siteId,
    defaultCutOff: settings?.cutOffTime ?? null,
    defaultCarrierCode: settings?.defaultCarrierCode ?? null,
    cutOffs: rows.map((row) => ({ id: row.id, carrierCode: row.carrierCode, weekday: row.weekday as IsoWeekday, time: row.cutOffTime })).sort(order),
  }
}

async function siteFor(caller: CommandCaller, siteId: string, permission: typeof SHIPPING_SETTINGS_VIEW | typeof SHIPPING_SETTINGS_MANAGE) {
  const context = officeContextOf(caller)
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } }))
  if (!site) throw new NotFoundError('Site not found.')
  assertMay(context, SHIPPING_SETTINGS_VIEW, permission, { companyId: site.companyId, siteId: site.id }, 'Site')
  return site
}

/** GET /shipping/sites/:siteId/cut-offs (shipping.settings.view). */
export async function getCutOffs(caller: CommandCaller, siteId: string) {
  const site = await siteFor(caller, siteId, SHIPPING_SETTINGS_VIEW)
  return caller.withClient((client) => readTable(client, site.id))
}

export interface CutOffsBody {
  readonly cutOffs: readonly { readonly carrierCode: string; readonly weekday: IsoWeekday; readonly time: string }[]
}

/** PUT /shipping/sites/:siteId/cut-offs (shipping.settings.manage): the site's whole cut-off table. */
export async function saveCutOffs(caller: CommandCaller, siteId: string, body: CutOffsBody, idempotencyKey?: string) {
  const site = await siteFor(caller, siteId, SHIPPING_SETTINGS_MANAGE)
  const wanted = body.cutOffs.map((row) => ({ carrierCode: row.carrierCode.trim(), weekday: row.weekday, time: row.time.trim() }))
  const problems = cutOffProblems(wanted)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
  const { result } = await command(caller, { name: 'shipping.saveCutOffs', idempotencyKey, input: { siteId, ...body } }, async (tools) => {
    await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.cut-offs', ${site.id}::uuid), 0))`
    const before = await tools.tx.carrierCutOff.findMany({ where: { siteId: site.id }, select: COLUMNS })
    const keyOf = (row: { carrierCode: string; weekday: string }) => `${row.carrierCode}|${row.weekday}`
    const now = new Map(wanted.map((row) => [keyOf(row), row]))
    let changed = 0
    for (const row of before) {
      const next = now.get(keyOf(row))
      if (!next) {
        await tools.tx.carrierCutOff.delete({ where: { id: row.id }, select: { id: true } })
        tools.audit({ action: 'shipping.cutOffRemoved', recordType: 'CarrierCutOff', recordId: row.id, companyId: site.companyId, siteId: site.id, before: { carrierCode: row.carrierCode, weekday: row.weekday, time: row.cutOffTime } })
        changed++
      } else if (next.time !== row.cutOffTime) {
        await tools.tx.carrierCutOff.update({ where: { id: row.id }, data: { cutOffTime: next.time, version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: 'shipping.cutOffChanged', recordType: 'CarrierCutOff', recordId: row.id, companyId: site.companyId, siteId: site.id, before: { time: row.cutOffTime }, after: { carrierCode: row.carrierCode, weekday: row.weekday, time: next.time } })
        changed++
      }
    }
    const kept = new Set(before.map(keyOf))
    for (const row of wanted.filter((candidate) => !kept.has(keyOf(candidate)))) {
      const id = newId()
      await tools.tx.carrierCutOff.create({ data: { id, companyId: site.companyId, siteId: site.id, carrierCode: row.carrierCode, weekday: row.weekday, cutOffTime: row.time, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
      tools.audit({ action: 'shipping.cutOffAdded', recordType: 'CarrierCutOff', recordId: id, companyId: site.companyId, siteId: site.id, after: { carrierCode: row.carrierCode, weekday: row.weekday, time: row.time } })
      changed++
    }
    // Saving the same table again writes nothing but its audit row (every command writes one).
    if (changed === 0) tools.audit({ action: 'shipping.cutOffsSaved', recordType: 'Site', recordId: site.id, companyId: site.companyId, siteId: site.id, after: { cutOffs: wanted.length, changed: 0 } })
    tools.emit({ type: 'shipping.cut_offs_saved', subject: site.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, cutOffs: wanted.length } })
    return readTable(tools.tx, site.id)
  })
  return result
}
