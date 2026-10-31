import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MONITORING_CHANGES } from '@nexus/factory-domain/production/events'
import { MAX_BUNDLE_SIZE } from '@nexus/factory-domain/production/bundles/rules'
import { MONITORING_BASES, SCAN_SUBJECTS } from '@nexus/factory-domain/production/settings/monitoring'
// B-W2b-53: floor rules per site (MES-294) and the floor's full reason lists (MES-293).
import { BUNDLE_CODE_MODES, FLOOR_RULE_FIELDS, FLOOR_RULE_MODES, MAX_SCRAP_APPROVAL_LIMIT } from '@nexus/factory-domain/production/settings/floor-rules'
import { FLOOR_REASON_LISTS } from '@nexus/factory-domain/production/settings/reason-lists'

/**
 * A site's floor rules (B-W1-37; A2 SCR-074; MES-278, PLT-208): the monitoring switch with its legal basis, and the
 * standard bundle size (MES-065). The kind of
 * basis and the reference are free strings here so the domain answers in words (`legalBasisProblems`); the lengths
 * below only stop oversized bodies. Counts are counts: no answer ranks or sorts people by what they did.
 */

const subject = z.enum(SCAN_SUBJECTS)
const count = () => z.number().int().min(0)

const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string() })

const legalBasisView = output({
  kind: z.enum(MONITORING_BASES),
  /** The agreement's or authorisation's number and date, or the opinion's author and date. */
  reference: z.string(),
  recordedAt: instant(),
  recordedById: id().nullable(),
  /** The office user's name, when it can still be read. */
  recordedByName: z.string().nullable(),
})

const rulesView = output({
  scanSubject: subject,
  /** true: the site has no floor rules yet and names workers by default (the schema's default). */
  isDefault: z.boolean(),
  legalBasis: legalBasisView.nullable(),
  /** Garments per bundle when a make names no size (MES-065); 10 while the site has no floor rules. */
  standardBundleSize: z.number().int(),
  /** The version to send back with a change; null while the site has no floor rules. */
  version: z.number().int().nullable(),
  updatedAt: instant().nullable(),
})

const statusView = output({ readyForFloor: z.boolean(), notes: z.array(z.string()) })

const affectedView = output({
  /** RELEASED or IN_PROGRESS work orders of the site: the ones the floor scans now. */
  openWorkOrders: count(),
  workersActive: count(),
  workersNotAcknowledged: count(),
  devicesWithoutStation: count(),
})

/** What moving the switch to the other subject would ask and mean (the confirm dialog's words). */
const ifSwitchedView = output({ to: subject, needsStepUp: z.boolean(), needsReason: z.boolean(), needsLegalBasis: z.boolean(), words: z.array(z.string()) })

const siteRules = output({ site: siteView, rules: rulesView, status: statusView })
const siteRulesDetail = output({ site: siteView, rules: rulesView, status: statusView, affected: affectedView, ifSwitched: ifSwitchedView })
export const changeResult = output({
  site: siteView,
  rules: rulesView,
  status: statusView,
  affected: affectedView,
  ifSwitched: ifSwitchedView,
  /** false: nothing changed (no audit row, no event). */
  changed: z.boolean(),
  /** What changed, as the event production.monitoring_changed says it; null when nothing did (or the bundle size did). */
  change: z.enum(MONITORING_CHANGES).nullable(),
  /** What the change means at the site, in words. */
  words: z.array(z.string()),
})

export type SiteView = z.infer<typeof siteView>
export type RulesView = z.infer<typeof rulesView>
export type AffectedView = z.infer<typeof affectedView>
export type ChangeResult = z.infer<typeof changeResult>

export const listRulesContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ sites: z.array(siteRules) }) },
})

export const getRulesContract = defineContract({
  params: input({ siteId: id() }),
  response: { 200: siteRulesDetail },
})

const reason = z.string().max(2000).nullish()
const legalBasisBody = { kind: z.string().max(64), reference: z.string().max(1000) }

export const changeScanSubjectContract = defineContract({
  params: input({ siteId: id() }),
  body: input({
    scanSubject: subject,
    /** Required when widening (STATION → WORKER); kept in the audit row. */
    reason,
    /** Recorded with the change (naming workers needs one on record). */
    legalBasis: input(legalBasisBody).optional(),
    /** The version read; left out while the site has no floor rules. */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: changeResult },
})

export const recordLegalBasisContract = defineContract({
  params: input({ siteId: id() }),
  body: input({ ...legalBasisBody, reason, version: z.number().int().min(1).optional() }),
  response: { 200: changeResult },
})

export const changeBundleSizeContract = defineContract({
  params: input({ siteId: id() }),
  body: input({
    /** Garments per bundle when a make names no size, 1 to 500 (a made-to-measure unit is always one per bundle). */
    standardBundleSize: z.number().int().min(1).max(MAX_BUNDLE_SIZE),
    /** The version read; left out while the site has no floor rules. */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: changeResult },
})

const ackView = output({ noticeVersion: z.string(), channel: z.enum(['DEVICE', 'PAPER']), acknowledgedAt: instant() })

export const noticeAcksContract = defineContract({
  params: input({ siteId: id() }),
  response: {
    200: output({
      site: siteView,
      /** ACTIVE workers of the site; acknowledged = the notice that counts (the database's rule for naming them: the version in force). */
      workers: output({ active: count(), acknowledged: count(), notAcknowledged: count() }),
      /** Per notice version, how many ACTIVE workers acknowledged it. */
      versions: z.array(output({ noticeVersion: z.string(), workers: count() })),
      /** Names only with production.settings.manage over the site (else null); sorted by name, never a ranking. */
      people: z.array(output({ workerId: id(), displayName: z.string(), acknowledged: z.boolean(), acknowledgements: z.array(ackView) })).nullable(),
    }),
  },
})

const mode = z.enum(FLOOR_RULE_MODES)

export const floorRulesContract = defineContract({
  response: {
    200: output({
      siteId: id(),
      scanSubject: subject,
      /** The signed-in worker acknowledged the information notice (a WORKER site names nobody before that). */
      workerAcknowledged: z.boolean(),
      /** Garments per bundle when the cutter names no size (MES-065). */
      standardBundleSize: z.number().int(),
      /** B-W2b-53 (MES-294): the site's floor checks a tablet shows or acts on; the scrap limit is a count (no money). */
      checks: output({ quantityGuard: mode, skippedOperationRule: mode, scrapApprovalLimit: z.number().int().nullable(), bundleCodeMode: z.enum(BUNDLE_CODE_MODES) }),
      /** One's own last report is undone until the next scan on the tablet or this many seconds after it (the same at every site). */
      undoWindowSeconds: z.number().int(),
    }),
  },
})

// ---- B-W2b-53: floor rules per site (MES-294) -----------------------------------------------------------------------------------

const checksView = output({
  /** More pieces than the previous operation passed (MES-097). */
  quantityGuard: mode,
  /** The sequence: a required operation skipped (MES-098); FREE = relaxed, STRICT = strict. */
  skippedOperationRule: mode,
  /** Scrap above this many pieces in one scan waits for the team leader's approval (MES-128); null: none needed. */
  scrapApprovalLimit: z.number().int().nullable(),
  /** Shown here, changed by the bundles step (MES-067). */
  bundleCodeMode: z.enum(BUNDLE_CODE_MODES),
  stuckBundleHours: z.number().int(),
})

const floorRulesView = {
  site: siteView,
  checks: checksView,
  /** true: the site has no floor rules yet and runs on the defaults. */
  isDefault: z.boolean(),
  /** The quantity guard, the sequence and the scrap limit in words, in that order. */
  words: z.array(z.string()),
  /** The same at every site for now (per-site columns are a schema follow-up). */
  fixed: output({
    undoWindowSeconds: z.number().int(),
    clockOffSeconds: z.number().int(),
    clockFlagSeconds: z.number().int(),
    /** No limit yet: null. */
    offlineMaxHours: z.number().int().nullable(),
    offlineMaxActions: z.number().int().nullable(),
    /** The actions a tablet holds while offline. */
    onlineOnly: z.array(z.string()),
    words: z.array(z.string()),
  }),
  /** Idle sign-out as the tablets' settings of the site keep it (changed at PUT /auth/floor/sites/:siteId/settings). */
  idleSignOut: output({ idleMinutes: z.number().int(), shiftEnds: z.array(z.string()), badgeOnlySignIn: z.boolean(), isDefault: z.boolean(), words: z.string() }),
  /** The version to send back with a change; null while the site has no floor rules. */
  version: z.number().int().nullable(),
  updatedAt: instant().nullable(),
  /** The caller holds production.settings.manage over the site. */
  canManage: z.boolean(),
}

export const getFloorRulesContract = defineContract({
  params: input({ siteId: id() }),
  response: { 200: output(floorRulesView) },
})

export const changeFloorRulesContract = defineContract({
  params: input({ siteId: id() }),
  body: input({
    quantityGuard: mode.optional(),
    skippedOperationRule: mode.optional(),
    /** Pieces in one scan (1 to a bundle's 500); null: scrap needs no approval. */
    scrapApprovalLimit: z.number().int().min(1).max(MAX_SCRAP_APPROVAL_LIMIT).nullable().optional(),
    /** Kept in the audit row. */
    reason,
    /** The version read; left out while the site has no floor rules. */
    version: z.number().int().min(1).optional(),
  }),
  response: {
    200: output({
      ...floorRulesView,
      /** false: nothing changed (no audit row, no event). */
      changed: z.boolean(),
      changedFields: z.array(z.enum(FLOOR_RULE_FIELDS)),
      /** What the change means from now on, in words. */
      changeWords: z.array(z.string()),
    }),
  },
})

// ---- B-W2b-53: the floor's full reason lists (MES-293) -------------------------------------------------------------------------

const floorList = z.enum(FLOOR_REASON_LISTS)
const reasonListView = output({
  list: floorList,
  active: count(),
  inactive: count(),
  /** The codes of the full list this list does not have yet (active or not, a code is never added twice). */
  fullMissing: z.array(z.string()),
})

export const reasonListsContract = defineContract({
  response: {
    200: output({
      lists: z.array(reasonListView),
      /** The caller keeps the lists (reasons.manage over every company and site): "Add the full list" is offered. */
      canManage: z.boolean(),
    }),
  },
})

export const addFullReasonsContract = defineContract({
  body: input({
    /** The lists to complete; left out: every floor list. */
    lists: z.array(floorList).min(1).max(FLOOR_REASON_LISTS.length).optional(),
  }),
  response: {
    200: output({
      lists: z.array(reasonListView),
      canManage: z.boolean(),
      /** The codes added per list (none: nothing was missing, nothing written). */
      added: z.array(output({ list: floorList, codes: z.array(z.string()) })),
    }),
  },
})
