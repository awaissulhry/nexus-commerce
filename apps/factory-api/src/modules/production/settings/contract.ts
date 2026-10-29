import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MONITORING_CHANGES } from '@nexus/factory-domain/production/events'
import { MONITORING_BASES, SCAN_SUBJECTS } from '@nexus/factory-domain/production/settings/monitoring'

/**
 * A site's floor rules (B-W1-37; A2 SCR-074; MES-278, PLT-208): the monitoring switch with its legal basis. The kind of
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
  /** What changed, as the event production.monitoring_changed says it; null when nothing did. */
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

const ackView = output({ noticeVersion: z.string(), channel: z.enum(['DEVICE', 'PAPER']), acknowledgedAt: instant() })

export const noticeAcksContract = defineContract({
  params: input({ siteId: id() }),
  response: {
    200: output({
      site: siteView,
      /** ACTIVE workers of the site; acknowledged = at least one notice version (the database's rule for naming them). */
      workers: output({ active: count(), acknowledged: count(), notAcknowledged: count() }),
      /** Per notice version, how many ACTIVE workers acknowledged it. */
      versions: z.array(output({ noticeVersion: z.string(), workers: count() })),
      /** Names only with production.settings.manage over the site (else null); sorted by name, never a ranking. */
      people: z.array(output({ workerId: id(), displayName: z.string(), acknowledged: z.boolean(), acknowledgements: z.array(ackView) })).nullable(),
    }),
  },
})

export const floorRulesContract = defineContract({
  response: {
    200: output({
      siteId: id(),
      scanSubject: subject,
      /** The signed-in worker acknowledged the information notice (a WORKER site names nobody before that). */
      workerAcknowledged: z.boolean(),
    }),
  },
})
