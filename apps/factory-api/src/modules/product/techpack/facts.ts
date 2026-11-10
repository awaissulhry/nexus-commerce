import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { sectionOf, groupOrder } from '@nexus/factory-domain/product/bom-structure/rules'
import type { StyleComplianceView } from '@nexus/factory-domain/product/compliance/contracts'
import { scopeWords } from '@nexus/factory-domain/product/release/scope'
import { variantWords } from '@nexus/factory-domain/product/routing-depth/rules'
import type { TechPackPicture } from '@nexus/factory-domain/product/techpack/contracts'
import { audienceOfLayout, type TechPackLanguage } from '@nexus/factory-domain/product/techpack/rules'
import { techPackCodeOf } from '@nexus/factory-domain/product/techpack/scan'
import type { BomLineFacts, RevisionLogFacts, StepFacts, TechPackFacts, TestFacts, VersionFacts } from '@nexus/factory-domain/product/techpack/view'
import { asWords, checklistOfSteps, wordsIn } from '@nexus/factory-domain/production/instructions/rules'
import { COST_SCALE, decimalOf, decimalText, roundTo } from '@nexus/factory-domain/product/units/units'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { bomViewOf, STYLE_COLUMNS, type BomStyleRow, type RevisionRow } from '../bom/store'
import { loadStructure } from '../bom-structure/check'
import { loadSpec, specViewOf } from '../measures/store'
import { valueNames } from '../options/store'
import { readScope } from '../release/scope'
import { readDepthSteps, readMachineClasses, readPlans, readSettings, settingViewOf, variantsOfRow, checkpointViewOf } from '../routing-depth/store'
import { readSubcontracts, readWorkshops } from '../routing/read'
import { resolvedTextsOf } from '../style-texts/texts'
import { instructionInForce } from '../../production/instructions/lookup'
import { STEP } from '../../production/instructions/store'

/**
 * What the live tech pack shows, read with one client, one query after another (B-W2b-230; PRD-130, PRD-134, PRD-136,
 * PRD-147). The readers are the modules' own: the BOM and its structure (B-W1-13, B-W2b-223, B-W2b-228), the measurement spec
 * (B-W2b-224), the routing with its depth (B-W2b-225), the work instruction in force (B-W2b-214), the texts in a language
 * (B-W2b-227 resolvedTextsOf), the release scope (B-W2b-231), the pictures and pattern files (B-W2b-206), the label template
 * and the brand's packing rules, the certificates and the production control tests (W1-20's compliance view, B-W2b-216,
 * B-W2b-218). Everything the office may see is read here; factory-domain product/techpack view.ts leaves out what an audience
 * never gets.
 */

export type Reader = FactoryClient | CommandTx

/** The style columns the tech pack reads beyond the BOM's. */
const STYLE_EXTRA = {
  ...STYLE_COLUMNS,
  description: true,
  season: true,
  productType: true,
  productTypeProfileId: true,
  brandPartyId: true,
  soldUnderOurName: true,
  ppeCategory: true,
  ppeStandard: true,
  ppeClass: true,
  hsCode: true,
  originCountry: true,
  gender: true,
  lifecycle: true,
} as const satisfies Prisma.StyleSelect
export type TechPackStyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_EXTRA }>

export const readTechPackStyle = (db: Reader, styleId: string): Promise<TechPackStyleRow | null> => db.style.findUnique({ where: { id: styleId }, select: STYLE_EXTRA })

const REVISION_EXTRA = { id: true, revision: true, status: true, changeNote: true, releasedAt: true, releasedById: true, effectiveFrom: true, effectiveTo: true, completenessPct: true, outputQuantity: true, outputUom: true, labelTemplateId: true } as const satisfies Prisma.StyleRevisionSelect

/** What the caller may see beyond the BOM (its permissions), the company of a tenant-wide style, and whether costs are read. */
export interface LoadOptions {
  readonly language: TechPackLanguage
  /** product.routing.view: the construction section. */
  readonly construction: boolean
  /** compliance.certificates.view: the protection and compliance sections (W1-20's view, read by the caller). */
  readonly compliance: StyleComplianceView | null
  /** The company whose instructions, packing rules and tests count (the style's; a tenant-wide style's: the one named). */
  readonly companyId: string | null
  /** The INTERNAL audience and the cost grain: the BOM's standard costs are read. */
  readonly costs: boolean
  /** May the caller see the production control tests of a company (compliance.certificates.view over it). */
  readonly seesTestsOf: (companyId: string) => boolean
}

const text = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))
const day = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))
const nameOf = (party: { code: string; legalName: string; tradeName: string | null }) => ({ code: party.code, name: party.tradeName ?? party.legalName })
const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null)
const named = (names: Prisma.JsonValue | null | undefined, fallback: string, language: string): string => {
  const words = record(names)
  return str(words?.[language]) ?? str(words?.['it']) ?? str(words?.['en']) ?? fallback
}

async function partiesOf(db: Reader, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map<string, { code: string; name: string }>()
  const rows = await db.party.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  return new Map(rows.map((row) => [row.id, nameOf(row)]))
}

async function userNames(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

// ---- the BOM ------------------------------------------------------------------------------------------------------------------

async function bomLinesOf(db: Reader, style: BomStyleRow, revision: RevisionRow, options: LoadOptions): Promise<BomLineFacts[]> {
  const loaded = await loadStructure(db, style, revision)
  const { bom } = loaded
  const recordOf = new Map(loaded.records.map((row) => [row.id, row]))
  const lineView = new Map(bomViewOf(bom).lines.map((line) => [line.id, line] as const))
  const colourwayOf = new Map(bom.colourways.map((colourway) => [colourway.id, colourway]))
  const optionValues = await valueNames(db, loaded.records.flatMap((row) => (row.optionValueId ? [row.optionValueId] : [])))
  const parties = await partiesOf(db, loaded.records.map((row) => row.customerSuppliedByPartyId))
  const alternates = await db.bomLineAlternate.findMany({ where: { revisionId: revision.id }, select: { bomLineId: true, priority: true, itemId: true, allowedWhen: true }, orderBy: [{ bomLineId: 'asc' }, { priority: 'asc' }] })
  const altItems = alternates.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(alternates.map((row) => row.itemId))] } }, select: { id: true, code: true, name: true } })
  const altItemOf = new Map(altItems.map((item) => [item.id, item]))
  const properties = await db.item.findMany({ where: { id: { in: [...new Set(bom.lines.map((line) => line.itemId))] } }, select: { id: true, properties: true } })
  const propertiesOf = new Map(properties.map((row) => [row.id, record(row.properties)]))
  const costs = options.costs ? new Map((await db.item.findMany({ where: { id: { in: [...new Set(bom.lines.map((line) => line.itemId))] } }, select: { id: true, standardCost: true } })).map((row) => [row.id, text(row.standardCost)])) : null
  // The workshop's kit: the marked lines; none marked: every line (W2a's kit; B-W2b-228 kitPlan).
  const anyMarked = loaded.records.some((row) => row.issueToSubcontract)
  const grouped = groupOrder(bom.lines.map((line) => ({ id: line.id, seq: line.seq, parentLineId: recordOf.get(line.id)?.parentLineId ?? null })))
  return grouped.map(({ line: ref, depth }) => {
    const line = bom.lines.find((entry) => entry.id === ref.id)!
    const view = lineView.get(line.id)!
    const structure = recordOf.get(line.id)
    const material = bom.materials.get(line.itemId)!
    const extras = loaded.extras.get(line.itemId)
    const target = structure?.subAssemblyRevisionId ? loaded.targets.get(structure.subAssemblyRevisionId) : undefined
    const option = structure?.optionValueId ? optionValues.get(structure.optionValueId) : undefined
    const colourway = line.colourwayId ? colourwayOf.get(line.colourwayId) : undefined
    const base = style.baseSize ? view.bySize.find((entry) => entry.size === style.baseSize)?.base ?? null : null
    const unitCost = costs ? (costs.get(line.itemId) ?? null) : undefined
    const props = propertiesOf.get(line.itemId) ?? null
    const facts: BomLineFacts = {
      id: line.id,
      seq: line.seq,
      depth,
      section: sectionOf(structure?.section ?? null, material.kind).section,
      material: { code: material.code, name: material.name, kind: material.kind, approval: extras?.approval ?? 'PENDING' },
      placement: line.placement,
      qty: line.qty,
      uom: line.uom,
      wastagePct: line.wastagePct,
      sizeDependent: line.sizeDependent,
      colourDependent: line.colourDependent,
      bySize: view.bySize.map((entry) => ({ size: entry.size, qty: entry.qty, gross: entry.gross })),
      colour: view.itemColour ? { code: view.itemColour.code, name: view.itemColour.name } : null,
      colourwayOnly: colourway ? { code: colourway.code, name: colourway.name } : null,
      colours: view.colours.map((cell) => ({ colourway: colourwayOf.get(cell.colourwayId)?.code ?? '?', colour: cell.itemColour.code ? { code: cell.itemColour.code, name: cell.itemColour.name } : null })),
      option: option ? `${named(option.group.nameI18n as Prisma.JsonValue, option.group.name, options.language)}: ${named(option.nameI18n as Prisma.JsonValue, option.name, options.language)}` : null,
      routingStep: view.routingStep ? { seq: view.routingStep.seq, code: view.routingStep.code } : null,
      subAssembly: target ? { styleCode: target.code, revision: target.revision } : null,
      customerSupplied: structure?.customerSuppliedByPartyId != null,
      customerParty: structure?.customerSuppliedByPartyId ? (parties.get(structure.customerSuppliedByPartyId) ?? null) : null,
      kit: anyMarked ? (structure?.issueToSubcontract ?? false) : true,
      properties: props ? Object.fromEntries(Object.entries(props).filter((entry): entry is [string, string | boolean] => typeof entry[1] === 'string' || typeof entry[1] === 'boolean')) : null,
      note: line.note,
      supplierParty: view.supplier ? { code: view.supplier.code, name: view.supplier.name } : null,
      alternateMaterials: alternates
        .filter((row) => row.bomLineId === line.id)
        .map((row) => ({ priority: row.priority, material: { code: altItemOf.get(row.itemId)?.code ?? '?', name: altItemOf.get(row.itemId)?.name ?? '' }, allowedWhen: row.allowedWhen })),
      ...(unitCost === undefined ? {} : { unitCost, lineCost: unitCost !== null && base !== null ? decimalText(roundTo(decimalOf(base).times(decimalOf(unitCost)), { scale: COST_SCALE, rounding: 'HALF_UP' })) : null }),
    }
    return facts
  })
}

// ---- pictures and pattern files ---------------------------------------------------------------------------------------------

/** The style's pictures this revision shows (the style's own and this revision's), in gallery order. */
async function picturesOf(db: Reader, styleId: string, revisionId: string): Promise<TechPackPicture[]> {
  const rows = await db.styleImage.findMany({
    where: { styleId, OR: [{ revisionId: null }, { revisionId }] },
    select: { id: true, kind: true, revisionId: true, colourwayId: true, caption: true, isMain: true, fileId: true, callouts: true, seq: true, createdAt: true },
    orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  const colourways = new Map((await db.colourway.findMany({ where: { styleId }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    ofRevision: row.revisionId !== null,
    colourway: row.colourwayId && colourways.get(row.colourwayId) ? { code: colourways.get(row.colourwayId)!.code, name: colourways.get(row.colourwayId)!.name } : null,
    caption: row.caption,
    isMain: row.isMain,
    fileId: row.fileId,
    callouts: list(row.callouts).flatMap((entry) => {
      const callout = record(entry)
      return callout && typeof callout['n'] === 'number' && str(callout['x']) && str(callout['y']) && str(callout['text']) ? [{ n: callout['n'], x: String(callout['x']), y: String(callout['y']), text: String(callout['text']) }] : []
    }),
  }))
}

async function patternsOf(db: Reader, revisionId: string) {
  const rows = await db.styleRevisionFile.findMany({ where: { revisionId }, select: { id: true, kind: true, format: true, sizes: true, note: true, fileId: true, createdAt: true }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] })
  const files = rows.length === 0 ? [] : await db.storedFile.findMany({ where: { id: { in: rows.map((row) => row.fileId) } }, select: { id: true, originalName: true } })
  const nameOf_ = new Map(files.map((file) => [file.id, file.originalName]))
  return rows.map((row) => ({ id: row.id, kind: row.kind, format: row.format, sizes: [...row.sizes], note: row.note, fileId: row.fileId, fileName: nameOf_.get(row.fileId) ?? '' }))
}

// ---- construction -------------------------------------------------------------------------------------------------------------

async function constructionOf(db: Reader, styleId: string, revisionId: string, options: LoadOptions): Promise<{ steps: StepFacts[] }> {
  const steps = await readDepthSteps(db, revisionId)
  const own = await readSettings(db, 'step', steps.map((step) => step.id))
  const library = await readSettings(
    db,
    'operation',
    steps.filter((step) => !own.has(step.id)).map((step) => step.operationId),
  )
  const classes = await readMachineClasses(db, [...own.values(), ...library.values()].flat().map((row) => row.machineClassId))
  const plans = await readPlans(db, steps.map((step) => step.inspectionPlanId))
  const subcontracts = await readSubcontracts(db, revisionId)
  const workshops = await readWorkshops(db, subcontracts.values())
  const colourways = new Map((await db.colourway.findMany({ where: { styleId }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const optionNames = await valueNames(db, steps.flatMap((step) => step.appliesToOptionValueIds))
  const out: StepFacts[] = []
  for (const step of steps) {
    const settings = own.get(step.id) ?? library.get(step.operationId) ?? []
    const plan = step.inspectionPlanId ? plans.get(step.inspectionPlanId) : undefined
    const forCells = variantWords(variantsOfRow(step), (id) => colourways.get(id) ?? '?', (id) => (optionNames.get(id) ? `${optionNames.get(id)!.group.code}: ${optionNames.get(id)!.code}` : '?'))
    const subcontract = subcontracts.get(step.id)
    const workshop = subcontract ? workshops.get(subcontract.supplierId) : undefined
    let instruction: StepFacts['instruction'] = null
    const inForce = options.companyId ? await instructionInForce(db, { companyId: options.companyId, operationId: step.operationId, revisionId }) : null
    if (inForce) {
      const rows = await db.workInstructionStep.findMany({ where: { versionId: inForce.version.id }, select: STEP, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
      const media = await db.workInstructionMedia.findMany({ where: { versionId: inForce.version.id }, select: { stepId: true } })
      const marked = checklistOfSteps(rows, options.language)
      instruction = {
        number: inForce.instruction.number,
        version: inForce.version.number,
        steps: marked.map((entry) => {
          const row = rows.find((candidate) => candidate.code === entry.code)!
          return {
            code: entry.code,
            words: entry.words,
            safety: wordsIn(asWords(row.safetyNoteI18n), options.language)?.text ?? null,
            critical: entry.critical,
            required: entry.required,
            media: media.filter((item) => item.stepId === row.id).length,
          }
        }),
      }
    }
    out.push({
      seq: step.seq,
      code: step.code,
      name: step.name,
      workCentre: step.workCentreKind,
      instructions: step.instructions,
      forCells: forCells ? forCells[options.language] : null,
      settings: settings.map((row) => {
        const view = settingViewOf(row, classes)
        return {
          seq: view.seq,
          machineClass: view.machineClass ? view.machineClass.label[options.language] : null,
          stitchType: view.stitchType,
          needle: view.needle,
          thread: view.thread,
          stitchesPerCm: view.stitchesPerCm,
          tension: view.tension,
          foot: view.foot,
          notes: view.notes,
          line: view.line[options.language],
        }
      }),
      checkpoint: plan ? checkpointViewOf(plan).does[options.language] : null,
      instruction,
      subcontracted: subcontract !== undefined,
      standardMinutes: text(step.standardMinutes) ?? '0',
      workshopParty: workshop ? { code: workshop.code, name: workshop.name } : null,
    })
  }
  return { steps: out }
}

// ---- labels and packaging ---------------------------------------------------------------------------------------------------

async function labelsOf(db: Reader, style: TechPackStyleRow, labelTemplateId: string | null, options: LoadOptions): Promise<TechPackFacts['labels']> {
  const template = labelTemplateId
    ? await db.labelTemplate.findUnique({
        where: { id: labelTemplateId },
        select: { code: true, revision: true, name: true, status: true, kind: true, languages: true, makerName: true, makerAddress: true, composition: true, care: true, animalOriginPhrase: true, qrTarget: true, widthMm: true, heightMm: true },
      })
    : null
  const companyId = style.companyId ?? options.companyId
  const set =
    style.brandPartyId && companyId
      ? await db.brandingSet.findFirst({ where: { partyId: style.brandPartyId, companyId, status: 'ACTIVE' }, select: { code: true, name: true, partyId: true, logoFileIds: true, labelArtworkFileIds: true, packagingRules: true } })
      : null
  const rules = set ? list(set.packagingRules).map((entry) => record(entry)).filter((entry): entry is Record<string, unknown> => entry !== null) : []
  const ruleItems = rules.flatMap((rule) => (str(rule['itemId']) ? [String(rule['itemId'])] : []))
  const items = ruleItems.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(ruleItems)] } }, select: { id: true, code: true, name: true } })
  const itemOf = new Map(items.map((item) => [item.id, item]))
  const brand = set ? (await partiesOf(db, [set.partyId])).get(set.partyId) : undefined
  return {
    template: template
      ? {
          code: template.code,
          revision: template.revision,
          name: template.name,
          status: template.status,
          kind: template.kind,
          languages: [...template.languages],
          maker: `${template.makerName}, ${template.makerAddress}`,
          composition: list(template.composition).flatMap((entry) => {
            const part = record(entry)
            if (!part || !str(part['part'])) return []
            return [{ part: String(part['part']), fibres: list(part['fibres']).flatMap((fibre) => (record(fibre) && str(record(fibre)!['fibre']) ? [{ fibre: String(record(fibre)!['fibre']), percent: String(record(fibre)!['percent'] ?? '') }] : [])) }]
          }),
          care: list(template.care).flatMap((entry) => {
            const care = record(entry)
            return care && str(care['symbol']) ? [{ symbol: String(care['symbol']), text: named(care['text'] as Prisma.JsonValue, '', options.language) }] : []
          }),
          animalOriginPhrase: template.animalOriginPhrase,
          qrTarget: template.qrTarget,
          size: `${decimalText(template.widthMm.toString())} × ${decimalText(template.heightMm.toString())} mm`,
        }
      : null,
    branding: set
      ? {
          code: set.code,
          name: set.name,
          brand: brand ?? { code: '?', name: '' },
          logoFileIds: [...set.logoFileIds],
          artworkFileIds: [...set.labelArtworkFileIds],
          rules: rules.map((rule) => {
            const item = str(rule['itemId']) ? itemOf.get(String(rule['itemId'])) : undefined
            return { key: String(rule['key'] ?? ''), text: String(rule['text'] ?? ''), material: item ? { code: item.code, name: item.name } : null, quantity: str(rule['quantity']), per: str(rule['per']) }
          }),
        }
      : null,
  }
}

// ---- protection and compliance ---------------------------------------------------------------------------------------------

async function protectionOf(db: Reader, styleId: string, revisionId: string, compliance: StyleComplianceView, options: LoadOptions): Promise<NonNullable<TechPackFacts['protection']>> {
  const placements = await db.protectorPlacement.findMany({ where: { revisionId }, select: { seq: true, pocket: true, protectorItemId: true, standard: true, level: true, sizes: true, positionNote: true }, orderBy: { seq: 'asc' } })
  const protectors = placements.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(placements.map((row) => row.protectorItemId))] } }, select: { id: true, code: true, name: true } })
  const protectorOf = new Map(protectors.map((item) => [item.id, item]))
  const certificateIds = compliance.coverage.certificates.map((cover) => cover.certificate.id)
  const levels = certificateIds.length === 0 ? [] : await db.certificate.findMany({ where: { id: { in: certificateIds } }, select: { id: true, performanceLevels: true } })
  const levelsOf = new Map(levels.map((row) => [row.id, record(row.performanceLevels)]))
  const colourwayCode = new Map(compliance.coverage.colourways.map((colourway) => [colourway.id, colourway.code]))
  const tests = await db.productionControlTest.findMany({
    where: { styleId },
    select: { companyId: true, test: true, testName: true, standardClause: true, frequency: true, dueOn: true, result: true, testedOn: true, testedBy: true, labReportFileId: true, reportNumber: true, resultNote: true },
    orderBy: [{ dueOn: 'desc' }],
    take: 50,
  })
  const counts = compliance.coverage.counts
  const coverageWords = !compliance.coverage.required
    ? 'No certificate is needed.'
    : counts.offered === 0
      ? 'No SKU is switched on yet.'
      : counts.notCovered + counts.expired + counts.suspended === 0
        ? `Covered: every one of the ${counts.offered} switched-on colourway × size.`
        : `${counts.covered} of ${counts.offered} switched-on colourway × size covered; ${counts.notCovered + counts.expired + counts.suspended} not covered.`
  return {
    classification: { category: compliance.classification.category, standard: compliance.classification.standard, ppeClass: compliance.classification.ppeClass, words: compliance.classification.message },
    placements: placements.map((row) => ({ seq: row.seq, pocket: row.pocket, protector: { code: protectorOf.get(row.protectorItemId)?.code ?? '?', name: protectorOf.get(row.protectorItemId)?.name ?? '' }, standard: row.standard, level: row.level, sizes: [...row.sizes], positionNote: row.positionNote })),
    coverage: { required: compliance.coverage.required, covered: counts.covered, notCovered: counts.notCovered + counts.expired + counts.suspended, words: coverageWords },
    certificates: compliance.coverage.certificates.map((cover) => ({
      number: cover.certificate.number,
      standard: cover.certificate.standard,
      ppeClass: cover.certificate.ppeClass,
      notifiedBody: cover.certificate.notifiedBodyName,
      notifiedBodyNumber: cover.certificate.notifiedBodyNumber,
      validFrom: cover.certificate.validFrom,
      validTo: cover.certificate.validTo,
      status: cover.certificate.status,
      colourways: cover.colourwayIds.map((id) => colourwayCode.get(id) ?? '?'),
      sizes: [...cover.sizes],
      performanceLevels: Object.fromEntries(Object.entries(levelsOf.get(cover.certificate.id) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    })),
    tests: tests
      .filter((row) => options.seesTestsOf(row.companyId))
      .map(
        (row): TestFacts => ({
          test: row.test,
          name: row.testName,
          standardClause: row.standardClause,
          frequency: row.frequency,
          dueOn: day(row.dueOn)!,
          result: row.result,
          testedOn: day(row.testedOn),
          reportNumber: row.reportNumber,
          hasReport: row.labReportFileId !== null,
          resultNote: row.resultNote,
          testedBy: row.testedBy,
        }),
      ),
  }
}

function complianceFactsOf(compliance: StyleComplianceView, scope: string): NonNullable<TechPackFacts['compliance']> {
  return {
    words: compliance.classification.message,
    classification: { category: compliance.classification.category, standard: compliance.classification.standard, ppeClass: compliance.classification.ppeClass },
    documentsRequired: compliance.documents.required,
    documents: [...compliance.documents.declarations, ...compliance.documents.leaflets].map((status) => ({ kind: status.kind, language: status.language, state: status.state, words: status.message })),
    blockers: compliance.blockers.map((check) => check.message),
    scope,
  }
}

// ---- the whole ------------------------------------------------------------------------------------------------------------------

/** Everything the tech pack of one revision shows (the office's view; the audience is view.ts's). */
export async function loadTechPack(db: Reader, style: TechPackStyleRow, revisionRow: RevisionRow, options: LoadOptions): Promise<TechPackFacts> {
  const revision = await db.styleRevision.findUniqueOrThrow({ where: { id: revisionRow.id }, select: REVISION_EXTRA })
  const texts = (await resolvedTextsOf(db, [style.id], options.language)).get(style.id)
  const sizes = await db.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, label: true } })
  const sizeLabel = new Map(sizes.map((size) => [size.code, size.label ?? size.code]))
  const brand = style.brandPartyId ? (await partiesOf(db, [style.brandPartyId])).get(style.brandPartyId) ?? null : null
  const typeName = style.productTypeProfileId ? ((await db.productTypeProfile.findUnique({ where: { id: style.productTypeProfileId }, select: { name: true, nameI18n: true } })) ?? null) : null
  const colourwayRows = await db.colourway.findMany({ where: { styleId: style.id }, select: { id: true, code: true, name: true, status: true, colourId: true, description: true }, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })
  const scope = await readScope(db, revision.id)
  const scopeText = scopeWords(scope, { colourways: colourwayRows.map((row) => ({ id: row.id, code: row.code, status: row.status })), sizes: style.sizes })
  const revisions = await db.styleRevision.findMany({ where: { styleId: style.id }, select: { id: true, revision: true, status: true, releasedAt: true, releasedById: true, effectiveFrom: true, effectiveTo: true, changeNote: true }, orderBy: { revision: 'desc' } })
  const inForce = revisions.find((row) => row.status === 'RELEASED') ?? null
  const people = await userNames(db, [revision.releasedById, ...revisions.map((row) => row.releasedById)])

  const lines = await bomLinesOf(db, style, revisionRow, options)
  const colours = await db.colour.findMany({ where: { id: { in: colourwayRows.flatMap((row) => (row.colourId ? [row.colourId] : [])) } }, select: { id: true, code: true, name: true, nameI18n: true, system: true, reference: true } })
  const colourOf = new Map(colours.map((colour) => [colour.id, colour]))
  const colourDependent = lines.filter((line) => line.colourDependent)

  const specLoaded = await loadSpec(db, style, revisionRow)
  const spec = specLoaded.spec ? specViewOf(specLoaded) : null

  const pictures = await picturesOf(db, style.id, revision.id)
  const patterns = await patternsOf(db, revision.id)
  const construction = options.construction ? await constructionOf(db, style.id, revision.id, options) : null
  const labels = await labelsOf(db, style, revision.labelTemplateId, options)
  const protection = options.compliance ? await protectionOf(db, style.id, revision.id, options.compliance, options) : null
  const versions = await db.generatedDocument.findMany({ where: { recordType: 'StyleRevision', recordId: revision.id, kind: 'TECH_PACK' }, select: { id: true, version: true, layout: true, language: true, createdAt: true, createdById: true }, orderBy: { version: 'desc' } })
  const makers = await userNames(db, versions.map((row) => row.createdById))

  return {
    style: {
      id: style.id,
      code: style.code,
      name: texts?.name ?? style.name,
      shortDescription: texts?.shortDescription ?? null,
      longDescription: texts?.longDescription ?? null,
      textLanguage: texts?.from ?? options.language,
      season: style.season,
      productType: style.productType,
      productTypeName: typeName ? named(typeName.nameI18n, typeName.name, options.language) : null,
      brand,
      privateLabel: style.brandPartyId !== null,
      sizes: style.sizes.map((code) => ({ code, label: sizeLabel.get(code) ?? code })),
      baseSize: style.baseSize,
      lifecycle: style.lifecycle,
      gender: style.gender,
      hsCode: style.hsCode,
      originCountry: style.originCountry,
    },
    revision: {
      id: revision.id,
      revision: revision.revision,
      status: revision.status,
      releasedAt: revision.releasedAt ? toUtcIso(revision.releasedAt) : null,
      effectiveFrom: day(revision.effectiveFrom),
      scope: scopeText,
      scopeColourways: scope.colourwayIds.map((id) => colourwayRows.find((row) => row.id === id)?.code ?? '?'),
      scopeSizes: [...scope.sizes],
      completenessPct: text(revision.completenessPct),
      output: `${revision.outputQuantity} ${revision.outputUom}`,
      changeNote: revision.changeNote,
    },
    inForce: inForce && inForce.id !== revision.id ? { id: inForce.id, revision: inForce.revision } : null,
    pictures,
    patterns,
    lines,
    colourways: colourwayRows.map((row) => {
      const colour = row.colourId ? colourOf.get(row.colourId) : undefined
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        colour: colour ? { code: colour.code, name: named(colour.nameI18n, colour.name, options.language), system: colour.system, reference: colour.reference } : null,
        description: row.description,
        colours: colourDependent.map((line) => {
          const cell = line.colours.find((entry) => entry.colourway === row.code)
          return { seq: line.seq, material: { code: line.material.code, name: line.material.name }, colour: cell?.colour ?? null, used: cell !== undefined && (line.colourwayOnly === null || line.colourwayOnly.code === row.code) }
        }),
      }
    }),
    sizeSpec: spec
      ? {
          status: spec.spec!.status,
          approved: spec.spec!.status === 'APPROVED',
          approvedAt: spec.spec!.approvedAt,
          baseSize: spec.spec!.baseSize,
          gradeRule: spec.spec!.gradeRule?.code ?? null,
          sizes: spec.sizes.map((size) => size.code),
          points: spec.points.map((point) => ({
            code: point.code,
            name: named(point.nameI18n as Prisma.JsonValue, point.name, options.language),
            unit: point.uom,
            howTo: point.howTo,
            values: point.cells.map((cell) => (cell.value ? { size: cell.size, nominal: cell.value.nominal, minus: cell.value.toleranceMinus, plus: cell.value.tolerancePlus, words: cell.value.words } : null)),
          })),
          missing: spec.missing.reduce((sum, gap) => sum + gap.sizes.length, 0),
          words: spec.words,
        }
      : null,
    construction,
    labels,
    protection,
    compliance: options.compliance ? complianceFactsOf(options.compliance, scopeText) : null,
    revisions: revisions.map(
      (row): RevisionLogFacts => ({
        revision: row.revision,
        status: row.status,
        releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
        effectiveFrom: day(row.effectiveFrom),
        effectiveTo: day(row.effectiveTo),
        changeNote: row.changeNote,
        releasedBy: row.releasedById ? (people.get(row.releasedById) ?? null) : null,
      }),
    ),
    versions: versions.map(
      (row): VersionFacts => ({
        id: row.id,
        version: row.version,
        audience: audienceOfLayout(row.layout),
        language: row.language,
        code: techPackCodeOf(row.id),
        createdAt: toUtcIso(row.createdAt),
        createdBy: row.createdById ? (makers.get(row.createdById) ?? null) : null,
      }),
    ),
  }
}
