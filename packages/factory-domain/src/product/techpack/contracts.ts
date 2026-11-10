import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { LEFT_OUT_KINDS, TECH_PACK_AUDIENCES, TECH_PACK_LANGUAGES, TECH_PACK_SECTIONS } from './rules'
import { SCAN_STATES } from './scan'

/**
 * The tech pack's contracts (B-W2b-230; PRD-130, PRD-131, PRD-133, PRD-134, PRD-136, PRD-138, PRD-147; design products.styles
 * `style.techpack`): what apps/factory-api's modules/product/techpack accepts and answers.
 *
 * The view is the same for every audience; what an audience never gets is ABSENT (optional keys left out by the server,
 * factory-domain product/techpack/view.ts), never blanked. The only money is a BOM line's standard unit cost and its cost at
 * the base size, marked `money.cost`: on screen, for the INTERNAL audience and the cost grain only (the API drops them for
 * everyone else); a PDF never carries them. Quantities and measures are decimal strings.
 */

const audience = z.enum(TECH_PACK_AUDIENCES)
const language = z.enum(TECH_PACK_LANGUAGES)
const section = z.enum(TECH_PACK_SECTIONS)

/** Comma-separated sections in a query string ("BOM,SIZE_SPEC"); left out: every section the caller may see. */
const sectionList = z
  .string()
  .max(400)
  .transform((value) => value.split(',').map((entry) => entry.trim().toUpperCase()).filter((entry) => entry !== ''))
  .pipe(z.array(section).max(TECH_PACK_SECTIONS.length))

/** The live tech pack (GET): which audience's copy to preview, its language, its sections, and the company of a tenant-wide style. */
export const techPackQuery = input({
  audience: audience.default('INTERNAL'),
  language: language.default('it'),
  sections: sectionList.optional(),
  companyId: id().optional(),
})
export type TechPackQuery = z.output<typeof techPackQuery>

/**
 * Make tech pack PDF (design "Generate PDF"; PRD-131, PRD-133): a new version of the revision's TECH_PACK document for one
 * audience and language (or the same version again when nothing it says changed). A partner copy may name its party (printed
 * on the cover); a private-label style's brand copy must name its brand. A tenant-wide style's copy is kept by a company:
 * `companyId` (default the screen's company).
 */
export const makePdfBody = input({
  audience,
  language: language.default('it'),
  sections: z.array(section).max(TECH_PACK_SECTIONS.length).optional(),
  partyId: id().optional(),
  companyId: id().optional(),
})
export type MakePdfBody = z.output<typeof makePdfBody>

/** The QR's code (PRD-138), typed or scanned: the 10 symbols, with or without hyphens, or the whole printed address. */
export const scanParams = input({ code: z.string().trim().min(1).max(200) })

// ---- the view -------------------------------------------------------------------------------------------------------------

const ref = output({ code: z.string(), name: z.string() })

const callout = output({ n: z.number().int(), x: z.string(), y: z.string(), text: z.string() })
const picture = output({
  id: id(),
  kind: z.enum(['SKETCH', 'PHOTO', 'PAGE']),
  /** True when it shows this revision only (else the style's, whatever the revision). */
  ofRevision: z.boolean(),
  colourway: ref.nullable(),
  caption: z.string().nullable(),
  isMain: z.boolean(),
  fileId: id(),
  callouts: z.array(callout),
})
const pattern = output({ id: id(), kind: z.enum(['PATTERN', 'MARKER', 'CAD', 'OTHER']), format: z.string().nullable(), sizes: z.array(z.string()), note: z.string().nullable(), fileId: id(), fileName: z.string() })

const bySize = output({ size: z.string(), qty: z.string().nullable(), gross: z.string().nullable() })
const alternateRef = output({ priority: z.number().int(), material: ref, allowedWhen: z.string() })
const bomLine = output({
  id: id(),
  seq: z.number().int(),
  depth: z.number().int(),
  section: z.string(),
  material: output({ code: z.string(), name: z.string(), kind: z.string(), approval: z.string().optional() }),
  placement: z.string().nullable(),
  qty: z.string(),
  uom: z.string(),
  wastagePct: z.string(),
  sizeDependent: z.boolean(),
  colourDependent: z.boolean(),
  bySize: z.array(bySize),
  colour: ref.nullable(),
  colourwayOnly: ref.nullable(),
  colours: z.array(output({ colourway: z.string(), colour: ref.nullable() })),
  option: z.string().nullable(),
  routingStep: output({ seq: z.number().int(), code: z.string() }).nullable(),
  subAssembly: output({ styleCode: z.string(), revision: z.number().int() }).nullable(),
  /** Sent by the customer (no cost, no purchase); the party only for the office. */
  customerSupplied: z.boolean(),
  customerParty: ref.nullable().optional(),
  /** Comes with the workshop's kit (the office and the subcontractor copy). */
  kit: z.boolean().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.boolean()])).nullable(),
  note: z.string().nullable().optional(),
  supplierParty: ref.nullable().optional(),
  alternateMaterials: z.array(alternateRef).optional(),
  /** The material's standard cost per base unit and the line's cost at the base size (INTERNAL, cost grain; never a PDF). */
  unitCost: money.cost(z.string().nullable()),
  lineCost: money.cost(z.string().nullable()),
})
const bomSection = output({ section: z.string(), lines: z.array(bomLine) })

const colourway = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
  colour: output({ code: z.string(), name: z.string(), system: z.string().nullable(), reference: z.string().nullable() }).nullable(),
  description: z.string().nullable(),
  /** The colour each colour-dependent line takes in it (null colour: no colour; used false: not used in this colourway). */
  colours: z.array(output({ seq: z.number().int(), material: ref, colour: ref.nullable(), used: z.boolean() })),
})

const specValue = output({ size: z.string(), nominal: z.string(), minus: z.string(), plus: z.string(), words: z.string() })
const specPoint = output({ code: z.string(), name: z.string(), unit: z.string(), howTo: z.string().nullable(), values: z.array(specValue.nullable()) })
const sizeSpec = output({
  status: z.string(),
  approved: z.boolean(),
  approvedAt: instant().nullable(),
  baseSize: z.string(),
  gradeRule: z.string().nullable(),
  sizes: z.array(z.string()),
  points: z.array(specPoint),
  missing: z.number().int(),
  words: z.string(),
})

const setting = output({ seq: z.number().int(), machineClass: z.string().nullable(), stitchType: z.string().nullable(), needle: z.string().nullable(), thread: z.string().nullable(), stitchesPerCm: z.string().nullable(), tension: z.string().nullable(), foot: z.string().nullable(), notes: z.string().nullable(), line: z.string() })
const instructionStep = output({ code: z.string(), words: z.string(), safety: z.string().nullable(), critical: z.boolean(), required: z.boolean(), media: z.number().int() })
const constructionStep = output({
  seq: z.number().int(),
  code: z.string(),
  name: z.string(),
  workCentre: z.string(),
  /** The step's own typed instructions (W1). */
  instructions: z.string().nullable(),
  /** Which cells it is for, in words; null: every cell. */
  forCells: z.string().nullable(),
  settings: z.array(setting),
  /** Its quality checkpoint, in words; null: none. */
  checkpoint: z.string().nullable(),
  /** The work instruction in force for it (B-W2b-214); null: none published. */
  instruction: output({ number: z.string(), version: z.number().int(), steps: z.array(instructionStep) }).nullable(),
  subcontracted: z.boolean(),
  standardMinutes: z.string().optional(),
  workshopParty: ref.nullable().optional(),
})
const construction = output({ steps: z.array(constructionStep), pages: z.array(picture), patterns: z.array(pattern) })

const labelTemplate = output({
  code: z.string(),
  revision: z.number().int(),
  name: z.string(),
  status: z.string(),
  kind: z.string(),
  languages: z.array(z.string()),
  maker: z.string(),
  composition: z.array(output({ part: z.string(), fibres: z.array(output({ fibre: z.string(), percent: z.string() })) })),
  care: z.array(output({ symbol: z.string(), text: z.string() })),
  animalOriginPhrase: z.boolean(),
  qrTarget: z.string(),
  size: z.string(),
})
const packagingRule = output({ key: z.string(), text: z.string(), material: ref.nullable(), quantity: z.string().nullable(), per: z.string().nullable() })
const labels = output({
  template: labelTemplate.nullable(),
  lines: z.array(bomLine),
  branding: output({ code: z.string(), name: z.string(), brand: ref, logoFileIds: z.array(id()), artworkFileIds: z.array(id()), rules: z.array(packagingRule) }).nullable(),
})

const certificate = output({
  number: z.string(),
  standard: z.string(),
  ppeClass: z.string().nullable(),
  notifiedBody: z.string(),
  notifiedBodyNumber: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
  status: z.string(),
  colourways: z.array(z.string()),
  sizes: z.array(z.string()),
  performanceLevels: z.record(z.string(), z.string()),
})
const controlTest = output({
  test: z.string(),
  name: z.string().nullable(),
  standardClause: z.string().nullable(),
  frequency: z.string(),
  dueOn: z.string(),
  result: z.string().nullable(),
  testedOn: z.string().nullable(),
  reportNumber: z.string().nullable(),
  hasReport: z.boolean(),
  resultNote: z.string().nullable(),
  testedBy: z.string().nullable().optional(),
})
const protection = output({
  classification: output({ category: z.string(), standard: z.string().nullable(), ppeClass: z.string().nullable(), words: z.string() }),
  placements: z.array(output({ seq: z.number().int(), pocket: z.string(), protector: ref, standard: z.string(), level: z.string(), sizes: z.array(z.string()), positionNote: z.string().nullable() })),
  protectors: z.array(bomLine),
  coverage: output({ required: z.boolean(), covered: z.number().int(), notCovered: z.number().int(), words: z.string() }),
  certificates: z.array(certificate),
  tests: z.array(controlTest),
})
const documentStatus = output({ kind: z.string(), language: z.string(), state: z.string(), words: z.string() })
const compliance = output({
  words: z.string(),
  classification: output({ category: z.string(), standard: z.string().nullable(), ppeClass: z.string().nullable() }),
  documentsRequired: z.boolean(),
  documents: z.array(documentStatus),
  blockers: z.array(z.string()),
  scope: z.string(),
})
const revisionLog = output({
  revision: z.number().int(),
  status: z.string(),
  releasedAt: instant().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  changeNote: z.string().nullable().optional(),
  releasedBy: z.string().nullable().optional(),
})
const techPackVersion = output({
  id: id(),
  version: z.number().int(),
  audience: audience.nullable(),
  language: z.string(),
  code: z.string(),
  createdAt: instant(),
  createdBy: z.string().nullable().optional(),
})

/** A section: whether the caller may see it (its permission; why not, in words) and whether this copy includes it. */
const sectionView = output({ section, title: z.string(), allowed: z.boolean(), included: z.boolean(), why: z.string().nullable() })

export const techPackView = output({
  audience,
  language,
  sections: z.array(sectionView),
  leftOut: z.array(output({ kind: z.enum(LEFT_OUT_KINDS), words: z.string() })),
  style: output({
    id: id(),
    code: z.string(),
    name: z.string(),
    shortDescription: z.string().nullable(),
    longDescription: z.string().nullable(),
    textLanguage: z.string(),
    season: z.string().nullable(),
    productType: z.string(),
    productTypeName: z.string().nullable(),
    brand: ref.nullable(),
    privateLabel: z.boolean(),
    sizes: z.array(output({ code: z.string(), label: z.string() })),
    baseSize: z.string().nullable(),
    lifecycle: z.string(),
    gender: z.string().nullable(),
    hsCode: z.string().nullable(),
    originCountry: z.string().nullable(),
  }),
  revision: output({
    id: id(),
    revision: z.number().int(),
    status: z.string(),
    releasedAt: instant().nullable(),
    effectiveFrom: z.string().nullable(),
    scope: z.string(),
    /** What the release takes (B-W2b-231): colourway codes and sizes; empty: every one. */
    scopeColourways: z.array(z.string()),
    scopeSizes: z.array(z.string()),
    completenessPct: z.string().nullable(),
    output: z.string(),
    changeNote: z.string().nullable().optional(),
  }),
  /** The style's revision in force (RELEASED), when another than this one. */
  inForce: output({ id: id(), revision: z.number().int() }).nullable(),
  /** Why a reader of this copy should look again (a draft revision, an obsolete one), or null. */
  banner: z.string().nullable(),
  sketches: z.array(picture).nullable(),
  bom: output({ sections: z.array(bomSection), lines: z.number().int() }).nullable(),
  colourways: z.array(colourway).nullable(),
  sizeSpec: sizeSpec.nullable(),
  construction: construction.nullable(),
  labels: labels.nullable(),
  protection: protection.nullable(),
  compliance: compliance.nullable(),
  revisionLog: z.array(revisionLog).nullable(),
  versions: z.array(techPackVersion),
})
export type TechPackView = z.output<typeof techPackView>
export type TechPackBomLine = z.output<typeof bomLine>
export type TechPackPicture = z.output<typeof picture>

/** One stored version (Make tech pack PDF's answer, the list). */
export const techPackPdfView = output({
  version: techPackVersion,
  made: z.boolean(),
  fileId: id(),
  /** What the QR on every page holds, and the code printed under it. */
  address: z.string(),
})
export type TechPackPdfView = z.output<typeof techPackPdfView>

export const versionsView = output({ versions: z.array(techPackVersion.extend({ fileId: id() })) })

/** A scanned or typed QR (PRD-138): which version the page is, and whether a newer one exists. */
export const scanView = output({
  code: z.string(),
  state: z.enum(SCAN_STATES),
  words: z.string(),
  printed: output({
    styleId: id(),
    styleCode: z.string(),
    revisionId: id(),
    revision: z.number().int(),
    revisionStatus: z.string(),
    version: z.number().int(),
    audience: audience.nullable(),
    language: z.string(),
    createdAt: instant(),
  }),
  newer: output({ revisionId: id(), revision: z.number().int(), version: z.number().int().nullable(), createdAt: instant().nullable() }).nullable(),
})
export type ScanView = z.output<typeof scanView>
