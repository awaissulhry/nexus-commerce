import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LEGAL_GATE_CHANGES } from '@nexus/factory-domain/people/events'
import { FIGURE_ACCESS, FIGURE_REFUSALS, OPEN_REASONS, SIGHT_LEVELS } from '@nexus/factory-domain/people/privacy/figures'
import { MISSING_CODES } from '@nexus/factory-domain/people/privacy/gate'
import { GATE_PURPOSES, PEOPLE_DATA_PURPOSES } from '@nexus/factory-domain/people/privacy/purposes'
import { MONITORING_BASES, SCAN_SUBJECTS } from '@nexus/factory-domain/production/settings/monitoring'

/**
 * Privacy of people data (B-W2b-27; PLT-207, PLT-209, ANA-075, MES-249, MES-281, MES-282; design people.settings
 * "Privacy of people data", admin.privacy "People data rules" and "DPIA", people.efficiency "One person's figures").
 * No answer here holds a figure about a person, a list of people or a name of a worker: the gate, the settings, the
 * rules, and one person's ACCESS (who may open, never what). Office user names only for who decided.
 */

const purpose = z.enum(GATE_PURPOSES)
const reasonText = z.string().max(2000)

const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string() })
const companyView = output({ id: id(), code: z.string(), name: z.string() })
const basisView = output({ kind: z.enum(MONITORING_BASES), reference: z.string() })

const dpiaView = output({
  id: id(),
  versionNo: z.number().int(),
  status: z.string(),
  scope: z.string(),
  signedByName: z.string().nullable(),
  signedOn: businessDate().nullable(),
  reviewDueOn: businessDate().nullable(),
})

/** One gate row: in force (no switch-off) or of the past. */
const gateView = output({
  id: id(),
  purpose,
  basis: basisView,
  basisCoversLeads: z.boolean(),
  leadsSeeFigures: z.boolean(),
  /** The worker notice and the impact assessment recorded when it was switched on (the DPIA record of the purpose). */
  notice: output({ id: id(), label: z.string(), status: z.string() }),
  dpia: dpiaView,
  switchedOnAt: instant(),
  switchedOnByName: z.string().nullable(),
  switchedOffAt: instant().nullable(),
  switchedOffByName: z.string().nullable(),
  switchOffReason: z.string().nullable(),
  /** The version to send back with a change (in force only). */
  version: z.number().int(),
})

const readinessView = output({
  canSwitchOn: z.boolean(),
  missing: z.array(output({ code: z.enum(MISSING_CODES), words: z.string() })),
  notes: z.array(z.string()),
})

const purposeView = output({
  purpose,
  /** The purpose in words and the law it rests on. */
  words: z.string(),
  law: z.string(),
  open: z.boolean(),
  /** The gate in force; null: off (the safe default). */
  gate: gateView.nullable(),
  /** What switching it on needs and what is missing (while off). */
  readiness: readinessView,
  /** What changed since it was switched on (a newer notice, DPIA or site basis): worth a look, never a block. */
  notes: z.array(z.string()),
})

const sitePurposes = output({ site: siteView, purposes: z.array(purposeView) })

const settingsView = output({
  minimumGroupSize: z.number().int(),
  /** The office roles (Role.key) that see one person's figures besides the worker; empty: nobody but the worker. */
  figureRoleKeys: z.array(z.string()),
  /** null while the company has no People settings (the defaults). */
  version: z.number().int().nullable(),
})

export const overviewContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      sites: z.array(sitePurposes),
      companies: z.array(output({ company: companyView, settings: settingsView })),
    }),
  },
})

const siteDetail = output({
  site: siteView,
  /** Who the site's floor records name, and its legal basis in Production › Settings (PERFORMANCE takes it). */
  scanSubject: z.enum(SCAN_SUBJECTS),
  siteBasis: basisView.nullable(),
  /** The company's worker notice in force and its stored impact assessment (Admin › Privacy & notices). */
  workerNotice: output({ id: id(), label: z.string() }).nullable(),
  dpia: dpiaView.nullable(),
  /** The page that keeps the notice and the DPIA (the navigation tree's id). */
  privacyPage: z.literal('admin.privacy'),
  purposes: z.array(purposeView),
  /** Every decision at this site, newest first (switched on, and off with why). */
  history: z.array(gateView),
})

export const siteContract = defineContract({ params: input({ siteId: id() }), response: { 200: siteDetail } })

const changeResult = siteDetail.extend({
  change: z.enum(LEGAL_GATE_CHANGES).nullable(),
  /** false: nothing changed (no audit row, no event). */
  changed: z.boolean(),
  words: z.array(z.string()),
})

export type SiteDetail = z.infer<typeof siteDetail>
export type ChangeResult = z.infer<typeof changeResult>

const gateParams = input({ siteId: id(), purpose })

export const switchOnContract = defineContract({
  params: gateParams,
  body: input({
    /** ATTENDANCE only: the basis kept (usually counsel's opinion) and its reference. PERFORMANCE takes the site's. */
    basis: input({ kind: z.string().max(64), reference: z.string().max(1000) }).optional(),
    /** PERFORMANCE on an agreement or an authorisation that names team leads. */
    basisCoversLeads: z.boolean().optional(),
    /** Leads see one person's figures at this site (only when the basis covers them). */
    leadsSeeFigures: z.boolean().optional(),
    reason: reasonText,
  }),
  response: { 200: changeResult },
})

export const switchOffContract = defineContract({
  params: gateParams,
  body: input({ version: z.number().int().min(1), reason: reasonText }),
  response: { 200: changeResult },
})

export const leadsContract = defineContract({
  params: gateParams,
  body: input({ version: z.number().int().min(1), leadsSeeFigures: z.boolean(), reason: reasonText.nullish() }),
  response: { 200: changeResult },
})

const roleChoice = output({ key: z.string(), name: z.string(), system: z.boolean() })

const companySettings = output({
  company: companyView,
  settings: settingsView,
  /** The roles named, with their names (a key whose role is gone stays listed with name null). */
  named: z.array(output({ key: z.string(), name: z.string().nullable() })),
  /** The office roles of the tenant that may be named. */
  roles: z.array(roleChoice),
})

export const companySettingsContract = defineContract({ params: input({ companyId: id() }), response: { 200: companySettings } })

export const changeSettingsContract = defineContract({
  params: input({ companyId: id() }),
  body: input({
    /** 3 or more: a group with fewer people never shows its figures. Lowering it asks for a fresh code. */
    minimumGroupSize: z.number().int(),
    /** Office role keys; naming a role that was not named asks for a fresh code, removing one never does. */
    figureRoleKeys: z.array(z.string().max(64)).max(20),
    reason: reasonText.nullish(),
    /** The version read; left out while the company has no People settings. */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: companySettings.extend({ changed: z.boolean(), words: z.array(z.string()) }) },
})

export const rulesContract = defineContract({
  response: {
    200: output({
      purposes: z.array(output({ purpose: z.enum(PEOPLE_DATA_PURPOSES), words: z.string(), law: z.string(), gate: purpose.nullable(), note: z.string().nullable(), floor: z.boolean() })),
      gateLaw: output({ ATTENDANCE: z.string(), PERFORMANCE: z.string() }),
      facts: z.array(output({ key: z.string(), words: z.string(), law: z.string() })),
      /** The automated systems that decide about workers (none) and whether the information pack is due. */
      automatedDecisions: z.array(output({ system: z.string(), decides: z.string() })),
      informationPackDue: z.boolean(),
      /** Sites in scope with each purpose's state: the switches of the rules panel. */
      sites: z.array(output({ site: siteView, open: z.array(purpose) })),
    }),
  },
})

export const sightContract = defineContract({
  querystring: input({ siteId: id(), purpose }),
  response: {
    200: output({
      siteId: id(),
      purpose,
      open: z.boolean(),
      level: z.enum(SIGHT_LEVELS),
      minimumGroupSize: z.number().int(),
      leadsSeeFigures: z.boolean(),
      words: z.array(z.string()),
    }),
  },
})

const accessView = output({
  employeeId: id(),
  siteId: id(),
  purpose,
  allowed: z.boolean(),
  /** How the viewer may open them (SELF, FIGURE_ROLE, LEAD); null when refused. */
  as: z.enum(FIGURE_ACCESS).nullable(),
  /** Why not (GATE_CLOSED, NOT_ALLOWED); null when allowed. */
  refusal: z.enum(FIGURE_REFUSALS).nullable(),
  needsReason: z.boolean(),
  reasons: z.array(output({ code: z.enum(OPEN_REASONS), words: z.string() })),
  words: z.array(z.string()),
})

export const accessContract = defineContract({
  params: input({ employeeId: id() }),
  querystring: input({ purpose }),
  response: { 200: accessView },
})

export const openContract = defineContract({
  params: input({ employeeId: id() }),
  body: input({ purpose, reason: z.enum(OPEN_REASONS).optional(), note: z.string().max(2000).nullish() }),
  response: {
    200: output({
      employeeId: id(),
      siteId: id(),
      purpose,
      as: z.enum(FIGURE_ACCESS),
      reason: z.enum(OPEN_REASONS).nullable(),
      openedAt: instant(),
      /** The opening is recorded (audit action people.openPersonFigures), visible to HR and the data protection officer. */
      recorded: z.literal(true),
      words: z.array(z.string()),
    }),
  },
})
