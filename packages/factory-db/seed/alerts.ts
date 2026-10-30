import type { Prisma } from '../src/generated/prisma/client'
import { seed as seedAuth } from './auth'
import { seed as seedRoles } from './roles'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The alerts and timers seed (B-W2a-33's tables), per tenant of seed/_core.ts:
 *   - built-in rules: an order at risk of being late, a hold longer than 24 hours at plant A1 (Quality), a PO not
 *     confirmed after 2 days (by e-mail too), and the date rule "30 days before a certificate expires" (switched off);
 *   - alerts: SEED-SO-0001 at risk (OPEN, nothing done yet), a lot on hold too long (acknowledged, assigned to the member,
 *     snoozed until tomorrow) and an older PO alert resolved by the owner with a note, each with its history;
 *   - timers: a certificate's 30-days-before timer (FIRED), the next one (PENDING), and one cancelled when its date moved.
 * Records are named by type and id (made-up ids where no seed makes the record). Written in the tenant's office scope as
 * the scheduler and the API write them, in one transaction (an alert's history is checked at commit); idempotent (rows
 * found by id first; the history is append-only). First rows (00000000) are ones the generated isolation tests can copy:
 * an OPEN alert with nothing done, a FIRED timer.
 */

const AT = new Date('2026-10-30T06:00:00.000Z')
const hours = (n: number): Date => new Date(AT.getTime() + n * 3_600_000)
const REQUEST = 'seed-alerts'

export async function seed(context: SeedContext): Promise<void> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const { roleIds } = await seedRoles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const siteA1 = id('site:A1')
  const stamp = { createdAt: AT, updatedAt: AT, createdById: ownerId }

  const rule = {
    late: id('alerts:rule:ORDER_LATE_RISK'),
    hold: id('alerts:rule:HOLD_TOO_LONG'),
    po: id('alerts:rule:PO_NOT_CONFIRMED'),
    certificate: id('alerts:rule:CERTIFICATE_EXPIRING'),
  }
  const rules: Prisma.AlertRuleCreateManyInput[] = [
    { id: rule.late, ruleKind: 'ORDER_LATE_RISK', trigger: 'CONDITION', name: 'Order at risk of being late', threshold: { daysBeforePromise: 3 }, severity: 'WARNING', recipientRoleId: roleIds['planner'] as string, builtIn: true, ...stamp },
    { id: rule.hold, ruleKind: 'HOLD_TOO_LONG', trigger: 'CONDITION', name: 'Hold longer than 24 hours', threshold: { hours: 24 }, severity: 'WARNING', companyId: companyA, siteId: siteA1, recipientRoleId: roleIds['quality_inspector'] as string, builtIn: true, ...stamp },
    { id: rule.po, ruleKind: 'PO_NOT_CONFIRMED', trigger: 'CONDITION', name: 'Purchase order not confirmed', threshold: { days: 2 }, severity: 'INFO', recipientRoleId: roleIds['buyer'] as string, channels: ['IN_APP', 'EMAIL'], builtIn: true, ...stamp },
    { id: rule.certificate, ruleKind: 'CERTIFICATE_EXPIRING', trigger: 'DATE', name: 'Certificate expiring', threshold: { daysBefore: 30 }, severity: 'CRITICAL', enabled: false, builtIn: true, ...stamp },
  ]

  const order = { type: 'SalesOrder', id: id('sales:SO1'), label: 'SEED-SO-0001' }
  const lot = { type: 'Lot', id: id('alerts:record:lot'), label: 'SEED-LOT-0042' }
  const po = { type: 'PurchaseOrder', id: id('alerts:record:po'), label: 'SEED-PO-0009' }
  const alert = { open: firstId('alerts:alert:late:SO1'), held: id('alerts:alert:hold:lot'), resolved: id('alerts:alert:po') }
  const event = (key: string, data: Omit<Prisma.AlertEventCreateManyInput, 'id' | 'requestId' | 'createdAt'>): Prisma.AlertEventCreateManyInput => ({
    id: id(`alerts:event:${key}`),
    ...data,
    requestId: REQUEST,
    createdAt: data.at,
  })
  const certificate = { type: 'Certificate', id: id('alerts:record:certificate'), label: 'SEED-CERT-01' }

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.alertRule.createMany({ data: rules, skipDuplicates: true })

      if (!(await tx.alert.findUnique({ where: { id: alert.open }, select: { id: true } }))) {
        const facts = { promiseDate: '2026-11-02', daysLeft: 3, materialShort: true }
        await tx.alert.create({
          data: {
            id: alert.open, ruleId: rule.late, ruleKind: 'ORDER_LATE_RISK', severity: 'WARNING', companyId: companyA, partyId: id('party:P1'),
            recordType: order.type, recordId: order.id, recordLabel: order.label, dedupeKey: `ORDER_LATE_RISK:${order.id}`, facts, raisedAt: hours(0), createdAt: hours(0), updatedAt: hours(0),
          },
          select: { id: true },
        })
        await tx.alertEvent.createMany({ data: [event('late:raised', { alertId: alert.open, verb: 'RAISED', facts, at: hours(0) })], skipDuplicates: true })
      }

      if (!(await tx.alert.findUnique({ where: { id: alert.held }, select: { id: true } }))) {
        const facts = { hours: 26, threshold: 24 }
        await tx.alert.create({
          data: {
            id: alert.held, ruleId: rule.hold, ruleKind: 'HOLD_TOO_LONG', severity: 'WARNING', companyId: companyA, siteId: siteA1,
            recordType: lot.type, recordId: lot.id, recordLabel: lot.label, dedupeKey: `HOLD_TOO_LONG:${lot.id}`, facts, raisedAt: hours(1), createdAt: hours(1), updatedAt: hours(1),
          },
          select: { id: true },
        })
        await tx.alertEvent.createMany({
          data: [
            event('hold:raised', { alertId: alert.held, verb: 'RAISED', facts, at: hours(1) }),
            event('hold:acknowledged', { alertId: alert.held, verb: 'ACKNOWLEDGED', actorId: ownerId, at: hours(2) }),
            event('hold:assigned', { alertId: alert.held, verb: 'ASSIGNED', actorId: ownerId, assigneeId: memberId, at: hours(2) }),
            event('hold:snoozed', { alertId: alert.held, verb: 'SNOOZED', actorId: memberId, snoozedUntil: hours(26), at: hours(3) }),
          ],
          skipDuplicates: true,
        })
        await tx.alert.update({
          where: { id: alert.held },
          data: {
            state: 'ACKNOWLEDGED', acknowledgedAt: hours(2), acknowledgedById: ownerId, assignedToId: memberId, assignedById: ownerId, assignedAt: hours(2),
            snoozedUntil: hours(26), snoozedById: memberId, snoozedAt: hours(3), version: 2, updatedAt: hours(3),
          },
          select: { id: true },
        })
      }

      if (!(await tx.alert.findUnique({ where: { id: alert.resolved }, select: { id: true } }))) {
        const facts = { daysSinceSent: 3, threshold: 2 }
        const note = 'Called the supplier: confirmed by phone, the link answer follows.'
        await tx.alert.create({
          data: {
            id: alert.resolved, ruleId: rule.po, ruleKind: 'PO_NOT_CONFIRMED', severity: 'INFO', companyId: companyA, partyId: id('party:P2'),
            recordType: po.type, recordId: po.id, recordLabel: po.label, dedupeKey: `PO_NOT_CONFIRMED:${po.id}`, facts, raisedAt: hours(-30), createdAt: hours(-30), updatedAt: hours(-30),
          },
          select: { id: true },
        })
        await tx.alertEvent.createMany({
          data: [
            event('po:raised', { alertId: alert.resolved, verb: 'RAISED', facts, at: hours(-30) }),
            event('po:resolved', { alertId: alert.resolved, verb: 'RESOLVED', actorId: ownerId, note, at: hours(-28) }),
          ],
          skipDuplicates: true,
        })
        await tx.alert.update({
          where: { id: alert.resolved },
          data: { state: 'RESOLVED', resolvedAt: hours(-28), resolution: 'HANDLED', resolvedById: ownerId, resolveNote: note, version: 2, updatedAt: hours(-28) },
          select: { id: true },
        })
      }

      const timer = { fired: firstId('alerts:timer:certificate:fired'), pending: id('alerts:timer:certificate:pending'), cancelled: id('alerts:timer:certificate:cancelled') }
      const onCertificate = { timerKey: 'CERTIFICATE_EXPIRY:-30d', ruleId: rule.certificate, companyId: companyA, recordType: certificate.type, recordId: certificate.id, recordLabel: certificate.label }
      if (!(await tx.dueTimer.findUnique({ where: { id: timer.fired }, select: { id: true } }))) {
        await tx.dueTimer.create({
          data: { id: timer.fired, ...onCertificate, dueAt: new Date('2026-11-15T00:00:00.000Z'), fireAt: new Date('2026-10-16T00:00:00.000Z'), payload: { certificateNumber: 'SEED-CERT-01' }, ...stamp },
          select: { id: true },
        })
        await tx.dueTimer.update({ where: { id: timer.fired }, data: { status: 'FIRED', firedAt: new Date('2026-10-16T00:01:00.000Z'), version: 2 }, select: { id: true } })
      }
      if (!(await tx.dueTimer.findUnique({ where: { id: timer.cancelled }, select: { id: true } }))) {
        await tx.dueTimer.create({
          data: { id: timer.cancelled, ...onCertificate, timerKey: 'CERTIFICATE_EXPIRY:-7d', dueAt: new Date('2026-11-15T00:00:00.000Z'), fireAt: new Date('2026-11-08T00:00:00.000Z'), ...stamp },
          select: { id: true },
        })
        await tx.dueTimer.update({ where: { id: timer.cancelled }, data: { status: 'CANCELLED', cancelledAt: hours(1), cancelReason: 'The certificate was renewed: its expiry moved.', version: 2 }, select: { id: true } })
      }
      await tx.dueTimer.createMany({
        data: [{ id: timer.pending, ...onCertificate, timerKey: 'CERTIFICATE_EXPIRY:-7d', dueAt: new Date('2027-11-15T00:00:00.000Z'), fireAt: new Date('2027-11-08T00:00:00.000Z'), ...stamp }],
        skipDuplicates: true,
      })
    }),
  )
}
