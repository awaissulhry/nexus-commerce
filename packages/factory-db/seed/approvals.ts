import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { ApprovalEventAction, ApprovalMeaning, ApprovalTaskKind, ApprovalTaskStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedChanges } from './changes'
import { seed as seedProduct } from './product'
import { seed as seedReasons } from './reasons'
import { seed as seedRoles } from './roles'
import { seed as seedSales } from './sales'
import { seed as seedSupply } from './supply'

/**
 * The approvals seed (W2b-5, schema wave 35/44, B-W2b-276), per tenant of seed/_core.ts, written in the tenant's office scope
 * as the approval engine (B-W2b-282) will write it. The CLI runs the seed files in name order; this one runs the auth and roles
 * seeds (the owner, the member and the role templates), the supply seed (PO2, the draft order to the brand P1, and through it
 * the sales seed's SEED-SO-0001 and the product seed's style and leather), the changes seed (SEED-ECO-0001, and through it the
 * floor workers of A1) and the reasons seed (the APPROVAL_REJECT list's standard codes) first, all idempotent.
 *
 *   rules    every one switched OFF (Owner answers 11-10, Q3 and the gate "Approval rules": no request needs a yes until the
 *            Owner switches a rule on): company A's purchase orders over 5,000 → Finance (the first row); company A's sales
 *            orders over 20,000 or with a discount over 10 % → the Owner role, signed APPROVED with a step-up; every company's
 *            stock adjustments over 500 → the member by name, signed VERIFIED; company A's price changes (no condition: every
 *            one) → Admin, from 2026-11-01; company A's credit overrides → Finance.
 *   requests made up as the rules would have asked them: PO2 to P1, asked by the Owner, PENDING for Finance (the first row:
 *            "the Owner included" — Finance decides it, never the Owner); SEED-SO-0001, asked by the member, APPROVED by the
 *            Owner as 'Approved' with a step-up two minutes before; the leather at A1, an adjustment asked on the floor by the
 *            operator, REJECTED by the member with MISSING_INFO and words; a price change of SEED-JKT-01, STALE (the style changed
 *            after it was asked); a credit override of SEED-SO-0001, WITHDRAWN by the member.
 *   history  each request's lines (REQUESTED first; the first request's REQUESTED is the first row, then a comment; the yes
 *            with its SIGNED line; the no with its code; the system's STALE; the withdrawal), and one line of a domain approval:
 *            a comment on SEED-ECO-0001's history (changes.prisma keeps its approvals; no task).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: a rule that is
 * off, a PENDING request never changed, its REQUESTED line. Every amount, word and time is made up. Idempotent: written once,
 * skipped when its first row exists.
 */

/** Fixed instants, so the seed never depends on the clock (every one before the day the wave was built). */
const T = {
  rules: new Date('2026-11-01T08:00:00.000Z'),
  soAsked: new Date('2026-11-02T09:00:00.000Z'),
  soStepUp: new Date('2026-11-02T10:58:00.000Z'),
  soApproved: new Date('2026-11-02T11:00:00.000Z'),
  adjustmentAsked: new Date('2026-11-03T07:30:00.000Z'),
  adjustmentRejected: new Date('2026-11-03T09:00:00.000Z'),
  priceAsked: new Date('2026-11-04T08:00:00.000Z'),
  priceStale: new Date('2026-11-04T15:00:00.000Z'),
  creditAsked: new Date('2026-11-05T08:00:00.000Z'),
  creditWithdrawn: new Date('2026-11-05T08:30:00.000Z'),
  poAsked: new Date('2026-11-06T09:00:00.000Z'),
  poCommented: new Date('2026-11-06T10:00:00.000Z'),
  ecoCommented: new Date('2026-11-06T11:00:00.000Z'),
} as const
const HOUR = 3_600_000

export interface ApprovalsSeed {
  readonly ruleIds: { readonly po: string; readonly so: string; readonly adjustment: string; readonly price: string; readonly credit: string }
  readonly taskIds: { readonly pending: string; readonly approved: string; readonly rejected: string; readonly stale: string; readonly withdrawn: string }
  readonly eventIds: { readonly requested: string; readonly commented: string; readonly domain: string }
  readonly ownerId: string
  readonly memberId: string
  readonly workerId: string
  readonly companyA: string
  readonly siteA1: string
  readonly purchaseOrderId: string
  readonly salesOrderId: string
  readonly changeOrderId: string
}

export async function seed(context: SeedContext): Promise<ApprovalsSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const { roleIds } = await seedRoles(context)
  const product = await seedProduct(context)
  const sales = await seedSales(context)
  const supply = await seedSupply(context)
  const changes = await seedChanges(context)
  await seedReasons(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const siteA1 = id('site:A1')
  const workerId = id('worker:A1:operator')
  const office = { audience: 'office', tenantId, actorId: ownerId } as const
  const select = { id: true } as const
  const result: ApprovalsSeed = {
    ruleIds: {
      po: firstId('approvals:rule:PO'),
      so: id('approvals:rule:SO'),
      adjustment: id('approvals:rule:ADJUSTMENT'),
      price: id('approvals:rule:PRICE'),
      credit: id('approvals:rule:CREDIT'),
    },
    taskIds: {
      pending: firstId('approvals:task:PO2'),
      approved: id('approvals:task:SO-0001'),
      rejected: id('approvals:task:leather-A1'),
      stale: id('approvals:task:JKT-01-price'),
      withdrawn: id('approvals:task:SO-0001-credit'),
    },
    eventIds: { requested: firstId('approvals:event:PO2:requested'), commented: id('approvals:event:PO2:commented'), domain: id('approvals:event:ECO-0001:commented') },
    ownerId,
    memberId,
    workerId,
    companyA,
    siteA1,
    purchaseOrderId: supply.draftPurchaseOrderId,
    salesOrderId: sales.orderId,
    changeOrderId: changes.changeOrderId,
  }
  const { ruleIds: R, taskIds: K, eventIds: E } = result

  if (await db.withScope(office, (client) => client.approvalRule.findUnique({ where: { id: R.po }, select }))) return result

  const subjects = { po: supply.draftPurchaseOrderId, so: sales.orderId, style: product.styleId, leather: product.leatherId }

  /** The SHA-256 a request carries: of its subject as it would be written (made up here from the preview). */
  const fingerprint = (preview: unknown): string => createHash('sha256').update(`seed approvals ${namespace} ${JSON.stringify(preview)}`).digest('hex')
  const rowsOf = (combinator: 'and' | 'or', rows: [field: string, operator: string, value: string | string[] | null][]): Prisma.InputJsonValue => ({
    combinator,
    rows: rows.map(([field, operator, value], index) => ({ id: `r${index + 1}`, field, operator, value })),
  })
  const rule = (rowId: string, data: Omit<Prisma.ApprovalRuleCreateManyInput, 'id' | 'createdAt' | 'updatedAt' | 'createdById' | 'updatedById'>): Prisma.ApprovalRuleCreateManyInput => ({
    id: rowId,
    ...data,
    active: false,
    createdAt: T.rules,
    updatedAt: T.rules,
    createdById: ownerId,
    updatedById: ownerId,
  })

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // --- The rules: all switched off (Owner answer Q3) ------------------------------------------------------------------
      await tx.approvalRule.createMany({
        data: [
          rule(R.po, { companyId: companyA, kind: ApprovalTaskKind.PURCHASE_ORDER, name: 'Purchase orders over 5,000', condition: rowsOf('and', [['orderValue', 'gt', '5000']]), approverRoleId: roleIds.finance, sequence: 10, dueHours: 24 }),
          rule(R.so, {
            companyId: companyA,
            kind: ApprovalTaskKind.SALES_ORDER,
            name: 'Large orders or deep discounts',
            condition: rowsOf('or', [
              ['orderValue', 'gt', '20000'],
              ['discountPct', 'gt', '10'],
            ]),
            approverRoleId: roleIds.owner,
            signatureMeaning: ApprovalMeaning.APPROVED,
            requireStepUp: true,
            sequence: 10,
            dueHours: 48,
          }),
          rule(R.adjustment, { companyId: null, kind: ApprovalTaskKind.STOCK_ADJUSTMENT, name: 'Stock adjustments over 500', condition: rowsOf('and', [['adjustmentValue', 'gt', '500']]), approverUserId: memberId, signatureMeaning: ApprovalMeaning.VERIFIED, sequence: 10, dueHours: 8 }),
          rule(R.price, { companyId: companyA, kind: ApprovalTaskKind.PRICE_CHANGE, name: 'Every price change', condition: rowsOf('and', []), approverRoleId: roleIds.admin, sequence: 20, effectiveFrom: T.rules }),
          rule(R.credit, { companyId: companyA, kind: ApprovalTaskKind.CREDIT_OVERRIDE, name: 'Orders over the credit limit', condition: rowsOf('and', [['overLimit', 'isTrue', null]]), approverRoleId: roleIds.finance, sequence: 10, dueHours: 24 }),
        ],
      })

      // --- The requests: asked PENDING, then decided once ------------------------------------------------------------------
      const task = (rowId: string, at: Date, data: Omit<Prisma.ApprovalTaskCreateManyInput, 'id' | 'fingerprint' | 'requestedAt' | 'createdAt' | 'updatedAt' | 'createdById'>): Prisma.ApprovalTaskCreateManyInput => ({
        id: rowId,
        ...data,
        fingerprint: fingerprint(data.preview),
        requestedAt: at,
        createdAt: at,
        updatedAt: at,
        createdById: data.requestedById ?? ownerId,
      })
      await tx.approvalTask.createMany({
        data: [
          task(K.pending, T.poAsked, {
            kind: ApprovalTaskKind.PURCHASE_ORDER,
            recordType: 'PurchaseOrder',
            recordId: subjects.po,
            companyId: companyA,
            ruleIds: [R.po],
            summary: 'PO2 to the brand P1: one line, waits for a yes before it is sent (made-up)',
            preview: { changes: [{ field: 'status', from: 'DRAFT', to: 'SENT' }], facts: [{ field: 'orderValue', value: '6200.00', grain: 'cost' }] },
            requestedById: ownerId,
            approverRoleId: roleIds.finance,
            dueAt: new Date(T.poAsked.getTime() + 24 * HOUR),
          }),
          task(K.approved, T.soAsked, {
            kind: ApprovalTaskKind.SALES_ORDER,
            recordType: 'SalesOrder',
            recordId: subjects.so,
            companyId: companyA,
            ruleIds: [R.so],
            summary: 'SEED-SO-0001 for P1: a discount over the rule, confirmed with a yes (made-up)',
            preview: {
              changes: [{ field: 'status', from: 'DRAFT', to: 'CONFIRMED' }],
              facts: [
                { field: 'discountPct', value: '12', grain: 'price' },
                { field: 'marginPct', value: '18', grain: 'margin' },
              ],
            },
            requestedById: memberId,
            approverRoleId: roleIds.owner,
            signatureMeaning: ApprovalMeaning.APPROVED,
            requireStepUp: true,
            dueAt: new Date(T.soAsked.getTime() + 48 * HOUR),
          }),
          task(K.rejected, T.adjustmentAsked, {
            kind: ApprovalTaskKind.STOCK_ADJUSTMENT,
            recordType: 'Item',
            recordId: subjects.leather,
            companyId: companyA,
            siteId: siteA1,
            ruleIds: [R.adjustment],
            summary: 'Leather at A1: 32.5 ft² fewer than the books, asked on the cutting tablet (made-up)',
            preview: { changes: [{ field: 'onHand', from: '412.5000', to: '380.0000' }], facts: [{ field: 'adjustmentValue', value: '650.00', grain: 'cost' }] },
            requestedByWorkerId: workerId,
            approverUserId: memberId,
            signatureMeaning: ApprovalMeaning.VERIFIED,
            dueAt: new Date(T.adjustmentAsked.getTime() + 8 * HOUR),
          }),
          task(K.stale, T.priceAsked, {
            kind: ApprovalTaskKind.PRICE_CHANGE,
            recordType: 'Style',
            recordId: subjects.style,
            companyId: companyA,
            ruleIds: [R.price],
            summary: 'SEED-JKT-01: a new list price for the next season (made-up)',
            preview: { changes: [{ field: 'listPrice', from: '540.00', to: '565.00', grain: 'price' }] },
            requestedById: memberId,
            approverRoleId: roleIds.admin,
          }),
          task(K.withdrawn, T.creditAsked, {
            kind: ApprovalTaskKind.CREDIT_OVERRIDE,
            recordType: 'SalesOrder',
            recordId: subjects.so,
            companyId: companyA,
            ruleIds: [R.credit],
            summary: 'SEED-SO-0001 over the credit limit of P1 (made-up)',
            preview: { changes: [{ field: 'creditHold', from: true, to: false }], facts: [{ field: 'overLimitBy', value: '1800.00', grain: 'price' }] },
            requestedById: memberId,
            approverRoleId: roleIds.finance,
            dueAt: new Date(T.creditAsked.getTime() + 24 * HOUR),
          }),
        ],
      })
      const decide = (rowId: string, at: Date, data: Prisma.ApprovalTaskUpdateManyMutationInput) =>
        tx.approvalTask.update({ where: { id: rowId }, data: { ...data, version: { increment: 1 }, updatedAt: at }, select })
      await decide(K.approved, T.soApproved, {
        status: ApprovalTaskStatus.APPROVED,
        decidedAt: T.soApproved,
        decidedById: ownerId,
        comment: 'Returning customer; the discount holds for this volume (made-up).',
        stepUpAt: T.soStepUp,
      })
      await decide(K.rejected, T.adjustmentRejected, {
        status: ApprovalTaskStatus.REJECTED,
        decidedAt: T.adjustmentRejected,
        decidedById: memberId,
        rejectReasonCode: 'MISSING_INFO',
        rejectReason: 'Count the rack again: two hides were on the cutting table (made-up).',
      })
      await decide(K.stale, T.priceStale, { status: ApprovalTaskStatus.STALE, staleAt: T.priceStale })
      await decide(K.withdrawn, T.creditWithdrawn, { status: ApprovalTaskStatus.WITHDRAWN, withdrawnAt: T.creditWithdrawn, withdrawnById: memberId })

      // --- The history: each request's lines, and one line of a domain approval ---------------------------------------------
      const line = (rowId: string, at: Date, data: Omit<Prisma.ApprovalEventCreateManyInput, 'id' | 'companyId' | 'at' | 'createdAt' | 'createdById'>): Prisma.ApprovalEventCreateManyInput => ({
        id: rowId,
        companyId: companyA,
        ...data,
        at,
        createdAt: at,
        createdById: data.byId ?? ownerId,
      })
      const of = (taskId: string, recordType: string, recordId: string) => ({ taskId, recordType, recordId })
      await tx.approvalEvent.createMany({
        data: [
          line(E.requested, T.poAsked, { ...of(K.pending, 'PurchaseOrder', subjects.po), action: ApprovalEventAction.REQUESTED, byId: ownerId, words: 'Needed this week for the brand order (made-up).' }),
          line(E.commented, T.poCommented, { ...of(K.pending, 'PurchaseOrder', subjects.po), action: ApprovalEventAction.COMMENTED, byId: memberId, words: 'Asked the supplier for a better price first (made-up).' }),
          line(id('approvals:event:SO-0001:requested'), T.soAsked, { ...of(K.approved, 'SalesOrder', subjects.so), action: ApprovalEventAction.REQUESTED, byId: memberId }),
          line(id('approvals:event:SO-0001:approved'), T.soApproved, {
            ...of(K.approved, 'SalesOrder', subjects.so),
            action: ApprovalEventAction.APPROVED,
            byId: ownerId,
            meaning: ApprovalMeaning.APPROVED,
            words: 'Returning customer; the discount holds for this volume (made-up).',
          }),
          line(id('approvals:event:SO-0001:signed'), T.soApproved, { ...of(K.approved, 'SalesOrder', subjects.so), action: ApprovalEventAction.SIGNED, byId: ownerId, meaning: ApprovalMeaning.APPROVED }),
          line(id('approvals:event:leather-A1:requested'), T.adjustmentAsked, { ...of(K.rejected, 'Item', subjects.leather), action: ApprovalEventAction.REQUESTED, byWorkerId: workerId }),
          line(id('approvals:event:leather-A1:rejected'), T.adjustmentRejected, {
            ...of(K.rejected, 'Item', subjects.leather),
            action: ApprovalEventAction.REJECTED,
            byId: memberId,
            reasonCode: 'MISSING_INFO',
            words: 'Count the rack again: two hides were on the cutting table (made-up).',
          }),
          line(id('approvals:event:JKT-01-price:requested'), T.priceAsked, { ...of(K.stale, 'Style', subjects.style), action: ApprovalEventAction.REQUESTED, byId: memberId }),
          line(id('approvals:event:JKT-01-price:stale'), T.priceStale, { ...of(K.stale, 'Style', subjects.style), action: ApprovalEventAction.STALE }),
          line(id('approvals:event:SO-0001-credit:requested'), T.creditAsked, { ...of(K.withdrawn, 'SalesOrder', subjects.so), action: ApprovalEventAction.REQUESTED, byId: memberId }),
          line(id('approvals:event:SO-0001-credit:withdrawn'), T.creditWithdrawn, { ...of(K.withdrawn, 'SalesOrder', subjects.so), action: ApprovalEventAction.WITHDRAWN, byId: memberId, words: 'Paid this morning (made-up).' }),
          line(E.domain, T.ecoCommented, { taskId: null, recordType: 'ChangeOrder', recordId: changes.changeOrderId, action: ApprovalEventAction.COMMENTED, byId: memberId, words: 'Asked the cutting room whether the extra leather fits the lay (made-up).' }),
        ],
      })
    }),
  )
  return result
}
