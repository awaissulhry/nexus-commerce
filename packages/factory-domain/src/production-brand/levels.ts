/**
 * What a customer sees of its orders in production (production plan, lead pick L7; plan §3), pure. B-PR-12 (schema wave 2/5)
 * puts the list here for the schema's ProductionShareLevel (PortalSettings.productionLevel; factory-db domain-mirrors keeps
 * the two equal); B-PR-13 adds the masks of each level.
 *
 * In this order: each level adds to the one before, and the database compares them in this order (progressShared is on
 * exactly from PROGRESS until it is dropped, B-PR-40).
 *   STATUS     the plain stage and since when, the next stage, the expected date, the health and what it waits on
 *   PROGRESS   + the pieces per line and size at each stage (today's "production progress", Owner answer C1)
 *   GATES      + its gates (target and passed dates), the promise history and the published plan's stage dates
 *   QUALITY    + the quality of its own work (released and reversed pieces, results of single-customer lots, holds, photos)
 */
export const PRODUCTION_SHARE_LEVELS = ['STATUS', 'PROGRESS', 'GATES', 'QUALITY'] as const
export type ProductionShareLevel = (typeof PRODUCTION_SHARE_LEVELS)[number]
