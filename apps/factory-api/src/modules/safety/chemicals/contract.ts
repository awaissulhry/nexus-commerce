import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { CHEMICAL_LIMITS, CHEMICAL_STATUSES, CHEMICAL_USES, GHS_PICTOGRAMS, QUANTITY_UNITS, SHEET_STATUSES, SIGNAL_WORDS } from '@nexus/factory-domain/safety/chemicals/rules'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The chemical register and the safety data sheet library (B-W2b-143; QHS-277, QHS-278; design plant.chemicals: tiles,
 * register, SDS library, pop-ups Add chemical, Chemical, Print cabinet QR, new tabs SDS (PDF) and Cabinet sheet; the floor's
 * cabinet reader). No person and no money anywhere: a chemical names its supplier, the role sheets that use it and the PPE
 * items to handle it, never a worker.
 */

const version = () => z.number().int().min(1)
const codeName = output({ code: z.string(), name: z.string() })
const ref = output({ id: id(), code: z.string(), name: z.string() })

export const sheetOut = output({
  id: id(),
  versionLabel: z.string(),
  revisedOn: z.string(),
  language: z.string(),
  status: z.enum(SHEET_STATUSES),
  fileId: id(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  supersededAt: z.string().nullable(),
  supersededBy: z.string().nullable(),
  addedAt: z.string(),
  addedBy: z.string().nullable(),
})

export const chemicalOut = output({
  id: id(),
  companyId: id(),
  company: codeName,
  siteId: id(),
  site: codeName,
  name: z.string(),
  supplier: output({ partyId: id().nullable(), name: z.string().nullable() }),
  use: z.enum(CHEMICAL_USES),
  ghsPictograms: z.array(z.enum(GHS_PICTOGRAMS)),
  signalWord: z.enum(SIGNAL_WORDS).nullable(),
  hazardStatements: z.array(z.string()),
  precautionStatements: z.array(z.string()),
  storagePlace: z.string(),
  cabinetCode: z.string().nullable(),
  /** The most kept there, a decimal string, with its unit (both or neither). */
  maxQuantity: z.string().nullable(),
  maxQuantityUnit: z.enum(QUANTITY_UNITS).nullable(),
  roles: z.array(ref),
  ppe: z.array(ref),
  status: z.enum(CHEMICAL_STATUSES),
  note: z.string().nullable(),
  /** The current sheets (one per language), newest first; the superseded ones are in the record only. */
  current: z.array(sheetOut),
  superseded: z.number().int(),
  /** MISSING: no current sheet; OTHER_LANGUAGE: none in the company's language; OK. */
  sheetState: z.enum(['MISSING', 'OTHER_LANGUAGE', 'OK']),
  /** The company's language (the sheet a worker needs). */
  language: z.string(),
  version: z.number().int(),
  canManage: z.boolean(),
})

const placesOut = output({ id: id(), code: z.string(), name: z.string(), language: z.string(), sites: z.array(ref) })

const scopeQuery = { companyId: id().optional(), siteId: id().optional() }

export const listContract = defineContract({
  querystring: input({
    ...scopeQuery,
    status: z.enum(['ACTIVE', 'ARCHIVED', 'all']).optional(),
    /** The tiles as named filters: no current sheet, none in the company's language. */
    tile: z.enum(['withoutSds', 'toRequest']).optional(),
    use: z.enum(CHEMICAL_USES).optional(),
    cabinet: z.string().trim().min(1).max(CHEMICAL_LIMITS.cabinet).optional(),
    q: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(CHEMICAL_LIMITS.list).optional(),
  }),
  response: {
    200: output({ chemicals: z.array(chemicalOut), complete: z.boolean(), companies: z.array(placesOut), canManage: z.boolean(), law: output({ register: z.string(), sds: z.string() }), today: z.string() }),
  },
})

export const countsContract = defineContract({
  querystring: input(scopeQuery),
  response: { 200: output({ active: z.number().int(), withoutSds: z.number().int(), toRequest: z.number().int(), cabinets: z.number().int() }) },
})

export const recordContract = defineContract({
  params: input({ chemicalId: id() }),
  response: { 200: output({ chemical: chemicalOut, sheets: z.array(sheetOut), today: z.string() }) },
})

const statements = () => z.array(z.string().trim().min(1).max(40)).max(CHEMICAL_LIMITS.statements)
const chemicalBody = {
  name: z.string().trim().min(1).max(CHEMICAL_LIMITS.name),
  supplierPartyId: id().nullable().optional(),
  supplierName: z.string().trim().max(CHEMICAL_LIMITS.name).nullable().optional(),
  use: z.enum(CHEMICAL_USES),
  ghsPictograms: z.array(z.enum(GHS_PICTOGRAMS)).max(GHS_PICTOGRAMS.length),
  signalWord: z.enum(SIGNAL_WORDS).nullable().optional(),
  hazardStatements: statements(),
  precautionStatements: statements(),
  storagePlace: z.string().trim().min(1).max(CHEMICAL_LIMITS.place),
  cabinetCode: z.string().trim().max(CHEMICAL_LIMITS.cabinet).nullable().optional(),
  maxQuantity: z.string().trim().max(20).nullable().optional(),
  maxQuantityUnit: z.enum(QUANTITY_UNITS).nullable().optional(),
  roleSheetIds: z.array(id()).max(100),
  ppeItemIds: z.array(id()).max(100),
  note: z.string().trim().max(CHEMICAL_LIMITS.note).nullable().optional(),
}

export const createContract = defineContract({
  body: input({ companyId: id(), siteId: id(), ...chemicalBody }),
  response: { 201: output({ chemical: chemicalOut, replayed: z.boolean() }), 200: output({ chemical: chemicalOut, replayed: z.boolean() }) },
})

export const editContract = defineContract({
  params: input({ chemicalId: id() }),
  body: input({ version: version(), ...chemicalBody }),
  response: { 200: output({ chemical: chemicalOut }) },
})

export const archiveContract = defineContract({
  params: input({ chemicalId: id() }),
  body: input({ version: version(), reason: z.string().trim().min(1).max(CHEMICAL_LIMITS.reason) }),
  response: { 200: output({ chemical: chemicalOut }) },
})

export const restoreContract = defineContract({
  params: input({ chemicalId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ chemical: chemicalOut }) },
})

export const announceSheetContract = defineContract({
  params: input({ chemicalId: id() }),
  body: input({
    originalName: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    /** SHA-256 of the content, 64 lower-case hex digits. */
    sha256: z.string(),
  }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})

export const completeSheetContract = defineContract({
  params: input({ chemicalId: id(), fileId: id() }),
  response: { 200: output({ file: fileView }) },
})

export const addSheetContract = defineContract({
  params: input({ chemicalId: id() }),
  body: input({ fileId: id(), versionLabel: z.string().trim().min(1).max(CHEMICAL_LIMITS.version), revisedOn: businessDate(), language: z.string().trim().regex(/^[a-z]{2}$/) }),
  response: {
    201: output({ sheet: sheetOut, superseded: sheetOut.nullable(), chemical: chemicalOut, replayed: z.boolean() }),
    200: output({ sheet: sheetOut, superseded: sheetOut.nullable(), chemical: chemicalOut, replayed: z.boolean() }),
  },
})

export const sheetDownloadContract = defineContract({
  params: input({ chemicalId: id(), sheetId: id() }),
  response: { 200: output({ download: presignedView, fileName: z.string() }) },
})

export const libraryContract = defineContract({
  querystring: input({ ...scopeQuery, q: z.string().trim().max(80).optional() }),
  response: {
    200: output({
      sheets: z.array(
        output({
          id: id(),
          chemicalId: id(),
          chemical: z.string(),
          site: codeName,
          siteId: id(),
          versionLabel: z.string(),
          revisedOn: z.string(),
          language: z.string(),
          fileId: id(),
          fileName: z.string(),
          addedAt: z.string(),
          /** The versions it replaced, newest first (kept, never deleted). */
          superseded: z.array(output({ id: id(), versionLabel: z.string(), revisedOn: z.string(), supersededAt: z.string().nullable() })),
          canManage: z.boolean(),
        }),
      ),
      /** Active products with no current sheet at all (the library says so, never leaves them out). */
      missing: z.array(output({ chemicalId: id(), chemical: z.string(), site: codeName, canManage: z.boolean() })),
    }),
  },
})

export const cabinetsContract = defineContract({
  querystring: input(scopeQuery),
  response: {
    200: output({
      cabinets: z.array(output({ siteId: id(), site: codeName, code: z.string(), places: z.array(z.string()), products: z.number().int(), withoutSheet: z.number().int() })),
    }),
  },
})

const cabinetChemical = output({
  id: id(),
  name: z.string(),
  supplier: z.string().nullable(),
  use: z.enum(CHEMICAL_USES),
  ghsPictograms: z.array(z.enum(GHS_PICTOGRAMS)),
  signalWord: z.enum(SIGNAL_WORDS).nullable(),
  hazardStatements: z.array(z.string()),
  precautionStatements: z.array(z.string()),
  storagePlace: z.string(),
  maxQuantity: z.string().nullable(),
  maxQuantityUnit: z.enum(QUANTITY_UNITS).nullable(),
  ppe: z.array(z.string()),
  current: z.array(output({ id: id(), versionLabel: z.string(), revisedOn: z.string(), language: z.string() })),
})

export const cabinetContract = defineContract({
  params: input({ siteId: id(), code: z.string().trim().min(1).max(CHEMICAL_LIMITS.cabinet) }),
  response: { 200: output({ siteId: id(), site: codeName, company: codeName, code: z.string(), places: z.array(z.string()), chemicals: z.array(cabinetChemical), law: output({ register: z.string(), sds: z.string() }), today: z.string() }) },
})

export const choicesContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      roles: z.array(ref),
      ppe: z.array(ref),
      suppliers: z.array(output({ id: id(), code: z.string(), name: z.string() })),
      cabinets: z.array(z.string()),
      places: z.array(z.string()),
    }),
  },
})

// ---- the floor: what a tablet keeps of its site's register (the cabinet QR, offline) ----

export const floorPackContract = defineContract({
  response: {
    200: output({
      siteId: id(),
      site: codeName,
      language: z.string(),
      at: z.string(),
      chemicals: z.array(
        cabinetChemical.extend({
          cabinetCode: z.string().nullable(),
          current: z.array(output({ id: id(), versionLabel: z.string(), revisedOn: z.string(), language: z.string(), fileId: id(), sizeBytes: z.number().int(), sha256: z.string() })),
        }),
      ),
    }),
  },
})

export const floorSheetDownloadContract = defineContract({
  params: input({ sheetId: id() }),
  response: { 200: output({ download: presignedView, sha256: z.string(), sizeBytes: z.number().int() }) },
})
