import type { Prisma } from '../src/generated/prisma/client'
import { AlertRouteScope, DigestSection, KpiGrain, KpiState, KpiUnit, KpiUseKind } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAlerts } from './alerts'
import { seed as seedAuth } from './auth'
import { seed as seedParties } from './parties'
import { seed as seedRoles } from './roles'

/**
 * The metric layer seed (W2b schema wave 57/57, B-W2b-381), per tenant of seed/_core.ts, written as the API and its rebuild
 * write these rows: in the tenant's office scope. It runs the auth, roles, alerts and parties seeds itself (the CLI runs the
 * seed files in name order, and this one sorts before parties). Every name and text is made up; every number too.
 *
 *   KPIs       supplier on-time v1 (DRAFT: the first row); on-time in full v1 (in force, then SUPERSEDED by v2), v2 (in force,
 *              made from v1 with what changed) and v3 (DRAFT, made from v2); scrap rate, WIP value (cost) and order margin
 *              (margin) in force; quotes sent RETIRED.
 *   uses       on-time in full on the Owner's dashboard (the first row), in the late-orders report and the late-order alert;
 *              scrap rate in the scrap report; order margin in the margin report.
 *   layouts    the owner's Owner group dashboard (the first row: the by-company panel hidden), the member's sales dashboard.
 *   digests    the member's (off: the first row), the owner's group digest (on, in English, three sections; it has never
 *              gone out: no company's switch is on).
 *   settings   company A's and company B's switch for the morning e-mail, both OFF (the first row: A's).
 *   routes     the hold rule (company A, plant A1) to Quality at plant A1 (the first row) and to the member for line A1-L1; the
 *              late-order rule to Sales for customer P1 and to the planner for company B.
 *   facts      company A on 10-12 November: orders in (the first row), the value and the margin of orders in, line A1-L1's
 *              output and scrap, plant A1's WIP at cost; company B's orders in. Per hour: line A1-L1's output 08:00-10:00
 *              on 12 November (the first row: 08:00).
 *
 * Nothing is switched on: no company's morning e-mail goes out (the Owner's rule of 11-13). The generated isolation tests
 * (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id (ids with eight zeros) and insert the copy: so the
 * first KPI version is a DRAFT made from nothing, the first digest is off and never sent. Fixed instants, so nothing depends on
 * the clock. Idempotent: rows are written once (skipDuplicates), and each later step only moves a row still in the step
 * before.
 */

const AT = new Date('2026-11-13T08:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)
const DAY = 24 * 60
const REBUILT_AT = new Date('2026-11-13T02:00:00.000Z')

/** A fact's key, as factory-domain's rebuild writes it (the database checks it). */
export function factDailyKey(companyId: string, siteId: string | null, lineId: string | null, day: string, measureKey: string): string {
  return `fact:${companyId}:${siteId ?? 'all'}:${lineId ?? 'all'}:${day}:${measureKey}`
}

/** An hourly fact's key: the hour's start in UTC as YYYY-MM-DDTHH:MMZ. */
export function factHourlyKey(companyId: string, siteId: string | null, lineId: string | null, hourStart: Date, measureKey: string): string {
  return `facth:${companyId}:${siteId ?? 'all'}:${lineId ?? 'all'}:${hourStart.toISOString().slice(0, 16)}Z:${measureKey}`
}

export interface InsightsDepthSeed {
  readonly kpiIds: {
    readonly supplierOnTime: string
    readonly otifV1: string
    readonly otifV2: string
    readonly otifV3: string
    readonly scrapRate: string
    readonly wipValue: string
    readonly orderMargin: string
    readonly quotesSent: string
  }
  readonly useIds: readonly string[]
  readonly layoutIds: { readonly owner: string; readonly member: string }
  readonly digestIds: { readonly member: string; readonly owner: string }
  readonly settingsIds: { readonly companyA: string; readonly companyB: string }
  readonly routeIds: { readonly holdQuality: string; readonly holdMember: string; readonly lateSales: string; readonly latePlannerB: string }
  readonly factDailyIds: readonly string[]
  readonly factHourlyIds: readonly string[]
}

export async function seed(context: SeedContext): Promise<InsightsDepthSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const { roleIds } = await seedRoles(context)
  await seedAlerts(context)
  await seedParties(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA1 = id('site:A1')
  const lineA1 = id('site:A1:line:L1')
  const role = (key: string): string => roleIds[key] as string
  const office = { audience: 'office' as const, tenantId, actorId: ownerId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: ownerId })

  const result: InsightsDepthSeed = {
    kpiIds: {
      supplierOnTime: firstId('insights-depth:kpi:purchasing.supplier_on_time:1'),
      otifV1: id('insights-depth:kpi:delivery.otif:1'),
      otifV2: id('insights-depth:kpi:delivery.otif:2'),
      otifV3: id('insights-depth:kpi:delivery.otif:3'),
      scrapRate: id('insights-depth:kpi:production.scrap_rate:1'),
      wipValue: id('insights-depth:kpi:production.wip_value:1'),
      orderMargin: id('insights-depth:kpi:sales.order_margin:1'),
      quotesSent: id('insights-depth:kpi:sales.quotes_sent:1'),
    },
    useIds: [
      firstId('insights-depth:use:otif:dashboard'),
      id('insights-depth:use:otif:report'),
      id('insights-depth:use:otif:alert'),
      id('insights-depth:use:scrap:report'),
      id('insights-depth:use:margin:report'),
    ],
    layoutIds: { owner: firstId('insights-depth:layout:owner'), member: id('insights-depth:layout:member') },
    digestIds: { member: firstId('insights-depth:digest:member'), owner: id('insights-depth:digest:owner') },
    settingsIds: { companyA: firstId('insights-depth:settings:A'), companyB: id('insights-depth:settings:B') },
    routeIds: {
      holdQuality: firstId('insights-depth:route:hold:quality'),
      holdMember: id('insights-depth:route:hold:member'),
      lateSales: id('insights-depth:route:late:sales'),
      latePlannerB: id('insights-depth:route:late:planner-b'),
    },
    factDailyIds: [],
    factHourlyIds: [],
  }
  const K = result.kpiIds

  // --- KPI definitions (ANA-012, ANA-070) ----------------------------------------------------------------------------------
  const kpi = (
    kpiId: string,
    kpiKey: string,
    kpiVersion: number,
    words: { nameIt: string; nameEn: string; definitionIt: string; definitionEn: string; formulaIt: string; formulaEn: string },
    rest: Partial<Prisma.KpiDefinitionCreateManyInput> & Pick<Prisma.KpiDefinitionCreateManyInput, 'sourceRecords' | 'ownerRoleId' | 'unit'>,
  ): Prisma.KpiDefinitionCreateManyInput => ({ id: kpiId, kpiKey, kpiVersion, ...words, ...rest, ...stamp(minutes(-10 * DAY)) })
  const otifWords = {
    nameIt: 'Consegne puntuali e complete',
    nameEn: 'On-time in full',
    definitionIt: 'Righe d\'ordine spedite complete entro la prima data promessa, sul totale delle righe dovute nel periodo. Esclude i campioni (dati di esempio).',
    definitionEn: 'Order lines shipped complete by the first promised date, over the lines due in the period. Samples are left out (made-up text).',
    formulaIt: 'righe spedite complete in tempo ÷ righe dovute × 100',
    formulaEn: 'lines shipped complete on time ÷ lines due × 100',
  }
  const firstKpis: Prisma.KpiDefinitionCreateManyInput[] = [
    kpi(
      K.supplierOnTime,
      'purchasing.supplier_on_time',
      1,
      {
        nameIt: 'Puntualità dei fornitori',
        nameEn: 'Supplier on-time',
        definitionIt: 'Righe d\'acquisto ricevute entro la data confermata, sul totale delle righe ricevute (bozza, dati di esempio).',
        definitionEn: 'Purchase lines received by their confirmed date, over the lines received (a draft, made-up text).',
        formulaIt: 'righe ricevute in tempo ÷ righe ricevute × 100',
        formulaEn: 'lines received on time ÷ lines received × 100',
      },
      { sourceRecords: ['PurchaseOrderLine', 'GoodsReceipt'], measureKeys: ['purchasing.lines_received', 'purchasing.lines_on_time'], ownerRoleId: role('buyer'), unit: KpiUnit.PERCENT },
    ),
    kpi(K.otifV1, 'delivery.otif', 1, otifWords, {
      sourceRecords: ['SalesOrderLine', 'Shipment'],
      measureKeys: ['orders.lines_due', 'orders.lines_shipped_on_time'],
      ownerRoleId: role('planner'),
      unit: KpiUnit.PERCENT,
    }),
    kpi(
      K.scrapRate,
      'production.scrap_rate',
      1,
      {
        nameIt: 'Tasso di scarto',
        nameEn: 'Scrap rate',
        definitionIt: 'Pezzi scartati sui pezzi prodotti, per linea e turno; mai per persona (dati di esempio).',
        definitionEn: 'Pieces scrapped over pieces made, by line and shift; never per person (made-up text).',
        formulaIt: 'pezzi scartati ÷ pezzi prodotti × 100',
        formulaEn: 'pieces scrapped ÷ pieces made × 100',
      },
      { sourceRecords: ['OperationScan', 'OperationScanDefect'], measureKeys: ['production.output_pieces', 'production.scrap_pieces'], ownerRoleId: role('production_manager'), unit: KpiUnit.PERCENT },
    ),
    kpi(
      K.wipValue,
      'production.wip_value',
      1,
      {
        nameIt: 'Valore del semilavorato',
        nameEn: 'WIP value',
        definitionIt: 'Il valore a costo dei capi in lavorazione a fine giornata (dati di esempio).',
        definitionEn: 'The value at cost of the garments in work at the end of the day (made-up text).',
        formulaIt: 'somma dei costi dei capi in lavorazione',
        formulaEn: 'sum of the cost of the garments in work',
      },
      { sourceRecords: ['WorkOrder', 'WorkOrderCostEntry'], measureKeys: ['wip.cost'], ownerRoleId: role('finance'), unit: KpiUnit.MONEY, grain: KpiGrain.COST },
    ),
    kpi(
      K.orderMargin,
      'sales.order_margin',
      1,
      {
        nameIt: 'Margine per ordine',
        nameEn: 'Order margin',
        definitionIt: 'Il margine degli ordini entrati sul loro valore; si vede solo con il grano del margine (dati di esempio).',
        definitionEn: 'The margin of the orders in over their value; shown only with the margin grain (made-up text).',
        formulaIt: 'margine degli ordini ÷ valore degli ordini × 100',
        formulaEn: 'margin of orders ÷ value of orders × 100',
      },
      { sourceRecords: ['SalesOrder', 'SalesOrderLine'], measureKeys: ['orders.value', 'orders.margin'], ownerRoleId: role('sales'), unit: KpiUnit.PERCENT, grain: KpiGrain.MARGIN },
    ),
    kpi(
      K.quotesSent,
      'sales.quotes_sent',
      1,
      {
        nameIt: 'Preventivi inviati',
        nameEn: 'Quotes sent',
        definitionIt: 'Il numero di preventivi inviati nel periodo (ritirato, dati di esempio).',
        definitionEn: 'The number of quotes sent in the period (retired, made-up text).',
        formulaIt: 'conteggio dei preventivi inviati',
        formulaEn: 'count of quotes sent',
      },
      { sourceRecords: ['Quote'], ownerRoleId: role('sales'), unit: KpiUnit.COUNT },
    ),
  ]
  const otifV2 = kpi(
    K.otifV2,
    'delivery.otif',
    2,
    { ...otifWords, formulaEn: 'lines shipped complete by the first promised date ÷ lines due × 100', formulaIt: 'righe spedite complete entro la prima data promessa ÷ righe dovute × 100' },
    {
      basedOnId: K.otifV1,
      changeNote: 'On time now means by the first promised date, not the current one (made-up change).',
      sourceRecords: ['SalesOrderLine', 'Shipment'],
      measureKeys: ['orders.lines_due', 'orders.lines_shipped_on_time'],
      ownerRoleId: role('planner'),
      unit: KpiUnit.PERCENT,
    },
  )
  const otifV3 = kpi(K.otifV3, 'delivery.otif', 3, otifWords, {
    basedOnId: K.otifV2,
    changeNote: 'A draft that would count partial lines shipped on time (made-up change).',
    sourceRecords: ['SalesOrderLine', 'Shipment'],
    measureKeys: ['orders.lines_due', 'orders.lines_shipped_on_time'],
    ownerRoleId: role('planner'),
    unit: KpiUnit.PERCENT,
  })

  // --- uses (ANA-070) --------------------------------------------------------------------------------------------------------
  const use = (useId: string, kpiKey: string, usedIn: KpiUseKind, useKey: string): Prisma.KpiUseCreateManyInput => ({
    id: useId,
    kpiKey,
    usedIn,
    useKey,
    key: `kpiuse:${kpiKey}:${usedIn}:${useKey}`,
    createdAt: minutes(-5 * DAY),
    createdById: ownerId,
  })
  const [u0, u1, u2, u3, u4] = result.useIds as [string, string, string, string, string]
  const uses: Prisma.KpiUseCreateManyInput[] = [
    use(u0, 'delivery.otif', KpiUseKind.DASHBOARD, 'owner-group'),
    use(u1, 'delivery.otif', KpiUseKind.REPORT, 'sales.late-orders'),
    use(u2, 'delivery.otif', KpiUseKind.ALERT, 'ORDER_LATE_RISK'),
    use(u3, 'production.scrap_rate', KpiUseKind.REPORT, 'production.scrap-by-reason'),
    use(u4, 'sales.order_margin', KpiUseKind.REPORT, 'sales.margin-by-order'),
  ]

  // --- dashboard layouts (ANA-002) -------------------------------------------------------------------------------------------
  const layouts: Prisma.DashboardLayoutCreateManyInput[] = [
    {
      id: result.layoutIds.owner,
      userId: ownerId,
      dashboardKey: 'owner-group',
      key: `dashboard:${ownerId}:owner-group`,
      panels: [
        { id: 'numbers', hidden: false, width: 'FULL' },
        { id: 'needs-action', hidden: false, width: 'HALF' },
        { id: 'trends', hidden: false, width: 'HALF' },
        { id: 'by-company', hidden: true, width: 'FULL' },
      ],
      ...stamp(minutes(-2 * DAY)),
    },
    {
      id: result.layoutIds.member,
      userId: memberId,
      dashboardKey: 'sales',
      key: `dashboard:${memberId}:sales`,
      panels: [
        { id: 'numbers', hidden: false, width: 'FULL' },
        { id: 'report:sales.late-orders', hidden: false, width: 'TWO_THIRDS' },
        { id: 'needs-action', hidden: false, width: 'HALF' },
      ],
      ...stamp(minutes(-2 * DAY)),
    },
  ]

  // --- the morning e-mail (ANA-032) ------------------------------------------------------------------------------------------
  const settings: Prisma.InsightsSettingsCreateManyInput[] = [
    { id: result.settingsIds.companyA, companyId: companyA, key: `insights:${companyA}`, ...stamp(minutes(-3 * DAY)) },
    { id: result.settingsIds.companyB, companyId: companyB, key: `insights:${companyB}`, ...stamp(minutes(-3 * DAY)) },
  ]
  const digests: Prisma.DigestSettingCreateManyInput[] = [
    { id: result.digestIds.member, userId: memberId, key: `digest:${memberId}`, companyId: companyA, ...stamp(minutes(-DAY)) },
    {
      id: result.digestIds.owner,
      userId: ownerId,
      key: `digest:${ownerId}`,
      enabled: true,
      enabledAt: minutes(-DAY),
      enabledById: ownerId,
      sendTime: '07:30',
      timeZone: 'Europe/Rome',
      weekdays: [1, 2, 3, 4, 5, 6],
      locale: 'en',
      sections: [DigestSection.SHIPPED, DigestSection.LATE, DigestSection.APPROVALS],
      ...stamp(minutes(-DAY)),
    },
  ]

  // --- alert routes (ANA-041) ------------------------------------------------------------------------------------------------
  const holdRule = id('alerts:rule:HOLD_TOO_LONG')
  const lateRule = id('alerts:rule:ORDER_LATE_RISK')
  const partyP1 = id('party:P1')
  const route = (routeId: string, ruleId: string, scope: AlertRouteScope, scopeId: string, to: { roleId: string } | { userId: string }): Prisma.AlertRouteCreateManyInput => ({
    id: routeId,
    ruleId,
    scope,
    scopeId,
    ...to,
    key: `route:${ruleId}:${scope}:${scopeId}:${'roleId' in to ? `role:${to.roleId}` : `user:${to.userId}`}`,
    createdAt: minutes(-4 * DAY),
    createdById: ownerId,
  })
  const R = result.routeIds
  const routes: Prisma.AlertRouteCreateManyInput[] = [
    route(R.holdQuality, holdRule, AlertRouteScope.SITE, siteA1, { roleId: role('quality_inspector') }),
    route(R.holdMember, holdRule, AlertRouteScope.LINE, lineA1, { userId: memberId }),
    route(R.lateSales, lateRule, AlertRouteScope.CUSTOMER, partyP1, { roleId: role('sales') }),
    route(R.latePlannerB, lateRule, AlertRouteScope.COMPANY, companyB, { roleId: role('planner') }),
  ]

  // --- facts (ANA-069) -------------------------------------------------------------------------------------------------------
  type FactNumber = { value: string } | { priceAmount: number } | { costAmount: number } | { marginAmount: number }
  const daily: Prisma.FactDailyCreateManyInput[] = []
  const dailyFact = (first: boolean, companyId: string, siteId: string | null, lineId: string | null, day: string, measureKey: string, number: FactNumber): void => {
    const key = factDailyKey(companyId, siteId, lineId, day, measureKey)
    const factId = first ? firstId(`insights-depth:${key}`) : id(`insights-depth:${key}`)
    daily.push({ id: factId, companyId, siteId, lineId, day: new Date(`${day}T00:00:00.000Z`), measureKey, key, ...number, ...('value' in number ? {} : { currency: 'EUR' }), rebuiltAt: REBUILT_AT, createdAt: REBUILT_AT })
  }
  const days = ['2026-11-10', '2026-11-11', '2026-11-12'] as const
  days.forEach((day, index) => {
    dailyFact(index === 0, companyA, null, null, day, 'orders.lines_in', { value: String(12 + index * 3) })
    dailyFact(false, companyA, null, null, day, 'orders.value', { priceAmount: 1_250_000 + index * 180_000 })
    dailyFact(false, companyA, null, null, day, 'orders.margin', { marginAmount: 410_000 + index * 52_000 })
    dailyFact(false, companyA, siteA1, lineA1, day, 'production.output_pieces', { value: String(140 + index * 10) })
    dailyFact(false, companyA, siteA1, lineA1, day, 'production.scrap_pieces', { value: String(3 + index) })
    dailyFact(false, companyA, siteA1, null, day, 'wip.cost', { costAmount: 2_400_000 - index * 75_000 })
  })
  dailyFact(false, companyB, null, null, '2026-11-12', 'orders.lines_in', { value: '4' })

  const hourly: Prisma.FactHourlyCreateManyInput[] = []
  // 08:00, 09:00 and 10:00 in Rome on 12 November (UTC+1).
  ;['2026-11-12T07:00:00.000Z', '2026-11-12T08:00:00.000Z', '2026-11-12T09:00:00.000Z'].forEach((iso, index) => {
    const hourStart = new Date(iso)
    const key = factHourlyKey(companyA, siteA1, lineA1, hourStart, 'production.output_pieces')
    hourly.push({
      id: index === 0 ? firstId(`insights-depth:${key}`) : id(`insights-depth:${key}`),
      companyId: companyA,
      siteId: siteA1,
      lineId: lineA1,
      hourStart,
      day: new Date('2026-11-12T00:00:00.000Z'),
      measureKey: 'production.output_pieces',
      key,
      value: String(18 + index * 2),
      rebuiltAt: REBUILT_AT,
      createdAt: REBUILT_AT,
    })
  })
  const factDailyIds = daily.map((row) => row.id as string)
  const factHourlyIds = hourly.map((row) => row.id as string)

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.kpiDefinition.createMany({ data: firstKpis, skipDuplicates: true })
      // on-time in full v1 in force, then superseded by v2 (made from it); the margin, scrap and WIP KPIs in force; quotes sent
      // in force, then retired. Each step moves only a row still in the step before.
      const activate = (kpiId: string, at: Date) =>
        tx.kpiDefinition.updateMany({ where: { id: kpiId, state: KpiState.DRAFT }, data: { state: KpiState.ACTIVE, activatedAt: at, activatedById: ownerId, version: { increment: 1 }, updatedAt: at } })
      const end = (kpiId: string, state: KpiState, at: Date) =>
        tx.kpiDefinition.updateMany({ where: { id: kpiId, state: KpiState.ACTIVE }, data: { state, endedAt: at, endedById: ownerId, version: { increment: 1 }, updatedAt: at } })
      await activate(K.otifV1, minutes(-9 * DAY))
      await activate(K.scrapRate, minutes(-9 * DAY))
      await activate(K.wipValue, minutes(-9 * DAY))
      await activate(K.orderMargin, minutes(-9 * DAY))
      await activate(K.quotesSent, minutes(-9 * DAY))
      await end(K.quotesSent, KpiState.RETIRED, minutes(-6 * DAY))
      await tx.kpiDefinition.createMany({ data: [otifV2], skipDuplicates: true })
      await end(K.otifV1, KpiState.SUPERSEDED, minutes(-7 * DAY))
      await activate(K.otifV2, minutes(-7 * DAY))
      await tx.kpiDefinition.createMany({ data: [otifV3], skipDuplicates: true })

      await tx.kpiUse.createMany({ data: uses, skipDuplicates: true })
      await tx.dashboardLayout.createMany({ data: layouts, skipDuplicates: true })
      await tx.insightsSettings.createMany({ data: settings, skipDuplicates: true })
      await tx.digestSetting.createMany({ data: digests, skipDuplicates: true })
      await tx.alertRoute.createMany({ data: routes, skipDuplicates: true })
      await tx.factDaily.createMany({ data: daily, skipDuplicates: true })
      await tx.factHourly.createMany({ data: hourly, skipDuplicates: true })
    }),
  )

  return { ...result, factDailyIds, factHourlyIds }
}
