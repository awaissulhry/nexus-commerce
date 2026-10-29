import type { Prisma } from '@nexus/factory-db'
import { dutiesOf, KIND_WORDS } from '@nexus/factory-domain/compliance/register/rules'
import { REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { actingPermission, KIND_RULES, type AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { complianceActs, openDuties, registerSeverity } from '@nexus/factory-domain/insights/states'
import { registerDutyWords, styleComplianceWords } from '@nexus/factory-domain/insights/words'
import { OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { ENTRY_SCOPE } from '../../compliance/register/register'
import { readEntries } from '../../compliance/register/store'
import { traceOf } from '../../compliance/register/trace'
import { styleCompliance } from '../../product/compliance/read'
import { CHECK_LIMIT, SOURCE_LIMIT, type Source } from './common'

/**
 * Compliance (B-W1-43 PPE register, B-W1-20 style compliance): open register entries whose duties the law asks now are
 * not done (the register's own `dutiesOf`, with its trace's "goods left for customers"), and released styles with open
 * sales orders or work orders that the style's compliance holds (the compliance tab's own checks: the certificate, the
 * garment label, the Declaration of Conformity and the leaflet), shown to whoever fixes at least one of its blockers.
 */

/** REGISTER_DUTY: OPEN entries with a required duty not done. */
export const registerDuty: Source = async ({ caller, viewer }) =>
  caller.withClient(async (db) => {
    const scope = scopeWhere(viewer.actor, REGISTER_VIEW, ENTRY_SCOPE) as Prisma.PpeRegisterEntryWhereInput
    const entries = await readEntries(db, { scope, status: 'OPEN', limit: CHECK_LIMIT + 1 })
    const complete = entries.length <= CHECK_LIMIT
    const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.styleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const candidates: AttentionCandidate[] = []
    for (const entry of entries.slice(0, CHECK_LIMIT)) {
      const scoped = { companyId: entry.companyId, siteId: null, partyId: entry.partyId }
      if (actingPermission(viewer, { kind: 'REGISTER_DUTY', scope: scoped }) === null) continue
      const trace = await traceOf(db, entry.companyId, entry)
      const open = openDuties(dutiesOf(entry, trace.shippedGoods))
      if (open.length === 0) continue
      const ownerId = entry.ownerId
      candidates.push({
        kind: 'REGISTER_DUTY',
        state: entry.risk,
        severity: registerSeverity(open),
        record: { type: 'PpeRegisterEntry', id: entry.id, label: entry.reference },
        scope: scoped,
        ...registerDutyWords({ reference: entry.reference, kind: KIND_WORDS[entry.kind], style: styles.get(entry.styleId) ?? 'a style', duties: open }),
        due: null,
        since: entry.reportedAt,
        why: (personId) => (ownerId !== null && ownerId === personId ? 'You follow this entry up.' : null),
      })
    }
    return { kind: 'REGISTER_DUTY', candidates, complete }
  })

/** STYLE_COMPLIANCE: released styles with open demand whose compliance check BLOCKS something. */
export const styleHold: Source = async ({ caller, viewer }) => {
  const demand = await caller.withClient(async (db) => {
    const companies = scopeWhere(viewer.actor, CERTIFICATES_VIEW, { company: 'companyId' })
    const lines = await db.salesOrderLine.findMany({
      where: { order: { AND: [companies as Prisma.SalesOrderWhereInput, { status: { in: [...OPEN_STATUSES] } }] } },
      distinct: ['styleId', 'orderId'],
      take: SOURCE_LIMIT * 5,
      select: { styleId: true, orderId: true },
    })
    const workOrders = await db.workOrder.findMany({
      where: { AND: [companies as Prisma.WorkOrderWhereInput, { status: { in: ['DRAFT', 'RELEASED', 'IN_PROGRESS'] } }] },
      take: SOURCE_LIMIT * 5,
      select: { id: true, styleId: true },
    })
    const ids = [...new Set([...lines.map((line) => line.styleId), ...workOrders.map((row) => row.styleId)])]
    const styles = ids.length > 0 ? await db.style.findMany({ where: { id: { in: ids }, revisions: { some: { status: 'RELEASED' } } }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, code: true, companyId: true, createdAt: true } }) : []
    return { lines, workOrders, styles }
  })
  const fixers = KIND_RULES.STYLE_COMPLIANCE.act
  const mine = demand.styles.filter((style) => actingPermission(viewer, { kind: 'STYLE_COMPLIANCE', scope: { companyId: style.companyId, siteId: null, partyId: null } }) !== null)
  const candidates: AttentionCandidate[] = []
  for (const style of mine.slice(0, CHECK_LIMIT)) {
    const compliance = await styleCompliance(caller, style.id, { date: viewer.today })
    if (compliance.blockers.length === 0) continue
    const checks = compliance.blockers.map((blocker) => blocker.code)
    const orders = new Set(demand.lines.filter((line) => line.styleId === style.id).map((line) => line.orderId)).size
    const workOrders = demand.workOrders.filter((row) => row.styleId === style.id).length
    const what = [orders > 0 ? `${orders} open sales order${orders === 1 ? '' : 's'}` : null, workOrders > 0 ? `${workOrders} open work order${workOrders === 1 ? '' : 's'}` : null].filter((entry): entry is string => entry !== null)
    candidates.push({
      kind: 'STYLE_COMPLIANCE',
      state: 'BLOCKED',
      severity: 'HIGH',
      record: { type: 'Style', id: style.id, label: style.code },
      scope: { companyId: style.companyId, siteId: null, partyId: null },
      ...styleComplianceWords({ style: style.code, checks, steps: [...new Set(compliance.blockers.flatMap((blocker) => blocker.blocks))], demand: what }),
      due: null,
      since: compliance.revision?.releasedAt ? new Date(compliance.revision.releasedAt) : style.createdAt,
      act: complianceActs(checks, fixers),
    })
  }
  return { kind: 'STYLE_COMPLIANCE', candidates, complete: demand.styles.length <= SOURCE_LIMIT && mine.length <= CHECK_LIMIT }
}
