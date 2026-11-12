import { FIELD_ID, isApprovalTaskKind, type ApprovalTaskKind } from '@nexus/factory-domain/approvals/rules'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { ApprovalKindDefinition } from './kind'
import { PURCHASE_ORDER_KIND } from './purchase-order'
// B-W2b-341: a return line credited without the goods coming back.
import { CREDIT_WITHOUT_RETURN_KIND } from './credit-without-return'

/**
 * The approval kinds the engine knows (B-W2b-282): one file per kind (./kind.ts says what it gives). A later step adds its
 * kind with its file and one line here (this list is a merge point: keep both sides). A request of a kind nobody registered
 * is listed and may be rejected or withdrawn, but never approved (it cannot be re-read: fail closed); a rule of such a kind
 * may be written but not tested. Checked at load: one file per kind, a declared permission, fact keys of the database's shape.
 *
 *   PURCHASE_ORDER   a purchase order before it is sent (B-W2b-282 the reference kind; B-W2b-305 sends it on the yes)
 *   CREDIT_WITHOUT_RETURN  a return line credited without the goods coming back (B-W2b-341; the credit written on the yes)
 */
const KINDS: readonly ApprovalKindDefinition[] = Object.freeze([
  PURCHASE_ORDER_KIND,
  // B-W2b-341
  CREDIT_WITHOUT_RETURN_KIND,
])

function registry(kinds: readonly ApprovalKindDefinition[]): Map<ApprovalTaskKind, ApprovalKindDefinition> {
  const byKind = new Map<ApprovalTaskKind, ApprovalKindDefinition>()
  for (const kind of kinds) {
    if (!isApprovalTaskKind(kind.kind)) throw new Error(`Approval kind ${String(kind.kind)} is not an ApprovalTaskKind.`)
    if (byKind.has(kind.kind)) throw new Error(`Approval kind ${kind.kind} is registered twice.`)
    for (const permission of [kind.view, kind.ask]) if (permission !== null && !FACTORY_PERMISSIONS.isDeclared(permission)) throw new Error(`Approval kind ${kind.kind}: ${permission} is not declared.`)
    const ids = new Set<string>()
    for (const field of kind.fields) {
      if (!FIELD_ID.test(field.id) || ids.has(field.id)) throw new Error(`Approval kind ${kind.kind}: fact ${field.id} is not a fact key, or is listed twice.`)
      ids.add(field.id)
    }
    byKind.set(kind.kind, kind)
  }
  return byKind
}

let current = registry(KINDS)

/** The kind's file, or undefined when no step registered it yet. */
export const kindOf = (kind: string): ApprovalKindDefinition | undefined => (isApprovalTaskKind(kind) ? current.get(kind) : undefined)

/** Every registered kind, in the enum's order. */
export const registeredKinds = (): ApprovalKindDefinition[] => [...current.values()]

/** Tests only: the kinds the engine knows (none given: the registered ones again). */
export function useApprovalKinds(kinds?: readonly ApprovalKindDefinition[]): void {
  current = registry(kinds ?? KINDS)
}
