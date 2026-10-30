import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The tenancy core in the Office (SCR-008 Companies & sites, SCR-009 a site's structure; PLT-003, PLT-004, MES-292):
 * companies with their legal, e-invoicing and default data; sites with their lines, work centres and stations. Every
 * write carries the version it read; master data is archived, never deleted, and an archive waits until nothing active
 * uses the row (the refusal names what does).
 */

export const MASTER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export const SITE_KINDS = ['PLANT', 'WAREHOUSE', 'OFFICE'] as const
export const WORK_CENTRE_KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING', 'SUBCONTRACT'] as const

/** A short code: letters, digits and hyphens (used in numbers, labels and the Office address). */
export const ORG_CODE = /^[A-Z0-9][A-Z0-9-]{0,19}$/
const code = () => z.string().trim().toUpperCase().regex(ORG_CODE, 'Use 1 to 20 capital letters, digits or hyphens.')
const name = () => z.string().trim().min(1).max(200)
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()
const version = z.number().int().min(1)
const reason = z.string().trim().min(1).max(500).optional()
const timezone = z.string().trim().min(3).max(64)
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Expected an ISO 3166-1 country code such as IT.')

const addressInput = input({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullish(),
  postalCode: z.string().trim().min(1).max(20),
  city: z.string().trim().min(1).max(100),
  province: z.string().trim().max(10).nullish(),
  country,
})
const addressView = output({
  line1: z.string(),
  line2: z.string().nullable().optional(),
  postalCode: z.string(),
  city: z.string(),
  province: z.string().nullable().optional(),
  country: z.string(),
})

/** What still stops the company from issuing invoices (paths `company/<field>`; empty when it can). */
const readinessView = output({ ready: z.boolean(), issues: z.array(output({ path: z.string(), message: z.string() })) })

export const companyView = output({
  id: id(),
  code: z.string(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  vatNumber: z.string().nullable(),
  fiscalCode: z.string().nullable(),
  regimeFiscale: z.string().nullable(),
  reaOffice: z.string().nullable(),
  reaNumber: z.string().nullable(),
  /** Capitale sociale (public data, no money grain), as a decimal string. */
  shareCapital: z.string().nullable(),
  soleShareholder: z.boolean(),
  inLiquidation: z.boolean(),
  address: addressView.nullable(),
  pec: z.string().nullable(),
  sdiReceiverCode: z.string().nullable(),
  country: z.string(),
  currency: z.string(),
  timezone: z.string(),
  locale: z.string(),
  fiscalYearStartMonth: z.number().int(),
  documentFooter: z.string().nullable(),
  status: z.enum(MASTER_STATUSES),
  invoicing: readinessView,
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type CompanyView = z.infer<typeof companyView>

const counts = output({ lines: z.number().int(), stations: z.number().int(), workCentres: z.number().int(), devices: z.number().int(), printers: z.number().int() })

export const siteView = output({
  id: id(),
  companyId: id(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(SITE_KINDS),
  address: addressView.nullable(),
  timezone: z.string(),
  status: z.enum(MASTER_STATUSES),
  /** Active rows on the site (archived ones are not counted). */
  counts,
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type SiteView = z.infer<typeof siteView>

export const lineView = output({ id: id(), siteId: id(), code: z.string(), name: z.string(), status: z.enum(MASTER_STATUSES), version: z.number().int() })
export const workCentreView = output({
  id: id(),
  siteId: id(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(WORK_CENTRE_KINDS),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
})
export const stationView = output({
  id: id(),
  siteId: id(),
  lineId: id().nullable(),
  workCentreId: id(),
  code: z.string(),
  name: z.string(),
  status: z.enum(MASTER_STATUSES),
  /** Active devices enrolled at it. */
  devices: z.number().int(),
  version: z.number().int(),
})
export type LineView = z.infer<typeof lineView>
export type WorkCentreView = z.infer<typeof workCentreView>
export type StationView = z.infer<typeof stationView>

/** The tree: the companies the caller sees, each with its sites (only with sites.view). */
export const listCompaniesContract = defineContract({
  querystring: input({ includeArchived: z.coerce.boolean().default(false) }),
  response: { 200: output({ companies: z.array(companyView.extend({ sites: z.array(siteView) })) }) },
})

export const getCompanyContract = defineContract({
  params: input({ companyId: id() }),
  response: { 200: output({ company: companyView, sites: z.array(siteView) }) },
})

export const createCompanyContract = defineContract({
  body: input({ code: code(), legalName: name(), vatNumber: optionalText(32), country: country.optional() }),
  response: { 201: output({ company: companyView }) },
})

export const editCompanyContract = defineContract({
  params: input({ companyId: id() }),
  body: input({
    version,
    legalName: name().optional(),
    tradeName: optionalText(200),
    vatNumber: optionalText(32),
    fiscalCode: optionalText(32),
    regimeFiscale: z.string().trim().regex(/^RF\d{2}$/, 'Expected a RegimeFiscale code such as RF01.').nullable().optional(),
    reaOffice: optionalText(10),
    reaNumber: optionalText(20),
    shareCapital: z.string().trim().regex(/^\d{1,16}(\.\d{1,2})?$/, 'Expected an amount such as 10000.00.').nullable().optional(),
    soleShareholder: z.boolean().optional(),
    inLiquidation: z.boolean().optional(),
    address: addressInput.nullable().optional(),
    pec: z.string().trim().max(320).nullable().optional(),
    sdiReceiverCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{7}$/, 'Expected a 7-character SDI code.').nullable().optional(),
    country: country.optional(),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
    timezone: timezone.optional(),
    locale: z.enum(['it', 'en']).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    documentFooter: optionalText(1000),
    status: z.enum(MASTER_STATUSES).optional(),
    reason,
  }),
  response: { 200: output({ company: companyView }) },
})

export const getSiteContract = defineContract({
  params: input({ siteId: id() }),
  response: {
    200: output({
      site: siteView,
      company: output({ id: id(), code: z.string(), legalName: z.string() }),
      lines: z.array(lineView),
      workCentres: z.array(workCentreView),
      stations: z.array(stationView),
    }),
  },
})

export const createSiteContract = defineContract({
  body: input({ companyId: id(), code: code(), name: name(), kind: z.enum(SITE_KINDS), timezone: timezone.optional(), address: addressInput.nullable().optional() }),
  response: { 201: output({ site: siteView }) },
})

export const editSiteContract = defineContract({
  params: input({ siteId: id() }),
  body: input({ version, name: name().optional(), kind: z.enum(SITE_KINDS).optional(), timezone: timezone.optional(), address: addressInput.nullable().optional(), status: z.enum(MASTER_STATUSES).optional(), reason }),
  response: { 200: output({ site: siteView }) },
})

const siteParams = input({ siteId: id() })

export const createLineContract = defineContract({ params: siteParams, body: input({ code: code(), name: name() }), response: { 201: output({ line: lineView }) } })
export const editLineContract = defineContract({
  params: input({ lineId: id() }),
  body: input({ version, name: name().optional(), status: z.enum(MASTER_STATUSES).optional(), reason }),
  response: { 200: output({ line: lineView }) },
})

export const createWorkCentreContract = defineContract({
  params: siteParams,
  body: input({ code: code(), name: name(), kind: z.enum(WORK_CENTRE_KINDS) }),
  response: { 201: output({ workCentre: workCentreView }) },
})
export const editWorkCentreContract = defineContract({
  params: input({ workCentreId: id() }),
  body: input({ version, name: name().optional(), status: z.enum(MASTER_STATUSES).optional(), reason }),
  response: { 200: output({ workCentre: workCentreView }) },
})

export const createStationContract = defineContract({
  params: siteParams,
  body: input({ code: code(), name: name(), workCentreId: id(), lineId: id().nullable().optional() }),
  response: { 201: output({ station: stationView }) },
})
export const editStationContract = defineContract({
  params: input({ stationId: id() }),
  body: input({ version, name: name().optional(), lineId: id().nullable().optional(), workCentreId: id().optional(), status: z.enum(MASTER_STATUSES).optional(), reason }),
  response: { 200: output({ station: stationView }) },
})

export type CreateCompanyBody = z.infer<typeof createCompanyContract.body>
export type EditCompanyBody = z.infer<typeof editCompanyContract.body>
export type CreateSiteBody = z.infer<typeof createSiteContract.body>
export type EditSiteBody = z.infer<typeof editSiteContract.body>
export type CreateLineBody = z.infer<typeof createLineContract.body>
export type EditLineBody = z.infer<typeof editLineContract.body>
export type CreateWorkCentreBody = z.infer<typeof createWorkCentreContract.body>
export type EditWorkCentreBody = z.infer<typeof editWorkCentreContract.body>
export type CreateStationBody = z.infer<typeof createStationContract.body>
export type EditStationBody = z.infer<typeof editStationContract.body>

// ---- B-W2a-41 (PLT-128): the floor languages of the sites (floor-languages.ts) ----------------------------------------

export const floorLanguagesSiteView = output({
  id: id(),
  companyId: id(),
  companyCode: z.string(),
  companyName: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
  /** The languages the site's tablets offer (ISO 639, in the site's order). */
  locales: z.array(z.string()),
  version: z.number().int(),
  /** Active workers of the site per language they read; null: the reader may not see the site's workers. */
  workers: z.record(z.string(), z.number().int()).nullable(),
  /** The company's worker notice in force: its version label and its languages (text or PDF); null: none in force. */
  notice: output({ id: id(), label: z.string(), locales: z.array(z.string()) }).nullable(),
  /** The reader may change the site's floor languages (sites.manage there). */
  canManage: z.boolean(),
})
export type FloorLanguagesSiteView = z.infer<typeof floorLanguagesSiteView>

export const listFloorLanguagesContract = defineContract({
  querystring: input({ companyId: id().optional(), includeArchived: z.coerce.boolean().optional() }),
  response: { 200: output({ sites: z.array(floorLanguagesSiteView) }) },
})

export const setFloorLanguagesContract = defineContract({
  params: input({ siteId: id() }),
  body: input({
    version: z.number().int().min(1),
    /** Every language the site offers after the change, in order (an added one needs the worker notice in it). */
    locales: z.array(z.string().trim().min(1).max(8)).min(1).max(12),
    reason: z.string().trim().max(500).optional(),
  }),
  response: { 200: output({ site: floorLanguagesSiteView }) },
})
export type SetFloorLanguagesBody = z.infer<typeof setFloorLanguagesContract.body>
