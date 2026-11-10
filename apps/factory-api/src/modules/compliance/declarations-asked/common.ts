import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { SUPPLIER_DECLARATIONS_MANAGE, SUPPLIER_DECLARATIONS_VIEW } from '@nexus/factory-domain/compliance/declarations-asked/permissions'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import { mayWrite } from '../../product/materials/store'
import { peopleNames } from '../../../platform/alerts/store'
import type { FactoryClient } from '@nexus/factory-db'
import type { Reader } from '../substances/store'
import { REQUEST_SELECT, type RequestRow } from './store'

/**
 * What the declaration parts share (B-W2b-256): reading a request a person may see (compliance.certificates.view over its
 * company: one they may not see is "not found"), the write check (compliance.supplierDeclarations.manage over its company,
 * 403 in words), the decider's name as the supplier reads it, and the instant a partner task is due (the end of the due
 * day in Europe/Rome). The clock and the database's last word (`substancesGuarded`: a substances guard's refusal → 409 in
 * words) are the substance list's (../substances/common.ts), reused as they are.
 */

export async function readRequest(db: Reader, actor: Actor, requestId: string): Promise<RequestRow> {
  const row = isUuid(requestId) ? await db.supplierDeclarationRequest.findUnique({ where: { id: requestId }, select: REQUEST_SELECT }) : null
  if (!row || !can(actor, SUPPLIER_DECLARATIONS_VIEW, { companyId: row.companyId })) throw new NotFoundError('Declaration request not found.')
  return row
}

export function assertMayManage(actor: Actor, companyId: string, what = 'declarations of this company'): void {
  if (!mayWrite(actor, SUPPLIER_DECLARATIONS_MANAGE, companyId)) throw new ForbiddenError(`You may not ask or decide ${what}: it needs compliance.supplierDeclarations.manage.`)
}

export const mayManage = (actor: Actor, companyId: string): boolean => mayWrite(actor, SUPPLIER_DECLARATIONS_MANAGE, companyId)

/** The office person's name as the supplier reads it (who decided, who asked). */
export async function personName(db: Reader, actorId: string): Promise<string> {
  return (await peopleNames(db as FactoryClient, [actorId])).get(actorId) ?? 'Our office'
}

/** A partner task is due at the end of the request's due day (Europe/Rome). */
export const taskDueAt = (dueOn: BusinessDate): Date => new Date(businessDayRange(dueOn).end.getTime() - 60_000)
