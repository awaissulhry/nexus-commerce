import type { Prisma } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { accountProblems, type LabelEnvironment } from '@nexus/factory-domain/shipping/labels/labels'
import { SHIPPING_SETTINGS_MANAGE, SHIPPING_SETTINGS_VIEW, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { backToTestRefusal, goLiveRefusal, TEST_LABEL_PREFIX, TEST_MODE_WORDS, testModeRefusalPath, type TestModeRefusalCode } from '@nexus/factory-domain/shipping/test-mode/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMay, officeContextOf } from '../access'
import { carrierAccountIdOf } from '../labels/store'

/**
 * Test carrier mode per site (B-W2b-390; LOG-035; rules factory-domain shipping/test-mode; design warehouse.shipping "Test
 * mode", pop-up "Switch to live labels"). Office only.
 *
 *   read     shipping.view: every site the reader's grants reach, in test mode or live (since when, switched by whom), what
 *            going live would do (ready, or the refusal in words; the TEST labels of shipments not yet left it clears) and
 *            whether any site is in test mode (the shell's TEST MODE banner)
 *   live     shipping.settings.manage over the site + a fresh step-up: refused first in words (no settings, live already, no
 *            usable Sendcloud connection), then the code, then ONE command on the site's ShippingSettings (its version):
 *            testMode false, liveSince now, liveSetById the person, and every TEST label of the site's shipments that have
 *            not left is cleared (each a `shipping.voidLabel` audit row of its parcel, NOT_SENT, and its events): those
 *            parcels are labelled again, live, before they leave. Event shipping.test_mode_changed
 *   test     shipping.settings.manage, no step-up (nothing is spent): back to test mode; live labels bought stay
 */

const SITE_SELECT = { id: true, companyId: true, code: true, name: true } as const
const SETTINGS_SELECT = { id: true, testMode: true, liveSince: true, liveSetById: true, integrationAccountId: true, version: true } as const satisfies Prisma.ShippingSettingsSelect
type Site = { id: string; companyId: string; code: string; name: string }
type Settings = Prisma.ShippingSettingsGetPayload<{ select: typeof SETTINGS_SELECT }>

const refused = (code: TestModeRefusalCode, message: string): never => {
  throw new DomainError('conflict', message, [{ path: testModeRefusalPath(code), message }])
}

/** The open (DRAFT or PACKED) shipments' parcels of the site that carry a TEST label. */
const testLabelsWhere = (siteId: string): Prisma.ParcelWhereInput => ({ siteId, carrierParcelId: { startsWith: TEST_LABEL_PREFIX }, shipment: { status: { in: ['DRAFT', 'PACKED'] } } })

/** What going live needs of the site's Sendcloud connection: the buy's own account rule (labels.ts accountProblems). */
async function liveAccountProblems(db: CommandTx, site: Site, settings: Settings | null, environment: LabelEnvironment) {
  const accountId = await carrierAccountIdOf(db, { companyId: site.companyId, siteId: site.id, integrationAccountId: null }, settings?.integrationAccountId ?? null)
  const account = accountId ? await db.integrationAccount.findUnique({ where: { id: accountId }, select: { id: true, provider: true, companyId: true, mode: true, status: true } }) : null
  return accountProblems(account, site.companyId, environment)
}

async function siteView(db: CommandTx, site: Site, settings: Settings | null, environment: LabelEnvironment) {
  const testMode = settings?.testMode ?? true
  const refusal = goLiveRefusal(settings, settings?.testMode ? await liveAccountProblems(db, site, settings, environment) : [])
  return {
    siteId: site.id,
    companyId: site.companyId,
    code: site.code,
    name: site.name,
    hasSettings: settings !== null,
    version: settings?.version ?? null,
    testMode,
    liveSince: settings?.liveSince ? toUtcIso(settings.liveSince) : null,
    liveSetById: settings?.liveSetById ?? null,
    words: testMode ? TEST_MODE_WORDS.TEST : TEST_MODE_WORDS.LIVE,
    goLive: {
      ready: refusal === null,
      refusal,
      warning: TEST_MODE_WORDS.GO_LIVE,
      testLabelsToClear: testMode ? await db.parcel.count({ where: testLabelsWhere(site.id) }) : 0,
    },
  }
}

/** shipping.view: the test mode of every site the reader reaches (or one company's, or one site). */
export async function getTestModes(caller: CommandCaller, query: { companyId?: string | undefined; siteId?: string | undefined }, environment: LabelEnvironment) {
  const context = officeContextOf(caller)
  const where: Prisma.SiteWhereInput = {
    AND: [
      scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput,
      { status: 'ACTIVE' },
      query.companyId ? { companyId: query.companyId } : {},
      query.siteId ? { id: query.siteId } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({ where, select: SITE_SELECT, orderBy: [{ companyId: 'asc' }, { code: 'asc' }] })
    const rows = await client.shippingSettings.findMany({ where: { id: { in: sites.map((site) => site.id) } }, select: SETTINGS_SELECT })
    const byId = new Map(rows.map((row) => [row.id, row]))
    const views = []
    for (const site of sites) views.push(await siteView(client, site, byId.get(site.id) ?? null, environment))
    return { sites: views, anyInTestMode: views.some((view) => view.testMode) }
  })
}

export interface SwitchBody {
  readonly testMode: boolean
  readonly version?: number | undefined
}

/** Clears the TEST labels of the site's open shipments (inside the go-live command); how many. */
async function clearTestLabels(tools: CommandTools, site: Site): Promise<number> {
  const { tx } = tools
  const found = await tx.parcel.findMany({ where: testLabelsWhere(site.id), select: { shipmentId: true }, distinct: ['shipmentId'] })
  if (found.length === 0) return 0
  // Each shipment's row first (sorted): a packer's command on it waits, and its labels are read after.
  const shipmentIds = found.map((row) => row.shipmentId).sort()
  await tx.$queryRaw`SELECT 1 FROM "Shipment" WHERE "id" = ANY(${shipmentIds}::uuid[]) ORDER BY "id" FOR UPDATE`
  const parcels = await tx.parcel.findMany({
    where: { ...testLabelsWhere(site.id), shipmentId: { in: shipmentIds } },
    select: { id: true, seq: true, shipmentId: true, trackingNumber: true, carrierParcelId: true, labelledAt: true, shipment: { select: { number: true, status: true } } },
    orderBy: [{ shipmentId: 'asc' }, { seq: 'asc' }],
  })
  const reason = 'Switched to live labels: the TEST label of test mode is cleared (label the parcel again before it leaves).'
  const touched = new Map<string, { number: string; status: 'DRAFT' | 'PACKED' }>()
  for (const parcel of parcels) {
    await tx.parcel.update({ where: { id: parcel.id }, data: { trackingNumber: null, carrierParcelId: null, labelledAt: null, trackingUrl: null, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'shipping.voidLabel',
      recordType: 'Parcel',
      recordId: parcel.id,
      companyId: site.companyId,
      siteId: site.id,
      before: { trackingNumber: parcel.trackingNumber, providerId: parcel.carrierParcelId, labelledAt: parcel.labelledAt ? toUtcIso(parcel.labelledAt) : null },
      after: { trackingNumber: null, carrier: 'NOT_SENT', test: true },
      reason,
    })
    tools.emit({ type: 'shipment.label_voided', subject: parcel.shipmentId, companyId: site.companyId, siteId: site.id, payload: { shipmentId: parcel.shipmentId, number: parcel.shipment.number, parcelId: parcel.id, seq: parcel.seq, queued: false } })
    touched.set(parcel.shipmentId, { number: parcel.shipment.number, status: parcel.shipment.status as 'DRAFT' | 'PACKED' })
  }
  for (const [shipmentId, shipment] of touched) {
    tools.emit({ type: 'shipment.packing_changed', subject: shipmentId, companyId: site.companyId, siteId: site.id, payload: { shipmentId, number: shipment.number, status: shipment.status, change: 'parcels' } })
  }
  return parcels.length
}

/**
 * shipping.settings.manage: the site's test mode switched. Going live (testMode false) is refused first in words, then asks
 * `stepUp()` (a fresh code: the route's requireStepUp), then writes; back to test mode asks no code.
 */
export async function switchTestMode(caller: CommandCaller, siteId: string, body: SwitchBody, stepUp: () => void, environment: LabelEnvironment, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: SITE_SELECT })) : null
  assertMay(context, SHIPPING_SETTINGS_VIEW, SHIPPING_SETTINGS_MANAGE, site ? { companyId: site.companyId, siteId: site.id } : null, 'Site')
  const live = !body.testMode
  const refusalOf = async (db: CommandTx) => {
    const settings = await db.shippingSettings.findUnique({ where: { id: site!.id }, select: SETTINGS_SELECT })
    const refusal = live ? goLiveRefusal(settings, settings?.testMode ? await liveAccountProblems(db, site!, settings, environment) : []) : backToTestRefusal(settings)
    return { settings, refusal }
  }
  const first = await caller.withClient(refusalOf)
  if (first.refusal) refused(first.refusal.code, first.refusal.message)
  if (live) stepUp()

  const { result } = await command(
    caller,
    { name: live ? 'shipping.goLive' : 'shipping.backToTestMode', idempotencyKey, input: { siteId, ...body }, record: { type: 'ShippingSettings', id: site!.id, expectedVersion: body.version } },
    async (tools) => {
      const { settings, refusal } = await refusalOf(tools.tx)
      if (refusal || !settings) return refused(refusal?.code ?? 'NO_SETTINGS', refusal?.message ?? 'This site has no shipping settings yet.')
      // When it went live: the app's clock, never ahead of the database's (its rule refuses a time in the future).
      const databaseNow = (await tools.tx.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`)[0]!.now
      const at = tools.now.getTime() > databaseNow.getTime() ? databaseNow : tools.now
      const data = live ? { testMode: false, liveSince: at, liveSetById: context.actorId } : { testMode: true, liveSince: null, liveSetById: null }
      await tools.tx.shippingSettings.update({ where: { id: site!.id }, data, select: { id: true } })
      const cleared = live ? await clearTestLabels(tools, site!) : 0
      tools.audit({
        recordType: 'ShippingSettings',
        recordId: site!.id,
        companyId: site!.companyId,
        siteId: site!.id,
        before: { testMode: settings.testMode, liveSince: settings.liveSince ? toUtcIso(settings.liveSince) : null, liveSetById: settings.liveSetById },
        after: { testMode: data.testMode, liveSince: data.liveSince ? toUtcIso(data.liveSince) : null, liveSetById: data.liveSetById, clearedTestLabels: cleared },
      })
      tools.emit({ type: 'shipping.test_mode_changed', subject: site!.id, companyId: site!.companyId, siteId: site!.id, payload: { siteId: site!.id, testMode: data.testMode, clearedTestLabels: cleared } })
      return { cleared }
    },
  )
  const view = await caller.withClient(async (client) => siteView(client, site!, await client.shippingSettings.findUnique({ where: { id: site!.id }, select: SETTINGS_SELECT }), environment))
  return { site: view, clearedTestLabels: result.cleared }
}
