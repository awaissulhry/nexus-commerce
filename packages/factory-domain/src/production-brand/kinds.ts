import type { Issue } from '../core/errors'

/**
 * The production asks a customer may make of an order (production plan, lead picks L7, L18; review fix R-50), pure. B-PR-12
 * (schema wave 2/5) puts the lists here for the schema's OrderChangeRequestKind (beside sales/change-requests REQUEST_KINDS,
 * CHANGE and CANCEL; factory-db domain-mirrors keeps them equal) and PortalSettings.productionAskKinds; B-PR-13 adds the
 * rules of which kinds are open to whom.
 *
 *   RUSH        "Urgent – asked": open exactly while the customer's urgency switch is on (PortalSettings.productionUrgencyOn),
 *               never through the list of asks
 *   the others  open while the customer's limits list them (PortalSettings.productionAskKinds: these four only, each once;
 *               the database refuses any other kind there)
 * CHANGE and CANCEL follow the company's cut-offs and the role's ask right, never these lists.
 */
export const URGENT_ASK_KIND = 'RUSH' as const

/** The kinds a customer's limits may open (PortalSettings.productionAskKinds), in the limits card's order. */
export const PRODUCTION_ASK_KINDS = ['HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'] as const
export type ProductionAskKind = (typeof PRODUCTION_ASK_KINDS)[number]

/** Every production ask: RUSH and the four the limits open. */
export const PRODUCTION_REQUEST_KINDS = [URGENT_ASK_KIND, ...PRODUCTION_ASK_KINDS] as const
export type ProductionRequestKind = (typeof PRODUCTION_REQUEST_KINDS)[number]

// ---- B-PR-13: which asks are open to a customer ------------------------------------------------------------------------------

/** What a customer's limits say of its asks (PortalSettings.productionUrgencyOn, productionAskKinds). */
export interface AskLimits {
  readonly productionUrgencyOn: boolean
  readonly productionAskKinds: readonly string[]
}

/**
 * Is a production ask open to the customer? RUSH exactly while its urgency switch is on — never through the list, even if a
 * row named it there (the database refuses that); the others exactly while the list names them. Who of the customer may
 * ask is the role's right; this is what the factory opened to the customer.
 */
export const isAskOpen = (kind: ProductionRequestKind, limits: AskLimits): boolean =>
  kind === URGENT_ASK_KIND ? limits.productionUrgencyOn : limits.productionAskKinds.includes(kind)

/** The production asks open to the customer, in their order (a switched-off ask is not drawn). */
export const openAskKinds = (limits: AskLimits): ProductionRequestKind[] => PRODUCTION_REQUEST_KINDS.filter((kind) => isAskOpen(kind, limits))

/** What a list of asks for the limits card would break, in the database's words first (paths under `at`). */
export function askKindsProblems(kinds: readonly string[], at = 'body/productionAskKinds'): Issue[] {
  const issues: Issue[] = []
  if (new Set(kinds).size !== kinds.length) issues.push({ path: at, message: 'An ask is listed twice.' })
  kinds.forEach((kind, index) => {
    if ((PRODUCTION_ASK_KINDS as readonly string[]).includes(kind)) return
    const message =
      kind === URGENT_ASK_KIND
        ? '"Urgent – asked" follows the urgency switch, not this list.'
        : kind === 'CHANGE' || kind === 'CANCEL'
          ? "Change and cancel follow the company's cut-offs, not this list."
          : `Expected one of ${PRODUCTION_ASK_KINDS.join(', ')}.`
    issues.push({ path: `${at}/${index}`, message })
  })
  return issues
}
