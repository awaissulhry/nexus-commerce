import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SHIPPING_SETTINGS_MANAGE, SHIPPING_SETTINGS_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { packingPrinterProblems, shippingSettingsProblems, type ShippingAddress } from '@nexus/factory-domain/shipping/settings'
import type { TransportBy } from '@nexus/factory-domain/shipping/shipments'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMay, officeContextOf } from '../access'
import type { SettingsView } from './contract'

/**
 * A site's shipping settings (LOG-117; A2 SCR-068): read per site, saved whole by the office (shipping.settings.manage
 * over the site's company and the site). The row has the site's own id. The floor reads its site's settings through
 * the packing view, never here.
 */

const SETTINGS_SELECT = {
  id: true,
  siteId: true,
  companyId: true,
  senderAddress: true,
  returnAddress: true,
  integrationAccountId: true,
  defaultCarrierCode: true,
  defaultServiceCode: true,
  defaultTransportBy: true,
  defaultGoodsAppearance: true,
  labelPrinterId: true,
  documentPrinterId: true,
  cutOffTime: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.ShippingSettingsSelect

type SettingsRow = Prisma.ShippingSettingsGetPayload<{ select: typeof SETTINGS_SELECT }>
const SITE_SELECT = { id: true, companyId: true, code: true, name: true } as const

const view = (row: SettingsRow): SettingsView => ({
  ...row,
  senderAddress: row.senderAddress as Record<string, unknown>,
  returnAddress: (row.returnAddress as Record<string, unknown> | null) ?? null,
  updatedAt: toUtcIso(row.updatedAt),
})

/** The settings of a site, read in any client (the packing view reads them for the floor). */
export async function readSettings(db: CommandTx, siteId: string): Promise<SettingsView | null> {
  const row = await db.shippingSettings.findUnique({ where: { id: siteId }, select: SETTINGS_SELECT })
  return row ? view(row) : null
}

/** shipping.settings.view: every site the caller's grants reach, with its settings or null. */
export async function listSettings(caller: CommandCaller, query: { companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const where: Prisma.SiteWhereInput = {
    AND: [scopeWhere(actorOf(context), SHIPPING_SETTINGS_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.companyId ? { companyId: query.companyId } : {}],
  }
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({ where, select: SITE_SELECT, orderBy: [{ companyId: 'asc' }, { code: 'asc' }] })
    const rows = await client.shippingSettings.findMany({ where: { id: { in: sites.map((site) => site.id) } }, select: SETTINGS_SELECT })
    const byId = new Map(rows.map((row) => [row.id, view(row)]))
    return { sites: sites.map((site) => ({ site, settings: byId.get(site.id) ?? null })) }
  })
}

async function siteOf(caller: CommandCaller, siteId: string, permission: typeof SHIPPING_SETTINGS_VIEW | typeof SHIPPING_SETTINGS_MANAGE) {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: SITE_SELECT })) : null
  assertMay(context, SHIPPING_SETTINGS_VIEW, permission, site ? { companyId: site.companyId, siteId: site.id } : null, 'Site')
  return site!
}

export async function getSettings(caller: CommandCaller, siteId: string) {
  const site = await siteOf(caller, siteId, SHIPPING_SETTINGS_VIEW)
  return { site, settings: await caller.withClient((client) => readSettings(client, site.id)) }
}

export interface SaveSettingsInput {
  readonly version?: number | undefined
  readonly senderAddress: ShippingAddress
  readonly returnAddress?: ShippingAddress | null | undefined
  readonly integrationAccountId?: string | null | undefined
  readonly defaultCarrierCode?: string | null | undefined
  readonly defaultServiceCode?: string | null | undefined
  readonly defaultTransportBy?: TransportBy | undefined
  readonly defaultGoodsAppearance?: string | null | undefined
  readonly labelPrinterId?: string | null | undefined
  readonly documentPrinterId?: string | null | undefined
  readonly cutOffTime?: string | null | undefined
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** The printers and the Sendcloud account named: of this site (printers) and of its company or the tenant (account). */
async function referenceProblems(caller: CommandCaller, site: { id: string; companyId: string }, body: SaveSettingsInput): Promise<Issue[]> {
  const problems: Issue[] = []
  await caller.withClient(async (client) => {
    for (const slot of ['labelPrinterId', 'documentPrinterId'] as const) {
      const printerId = body[slot]
      if (!printerId) continue
      const printer = await client.printer.findUnique({ where: { id: printerId }, select: { siteId: true, kind: true, status: true } })
      problems.push(...packingPrinterProblems(slot, printer, site.id, `body/${slot}`))
    }
    if (body.integrationAccountId) {
      const account = await client.integrationAccount.findUnique({ where: { id: body.integrationAccountId }, select: { provider: true, companyId: true } })
      if (!account || account.provider !== 'SENDCLOUD' || (account.companyId !== null && account.companyId !== site.companyId)) {
        problems.push({ path: 'body/integrationAccountId', message: "Not a Sendcloud account of this site's company." })
      }
    }
  })
  return problems
}

/** shipping.settings.manage: saves a site's settings whole (creates them the first time). */
export async function saveSettings(caller: CommandCaller, siteId: string, body: SaveSettingsInput, idempotencyKey?: string): Promise<{ created: boolean; site: { id: string; companyId: string; code: string; name: string }; settings: SettingsView }> {
  const context = officeContextOf(caller)
  const site = await siteOf(caller, siteId, SHIPPING_SETTINGS_MANAGE)
  const data = {
    senderAddress: body.senderAddress as unknown as Prisma.InputJsonValue,
    integrationAccountId: body.integrationAccountId ?? null,
    defaultCarrierCode: blankToNull(body.defaultCarrierCode),
    defaultServiceCode: blankToNull(body.defaultServiceCode),
    defaultTransportBy: body.defaultTransportBy ?? 'CARRIER',
    defaultGoodsAppearance: blankToNull(body.defaultGoodsAppearance),
    labelPrinterId: body.labelPrinterId ?? null,
    documentPrinterId: body.documentPrinterId ?? null,
    cutOffTime: blankToNull(body.cutOffTime),
  }
  const returnAddress = body.returnAddress ? (body.returnAddress as unknown as Prisma.InputJsonValue) : null
  const problems = [
    ...shippingSettingsProblems({ ...body, defaultCarrierCode: data.defaultCarrierCode, defaultServiceCode: data.defaultServiceCode, cutOffTime: data.cutOffTime }),
    ...(await referenceProblems(caller, site, body)),
  ]
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The shipping settings are not valid.', problems)

  const existing = await caller.withClient((client) => readSettings(client, site.id))
  if (!existing && body.version !== undefined) throw new NotFoundError('This site has no shipping settings yet; save them without a version.')
  const { result } = await command(
    caller,
    {
      name: 'shipping.saveSettings',
      idempotencyKey,
      input: { siteId, ...body },
      ...(existing ? { record: { type: 'ShippingSettings' as const, id: site.id, expectedVersion: body.version } } : {}),
    },
    async (tools) => {
      const before = existing ? await readSettings(tools.tx, site.id) : null
      if (before) {
        await tools.tx.shippingSettings.update({ where: { id: site.id }, data: { ...data, ...(returnAddress ? { returnAddress } : {}) }, select: { id: true } })
        // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
        if (!returnAddress && before.returnAddress !== null) await tools.tx.$executeRaw`UPDATE "ShippingSettings" SET "returnAddress" = NULL WHERE "id" = ${site.id}::uuid`
      } else {
        const { count } = await tools.tx.shippingSettings.createMany({
          data: [{ id: site.id, companyId: site.companyId, siteId: site.id, ...data, ...(returnAddress ? { returnAddress } : {}), createdById: context.actorId }],
          skipDuplicates: true,
        })
        if (count !== 1) throw new ConflictError('The shipping settings of this site were just saved by someone else; reload them and save again.')
      }
      const after = (await readSettings(tools.tx, site.id))!
      const strip = (settings: SettingsView | null) => {
        if (!settings) return null
        const { version: _version, updatedAt: _updatedAt, ...rest } = settings
        return rest
      }
      tools.audit({ action: before ? 'shipping.saveSettings' : 'shipping.createSettings', recordType: 'ShippingSettings', recordId: site.id, companyId: site.companyId, siteId: site.id, before: strip(before), after: strip(after) })
      tools.emit({ type: 'shipping.settings_saved', subject: site.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, created: before === null } })
      return { created: before === null, site, settings: after }
    },
  )
  return result
}
