import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { changeOrderWords } from '@nexus/factory-domain/insights/words'
import { PRODUCT_CHANGES_VIEW } from '@nexus/factory-domain/product/changes/permissions'
import { capped, dayOrNull, SOURCE_LIMIT, type Source } from './common'

/**
 * Change orders that wait for the viewer's approval (B-W2b-307, follow-up AW2:01; B-W2b-226's and B-W2b-244's gap "Home ›
 * Approvals has no change-approval row"; design home.approvals "every request that needs my yes"). A SUBMITTED change order
 * whose approval asked of the viewer is not decided yet (ChangeApproval: a named office person, never the order's author —
 * the module and the database refuse the author). It is the viewer's when they still approve change orders over its company
 * (product.changes.approve; insights/attention's act), did not write it (notBy), did not name themselves its approver and
 * raised none of the requests it carries (B-W2b-F24's SELF_NAMED and OWN_REQUEST). The row opens Products › Changes &
 * versions with the decide pop-up (`?decide=order:<id>`, factory-web ATTENTION_PAGES). Oldest first; an URGENT or HIGH
 * order is urgent here too.
 */

export const changeOrderApproval: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, PRODUCT_CHANGES_VIEW, { company: 'companyId' }) as Prisma.ChangeOrderWhereInput
  return caller.withClient(async (db) => {
    const found = await db.changeOrder.findMany({
      where: {
        AND: [
          scope,
          {
            status: 'SUBMITTED',
            // B-W2b-F24: an approval the viewer named themselves (SELF_NAMED) and an order carrying a request they raised
            // (OWN_REQUEST) are refused by the module, so they are not theirs here either.
            approvals: { some: { approverId: viewer.personId, decision: null, OR: [{ createdById: null }, { createdById: { not: viewer.personId } }] } },
            requests: { none: { createdById: viewer.personId } },
          },
        ],
      },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, number: true, companyId: true, title: true, priority: true, effectiveDate: true, submittedAt: true, createdAt: true, authorId: true, style: { select: { code: true } } },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const candidates: AttentionCandidate[] = rows.map((row) => ({
      kind: 'CHANGE_ORDER',
      state: 'SUBMITTED',
      severity: row.priority === 'URGENT' || row.priority === 'HIGH' ? 'HIGH' : 'MEDIUM',
      record: { type: 'ChangeOrder', id: row.id, label: row.number },
      scope: { companyId: row.companyId, siteId: null, partyId: null },
      ...changeOrderWords({ number: row.number, style: row.style.code, title: row.title }),
      // The day the change takes effect, when the order names one (an approval after it is late).
      due: dayOrNull(row.effectiveDate),
      since: row.submittedAt ?? row.createdAt,
      notBy: [row.authorId],
    }))
    return { kind: 'CHANGE_ORDER', candidates, complete }
  })
}
