import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { BRANDING_FILE_ROLES, BRANDING_LIMITS, PACKAGING_PER } from './rules'

/**
 * The contracts of the branding sets (B-W2b-247; PRD-045; design products.colours sec:colours.branding, pop:colours.branding).
 * No money, no person: a brand is a party (its code and name), files are named by id with their name and type.
 */

const MASTER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
const version = () => z.number().int().min(1)
const reason = () => z.string().trim().min(1).max(BRANDING_LIMITS.reason)

export const setParams = input({ setId: id() })

export const brandingSetsQuery = input({
  status: z.enum([...MASTER_STATUSES, 'ALL']).default('ALL'),
  /** Over code, name and the brand's code and name. */
  q: z.string().trim().max(100).optional(),
  partyId: id().optional(),
  companyId: id().optional(),
})
export type BrandingSetsQuery = z.output<typeof brandingSetsQuery>

/** A packaging rule as typed: a key and words; a material, a quantity and what it is per all three or none. */
export const packagingRuleBody = input({
  key: z.string().max(60),
  text: z.string().max(600),
  itemId: id().nullable().optional(),
  quantity: z.string().max(20).nullable().optional(),
  per: z.enum(PACKAGING_PER).nullable().optional(),
})
export type PackagingRuleBody = z.output<typeof packagingRuleBody>

export const createSetBody = input({
  companyId: id(),
  /** The brand: a party with the CUSTOMER or BRAND role. Never changes. */
  partyId: id(),
  code: z.string().max(80),
  name: z.string().max(240),
  note: z.string().max(2400).nullable().optional(),
  brandColourIds: z.array(id()).max(BRANDING_LIMITS.colours).optional(),
  packagingRules: z.array(packagingRuleBody).max(BRANDING_LIMITS.rules).optional(),
  /** The brand has a set in use in this company: true archives it in the same command (else a 409 names it). */
  replace: z.boolean().optional(),
  reason: reason().optional(),
})
export type CreateSetBody = z.output<typeof createSetBody>

/**
 * A set changed at its version. The file lists may be reordered or shortened (a file named here that the set does not hold
 * is refused: a file is added through POST …/files); the brand and company never change.
 */
export const updateSetBody = input({
  version: version(),
  name: z.string().max(240).optional(),
  note: z.string().max(2400).nullable().optional(),
  brandColourIds: z.array(id()).max(BRANDING_LIMITS.colours).optional(),
  packagingRules: z.array(packagingRuleBody).max(BRANDING_LIMITS.rules).optional(),
  logoFileIds: z.array(id()).max(BRANDING_LIMITS.files).optional(),
  labelArtworkFileIds: z.array(id()).max(BRANDING_LIMITS.files).optional(),
  reason: reason().optional(),
})
export type UpdateSetBody = z.output<typeof updateSetBody>

/** A file of the set (uploaded as recordType "BrandingSet", recordId the set) named a logo or label artwork. */
export const addSetFileBody = input({ version: version(), fileId: id(), role: z.enum(BRANDING_FILE_ROLES) })
export type AddSetFileBody = z.output<typeof addSetFileBody>

export const setStatusBody = input({ version: version(), reason: reason().optional() })
export type SetStatusBody = z.output<typeof setStatusBody>

// ---- answers ----------------------------------------------------------------------------------------------------------

const ref = output({ id: id(), code: z.string(), name: z.string() })

/** A file of the set: a picture is drawn from the API's own address (`url`); any other file opens as a download. */
export const brandingFileView = output({
  fileId: id(),
  role: z.enum(BRANDING_FILE_ROLES),
  name: z.string(),
  contentType: z.string(),
  kind: z.string(),
  /** A picture a screen draws (JPEG, PNG, WebP). */
  picture: z.boolean(),
  /** AVAILABLE (not waiting for a scan, not quarantined, not removed). */
  available: z.boolean(),
  /** The picture's address on the API (pictures only). */
  url: z.string().nullable(),
})
export type BrandingFileView = z.infer<typeof brandingFileView>

export const brandColourView = output({ id: id(), code: z.string(), name: z.string(), hex: z.string().nullable(), status: z.enum(MASTER_STATUSES) })
export type BrandColourView = z.infer<typeof brandColourView>

export const packagingRuleView = output({
  key: z.string(),
  text: z.string(),
  item: ref.extend({ status: z.enum(MASTER_STATUSES) }).nullable(),
  quantity: z.string().nullable(),
  per: z.enum(PACKAGING_PER).nullable(),
})
export type PackagingRuleView = z.infer<typeof packagingRuleView>

export const brandingSetRow = output({
  id: id(),
  companyId: id(),
  party: ref,
  code: z.string(),
  name: z.string(),
  logos: z.number().int(),
  artwork: z.number().int(),
  /** The first logo (the row's picture), or null. */
  logo: brandingFileView.nullable(),
  colours: z.array(brandColourView),
  rules: z.number().int(),
  /** The brand's styles of the set's company (not archived) that its labels and tech packs read it for; null: archived. */
  stylesLinked: z.number().int().nullable(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
})
export type BrandingSetRow = z.infer<typeof brandingSetRow>

export const brandingSetsView = output({ sets: z.array(brandingSetRow) })
export type BrandingSetsView = z.infer<typeof brandingSetsView>

export const brandingSetView = brandingSetRow.extend({
  files: z.array(brandingFileView),
  packagingRules: z.array(packagingRuleView),
  note: z.string().nullable(),
  /** The styles it is read for (at most 50, by code); `stylesMore` when there are more. */
  styles: z.array(ref.extend({ status: z.string() })),
  stylesMore: z.boolean(),
  /** The brand's set in use in the same company when this one is archived (restore is refused while it is). */
  activeOther: ref.nullable(),
  createdAt: instant(),
})
export type BrandingSetView = z.infer<typeof brandingSetView>
