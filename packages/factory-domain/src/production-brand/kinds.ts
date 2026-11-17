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
