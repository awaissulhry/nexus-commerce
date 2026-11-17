import type { Prisma } from '@nexus/factory-db'
import { SUGGESTED_KEEP_MONTHS } from '@nexus/factory-domain/privacy/retention/retention'
import { companyWhere, type Reader, type RetentionType } from './type'

/**
 * B-TH-053 (threads plan TH-3, L2-G20; GDPR art. 5(1)(e)): the prospects of closed requests (Sales › Incoming). A request from
 * someone who is not a customer yet keeps the prospect's name, company, e-mail and phone; once the request is closed (QUOTED,
 * DECLINED or LOST) for longer than the rule's period, the sweep erases them as an erasure request does (the four columns blank
 * for good, prospectErasedAt/ById set; the request, its lines and its thread stay). The lawful basis stays: it names nobody, and
 * the database freezes a closed request but its prospect (factory_inquiry_guard).
 *
 * GATE-PRIVACY: the Owner's pick is 24 months (SUGGESTED_KEEP_MONTHS, 2026-11-17), UNVERIFIED until the privacy consultant
 * confirms: a rule only REPORTS until a person switches it on (RetentionRule.applyOn, with a fresh code). Never due: an open
 * request, a request of a customer (its contact is the customer's, kept with the customer), a prospect already erased.
 */
const CLOSED = ['QUOTED', 'DECLINED', 'LOST'] as const

const dueWhere = (scope: Parameters<RetentionType['due']>[1], before: Date): Prisma.InquiryWhereInput => ({
  AND: [companyWhere(scope) as Prisma.InquiryWhereInput, { partyId: null, prospectErasedAt: null, status: { in: [...CLOSED] }, closedAt: { lt: before } }],
})

/** Who erases: the person who switched an Inquiry rule on (the database asks when and by whom; the sweep itself is nobody). */
async function switchedOnBy(db: Reader): Promise<string | null> {
  const rule = await db.retentionRule.findFirst({ where: { recordType: 'Inquiry', active: true, applyOn: true, applyOnById: { not: null } }, select: { applyOnById: true }, orderBy: [{ applyOnAt: 'desc' }, { id: 'asc' }] })
  return rule?.applyOnById ?? null
}

const inquiryProspects: RetentionType = {
  recordType: 'Inquiry',
  companyScoped: true,
  actions: ['ANONYMISE'],
  countsFrom: `the time the request was closed (an open request, a customer's request or an erased prospect is never due; suggested period ${SUGGESTED_KEEP_MONTHS.Inquiry} months, unverified)`,
  does: { ANONYMISE: "Erases the prospect of a closed request — name, company, e-mail and phone blank for good, with when and by whom; the request, its lines, its thread and the lawful basis stay." },
  holdsAll: null,
  async due(db, scope, cut, _now, take) {
    const where = dueWhere(scope, cut.instant)
    const [total, rows] = await Promise.all([db.inquiry.count({ where }), db.inquiry.findMany({ where, select: { id: true }, orderBy: [{ closedAt: 'asc' }, { id: 'asc' }], take })])
    return { total, ids: rows.map((row) => row.id) }
  },
  async apply(tx, action, ids, now) {
    if (action !== 'ANONYMISE' || ids.length === 0) return { applied: 0, held: null }
    const by = await switchedOnBy(tx)
    if (by === null) return { applied: 0, held: null }
    const { count } = await tx.inquiry.updateMany({
      where: { id: { in: [...ids] }, partyId: null, prospectErasedAt: null, status: { in: [...CLOSED] } },
      data: { prospectName: null, prospectCompany: null, prospectEmail: null, prospectPhone: null, prospectErasedAt: now, prospectErasedById: by, version: { increment: 1 }, updatedAt: now },
    })
    return { applied: count, held: null }
  },
}

export const INQUIRY_TYPES: readonly RetentionType[] = [inquiryProspects]
