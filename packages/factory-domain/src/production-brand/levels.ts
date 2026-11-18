/**
 * What a customer sees of its orders in production (production plan, lead pick L7; plan §3), pure. B-PR-12 (schema wave 2/5)
 * puts the list here for the schema's ProductionShareLevel (PortalSettings.productionLevel; factory-db domain-mirrors keeps
 * the two equal); B-PR-13 adds the masks of each level.
 *
 * In this order: each level adds to the one before, and the database compares them in this order (production progress is
 * shared from PROGRESS on, only with a customer or a brand: B-PR-40 dropped the old progressShared switch, the level alone
 * says it).
 *   STATUS     the plain stage and since when, the next stage, the expected date, the health and what it waits on
 *   PROGRESS   + the pieces per line and size at each stage (today's "production progress", Owner answer C1)
 *   GATES      + its gates (target and passed dates), the promise history and the published plan's stage dates
 *   QUALITY    + the quality of its own work (released and reversed pieces, results of single-customer lots, holds, photos)
 */
export const PRODUCTION_SHARE_LEVELS = ['STATUS', 'PROGRESS', 'GATES', 'QUALITY'] as const
export type ProductionShareLevel = (typeof PRODUCTION_SHARE_LEVELS)[number]

// ---- B-PR-13: the masks of each level ---------------------------------------------------------------------------------------

/** The level's place in the order (STATUS 0 … QUALITY 3). */
export const levelRank = (level: ProductionShareLevel): number => PRODUCTION_SHARE_LEVELS.indexOf(level)

/** The level shares at least what `wanted` shares. */
export const atLeast = (level: ProductionShareLevel, wanted: ProductionShareLevel): boolean => levelRank(level) >= levelRank(wanted)

/**
 * The sections a level may add to what every level shows (plan §4). Every level, STATUS included, shows the plain stage,
 * the ex-factory date and its moves with their reason codes, the health chip with its reason code, who acts next, the hold
 * mark, its requests and what waits for it. A section the level does not share is NOT DRAWN: the brand's read leaves it out
 * (null), it never sends it hidden.
 *   progress   the pieces per line and size: cut (cut and bundled), sewn, checked, packed
 *   gates      its real gates (PP sample, size set, sample, leather, trims, lab) with planned and actual dates, and the cut,
 *              sew and finish dates of the PUBLISHED plan only
 *   quality    first piece, in-line and final results and the photos of its own goods (results of single-customer work
 *              orders only: `qualityResultsShown`)
 */
export const SHARE_SECTIONS = ['progress', 'gates', 'quality'] as const
export type ShareSection = (typeof SHARE_SECTIONS)[number]

/** The first level that shares each section. */
export const SECTION_LEVEL: Readonly<Record<ShareSection, ProductionShareLevel>> = Object.freeze({ progress: 'PROGRESS', gates: 'GATES', quality: 'QUALITY' })

/** Does the level share the section? */
export const shares = (level: ProductionShareLevel, section: ShareSection): boolean => atLeast(level, SECTION_LEVEL[section])

/** Every section with whether the level shares it (the read's mask). */
export function maskOf(level: ProductionShareLevel): Readonly<Record<ShareSection, boolean>> {
  return Object.freeze({ progress: shares(level, 'progress'), gates: shares(level, 'gates'), quality: shares(level, 'quality') })
}

/** A brand read with every section the level does not share set to null (the page then does not draw it). */
export type MaskedRead<T extends object> = { readonly [K in keyof T]: K extends ShareSection ? T[K] | null : T[K] }

/**
 * Masks a brand read by the customer's level: a section the level does not share becomes null whatever the API read; the
 * other keys pass as they are. The API reads a section only when the level shares it (`shares`); this is the last step
 * before the read leaves, so nothing a level hides can leave by mistake.
 */
export function maskByLevel<T extends object>(level: ProductionShareLevel, read: T): MaskedRead<T> {
  const out: Record<string, unknown> = { ...(read as Record<string, unknown>) }
  for (const section of SHARE_SECTIONS) if (section in out && !shares(level, section)) out[section] = null
  return out as MaskedRead<T>
}

/**
 * Inspection results (pass or fail, AQL level, sample size, defects) of a work order reach a customer only at the QUALITY
 * level and only when the work order is that customer's alone (WorkOrder.partyId set to it, B-PR-01): a legacy work order
 * that mixed customers shows "Released / not yet" per own cell instead (plan §2, §4; L8).
 */
export const qualityResultsShown = (level: ProductionShareLevel, workOrderPartyId: string | null, customerPartyId: string): boolean =>
  shares(level, 'quality') && workOrderPartyId !== null && workOrderPartyId === customerPartyId
