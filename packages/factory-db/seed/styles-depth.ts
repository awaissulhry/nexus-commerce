import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  ColourSystem,
  ConsumptionTolerance,
  ItemKind,
  ItemSourcing,
  ItemTracking,
  MasterStatus,
  MaterialApproval,
  PatternFileFormat,
  PatternFileKind,
  PpeCategory,
  ProductEditRule,
  ProductType,
  StyleImageKind,
  StyleLifecycle,
  StyleRevisionStatus,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCompliance } from './compliance'
import { seed as seedFiles } from './files'
import { seed as seedShipping } from './shipping'

/**
 * The styles and libraries seed (W2b-4, schema wave 26/33, B-W2b-206), per tenant of seed/_core.ts, written in the tenant's
 * office scope as the app does. The CLI runs the seed files in name order and this one sorts after shipping.ts, which it
 * runs first anyway (idempotent; it runs quality → production → product and parties), with the compliance seed (the label
 * template SEED-LBL-JKT-01) and the files seed (the tenant's file store). Every name, code, colour reference and GTIN is made up: the GTINs use the GS1 prefix 200, which GS1 keeps
 * for in-store numbers and never gives to a company. Rows only: no file object is in any store.
 *
 *   lifecycle   SEED-JKT-01 (the brand P1's draft) DEVELOPMENT; SEED-JKT-02 (released, WO-0001) IN_PRODUCTION; both moved by
 *               the seed's actor at a fixed time.
 *   types       a tenant-wide "Jacket" type (required gender, HS code and origin; the EU jacket scale, the JACKET measurement
 *               template, SEED-LBL-JKT-01, Category II, EN 17092-4:2020 class A), a "Touring jacket" under it (required PPE
 *               class, class AA), company A's archived "Vest" type. SEED-JKT-01 is a Jacket, SEED-JKT-02 a Touring jacket
 *               (both styles are tenant-wide, so their types are too).
 *   texts       SEED-JKT-01 in Italian, English and German; SEED-JKT-02 in Italian and English.
 *   pictures    SEED-JKT-01: a front flat (the style's), the black colourway's photo (main), a tech page of its draft revision
 *               with two callouts; SEED-JKT-02: a photo (main). Revision files: SEED-JKT-01 revision 1's pattern (DXF-AAMA,
 *               every size) and SEED-JKT-02's released revision's marker for 50 and 52 (Lectra; a marker may come after the
 *               release).
 *   GTINs       company A's block 2009999, references 100 to 999 (three given) and an archived block 2009998 used up; the
 *               three GTINs on SEED-JKT-02 SKUs, black 50 first (shipped in SH-0001: its GTIN is now fixed).
 *   colours     SEED-BLK RAL 9005, SEED-RED Pantone 18-1662 TCX, SEED-GRY our own swatch; families black, red, grey.
 *   materials   the leather and the shoulder protector APPROVED (the protector EN 1621-1 level 2), the mesh lining CONDITIONAL
 *               (120 g/m², 150 cm), a nickel-plated zip BLOCKED, a polybag (PACKAGING) APPROVED.
 *   branding    P1's 2026 set ARCHIVED (no files), its 2027 set ACTIVE: a logo, a label artwork PDF, black and red, a polybag
 *               rule (one per garment) and a hang tag rule in words.
 *   settings    tenant-wide edit rules per lifecycle state (free, free, new revision, new revision, change order, change
 *               order, blocked) and MAY_DIFFER; company A: WARN_ABOVE 3 %, leather above 5 %, textiles may differ.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first picture is the plain front flat (not main, of no revision), the first revision file the draft
 * revision's pattern, the first branding set the archived one with no file (one active set per brand; its files would be
 * another set's), and the tenant's first SKU by id keeps no GTIN (a copy's GTIN would get a suffix).
 */

/** Fixed instants, so the seed never depends on the clock. */
const AT = new Date('2026-11-01T08:00:00.000Z')
const ARCHIVED_AT = new Date('2026-10-30T08:00:00.000Z')

/** A GTIN-13 from 12 digits: the GS1 check digit (weights 3, 1, … from the right). */
function gtin13(body: string): string {
  let total = 0
  for (let i = 0; i < body.length; i += 1) total += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1)
  return `${body}${(10 - (total % 10)) % 10}`
}

export interface StylesDepthSeed {
  readonly styleIds: { readonly jkt01: string; readonly jkt02: string }
  readonly profileIds: { readonly jacket: string; readonly touring: string; readonly vest: string }
  readonly gtinRangeId: string
  /** SEED-JKT-02's SKUs given a GTIN, with it; the first shipped in SH-0001. */
  readonly gtins: readonly { readonly variantId: string; readonly sku: string; readonly gtin: string }[]
  readonly blockedItemId: string
  readonly packagingItemId: string
  readonly brandingSetIds: { readonly archived: string; readonly active: string }
  readonly imageIds: { readonly front: string; readonly colourway: string; readonly page: string; readonly jkt02: string }
  readonly revisionFileIds: { readonly pattern: string; readonly marker: string }
}

export async function seed(context: SeedContext): Promise<StylesDepthSeed> {
  const { db, namespace } = context
  await seedShipping(context)
  await seedCompliance(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const brandId = id('party:P1')
  const store = id('files:account:r2')
  const stamp = { createdAt: AT, updatedAt: AT, createdById: actorId }
  const sha256 = (key: string): string => createHash('sha256').update(`seed styles-depth ${namespace} ${key}`).digest('hex')
  const storageKey = (companyId: string | null, name: string): string =>
    `t/${tenantId}/${companyId ? `c/${companyId}` : 'tenant'}/2026/${id(`styles-depth:key:${name}`)}`

  const profileIds = { jacket: id('styles-depth:type:JACKET'), touring: id('styles-depth:type:JACKET-TOUR'), vest: id('styles-depth:type:VEST') }
  const gtinRangeId = id('styles-depth:gtin-range:2009999')
  const usedUpRangeId = id('styles-depth:gtin-range:2009998')
  const blockedItemId = id('styles-depth:item:zip')
  const packagingItemId = id('styles-depth:item:polybag')
  const brandingSetIds = { archived: firstId('styles-depth:branding:P1:2026'), active: id('styles-depth:branding:P1:2027') }
  const imageIds = {
    front: firstId('styles-depth:image:JKT-01:front'),
    colourway: id('styles-depth:image:JKT-01:BLK'),
    page: id('styles-depth:image:JKT-01:rev1:page'),
    jkt02: id('styles-depth:image:JKT-02:photo'),
  }
  const revisionFileIds = { pattern: firstId('styles-depth:revision-file:JKT-01:1:pattern'), marker: id('styles-depth:revision-file:JKT-02:1:marker') }
  const fileIds = {
    front: id('styles-depth:file:JKT-01:front'),
    colourway: id('styles-depth:file:JKT-01:BLK'),
    page: id('styles-depth:file:JKT-01:rev1:page'),
    jkt02: id('styles-depth:file:JKT-02:photo'),
    pattern: id('styles-depth:file:JKT-01:1:pattern'),
    marker: id('styles-depth:file:JKT-02:1:marker'),
    logo: id('styles-depth:file:branding:P1:logo'),
    artwork: id('styles-depth:file:branding:P1:artwork'),
  }

  return db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      // What the earlier seeds made, by code.
      const styles = await tx.style.findMany({ where: { code: { in: ['SEED-JKT-01', 'SEED-JKT-02'] } }, select: { id: true, code: true, companyId: true } })
      const style = (code: string) => {
        const row = styles.find((entry) => entry.code === code)
        if (!row) throw new Error(`styles-depth seed: style ${code} is missing (the product and production seeds run first)`)
        return row
      }
      const jkt01 = style('SEED-JKT-01')
      const jkt02 = style('SEED-JKT-02')
      const revisions = await tx.styleRevision.findMany({ where: { styleId: { in: [jkt01.id, jkt02.id] }, revision: 1 }, select: { id: true, styleId: true, status: true } })
      const rev01 = revisions.find((row) => row.styleId === jkt01.id)!
      const rev02 = revisions.find((row) => row.styleId === jkt02.id)!
      const blackColourway = await tx.colourway.findFirstOrThrow({ where: { styleId: jkt01.id, code: 'BLK' }, select: { id: true } })
      const items = await tx.item.findMany({ where: { code: { in: ['SEED-LEA-100', 'SEED-LIN-200', 'SEED-PRO-300'] } }, select: { id: true, code: true } })
      const itemId = (code: string): string => items.find((row) => row.code === code)!.id
      const colours = await tx.colour.findMany({ where: { code: { in: ['SEED-BLK', 'SEED-RED', 'SEED-GRY'] } }, select: { id: true, code: true } })
      const colourId = (code: string): string => colours.find((row) => row.code === code)!.id
      const scale = await tx.sizeScale.findFirstOrThrow({ where: { code: 'SEED-EU-JKT' }, select: { id: true } })
      const template = await tx.measurementTemplate.findFirstOrThrow({ where: { code: 'JACKET' }, select: { id: true } })
      const label = await tx.labelTemplate.findFirstOrThrow({ where: { code: 'SEED-LBL-JKT-01' }, orderBy: { revision: 'asc' }, select: { id: true } })

      // Colours (PRD-041).
      const colourSystems: [string, Prisma.ColourUpdateInput][] = [
        ['SEED-BLK', { system: ColourSystem.RAL, reference: 'RAL 9005', family: 'black' }],
        ['SEED-RED', { system: ColourSystem.PANTONE, reference: '18-1662 TCX', family: 'red' }],
        ['SEED-GRY', { system: ColourSystem.OWN, reference: null, family: 'grey' }],
      ]
      for (const [code, data] of colourSystems) await tx.colour.update({ where: { id: colourId(code) }, data: { ...data, updatedAt: AT }, select: { id: true } })

      // Materials (PRD-035, PRD-029): two new ones, then the decisions and properties.
      const newItems: (Prisma.ItemCreateManyInput & { id: string })[] = [
        {
          id: blockedItemId,
          code: 'SEED-TRM-900',
          name: 'Seed nickel-plated zip #5',
          kind: ItemKind.TRIM,
          sourcing: ItemSourcing.BUY,
          tracking: ItemTracking.NONE,
          baseUom: Uom.PCS,
          purchaseUom: Uom.PCS,
          consumptionUom: Uom.PCS,
          properties: { material: 'brass', finish: 'nickel-plated', size: '#5', nickelFree: false },
          approval: MaterialApproval.BLOCKED,
          approvedAt: AT,
          approvedById: actorId,
          approvalNote: 'Nickel release above the limit in the supplier test (made-up).',
          ...stamp,
        },
        {
          id: packagingItemId,
          code: 'SEED-PKG-910',
          name: 'Seed polybag 60 x 80',
          kind: ItemKind.PACKAGING,
          sourcing: ItemSourcing.BUY,
          tracking: ItemTracking.NONE,
          baseUom: Uom.PCS,
          purchaseUom: Uom.PCS,
          consumptionUom: Uom.PCS,
          approval: MaterialApproval.APPROVED,
          approvedAt: AT,
          approvedById: actorId,
          ...stamp,
        },
      ]
      for (const { id: rowId, ...data } of newItems) await tx.item.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })
      const decided = { approvedAt: AT, approvedById: actorId, updatedAt: AT }
      const decisions: [string, Prisma.ItemUpdateInput][] = [
        ['SEED-LEA-100', { approval: MaterialApproval.APPROVED, approvalNote: null, ...decided }],
        ['SEED-LIN-200', {
          approval: MaterialApproval.CONDITIONAL,
          approvalNote: 'Only away from the skin until the supplier sends its textile test report (made-up).',
          properties: { weightGsm: '120', widthCm: '150', construction: '3D mesh' },
          ...decided,
        }],
        ['SEED-PRO-300', { approval: MaterialApproval.APPROVED, approvalNote: null, properties: { standard: 'EN 1621-1:2012', type: 'shoulder', level: '2', size: 'A' }, ...decided }],
      ]
      for (const [code, data] of decisions) await tx.item.update({ where: { id: itemId(code) }, data, select: { id: true } })

      // Product types (PRD-008).
      const profiles: (Prisma.ProductTypeProfileCreateManyInput & { id: string })[] = [
        {
          id: profileIds.jacket,
          code: 'SEED-PT-JKT',
          name: 'Seed jacket',
          nameI18n: { it: 'Giacca seed', en: 'Seed jacket' },
          productType: ProductType.JACKET,
          requiredAttributes: ['gender', 'hsCode', 'originCountry'],
          defaultSizeScaleId: scale.id,
          labelTemplateId: label.id,
          measurementTemplateId: template.id,
          defaultPpeCategory: PpeCategory.CATEGORY_II,
          defaultPpeStandard: 'EN 17092-4:2020',
          defaultPpeClass: 'A',
          ...stamp,
        },
        {
          id: profileIds.touring,
          code: 'SEED-PT-JKT-TOUR',
          name: 'Seed touring jacket',
          productType: ProductType.JACKET,
          parentId: profileIds.jacket,
          requiredAttributes: ['ppeClass'],
          defaultPpeClass: 'AA',
          ...stamp,
        },
        { id: profileIds.vest, companyId: companyA, code: 'SEED-PT-VEST', name: 'Seed vest (old)', productType: ProductType.VEST, status: MasterStatus.ARCHIVED, ...stamp },
      ]
      for (const { id: rowId, ...data } of profiles) await tx.productTypeProfile.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })

      // Lifecycle (PRD-007) and type of the two styles.
      await tx.style.update({
        where: { id: jkt01.id },
        data: { lifecycle: StyleLifecycle.DEVELOPMENT, lifecycleChangedAt: AT, lifecycleChangedById: actorId, productTypeProfileId: profileIds.jacket, updatedAt: AT },
        select: { id: true },
      })
      await tx.style.update({
        where: { id: jkt02.id },
        data: { lifecycle: StyleLifecycle.IN_PRODUCTION, lifecycleChangedAt: AT, lifecycleChangedById: actorId, productTypeProfileId: profileIds.touring, updatedAt: AT },
        select: { id: true },
      })

      // Names per language (PRD-019).
      const texts: (Prisma.StyleTextCreateManyInput & { id: string })[] = [
        { id: firstId('styles-depth:text:JKT-01:it'), styleId: jkt01.id, language: 'it', name: 'Giacca in pelle seed', shortDescription: 'Giacca da turismo in pelle, protezioni alle spalle (esempio).', ...stamp },
        { id: id('styles-depth:text:JKT-01:en'), styleId: jkt01.id, language: 'en', name: 'Seed leather jacket', shortDescription: 'Leather touring jacket with shoulder protectors (made-up).', longDescription: 'A made-up touring jacket for the seed.\nCowhide 1.2 mm, mesh lining.', ...stamp },
        { id: id('styles-depth:text:JKT-01:de'), styleId: jkt01.id, language: 'de', name: 'Seed Lederjacke', ...stamp },
        { id: id('styles-depth:text:JKT-02:it'), styleId: jkt02.id, language: 'it', name: 'Giacca moto seed 2', ...stamp },
        { id: id('styles-depth:text:JKT-02:en'), styleId: jkt02.id, language: 'en', name: 'Seed motorcycle jacket 2', ...stamp },
      ]
      for (const { id: rowId, ...data } of texts) await tx.styleText.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })

      // The files the pictures, revision files and branding set name (rows only).
      const file = (fileId: string, companyId: string | null, recordType: string, recordId: string, kind: 'PHOTO' | 'DOCUMENT' | 'ATTACHMENT', originalName: string, contentType: string): Prisma.StoredFileCreateManyInput => ({
        id: fileId,
        companyId,
        recordType,
        recordId,
        kind,
        originalName,
        contentType,
        sizeBytes: 4096,
        sha256: sha256(fileId),
        storageKey: storageKey(companyId, fileId),
        visibility: ['OFFICE'],
        status: 'AVAILABLE',
        availableAt: AT,
        storeAccountId: store,
        ...stamp,
      })
      await tx.storedFile.createMany({
        data: [
          file(fileIds.front, jkt01.companyId, 'Style', jkt01.id, 'PHOTO', 'Seed JKT-01 front flat.png', 'image/png'),
          file(fileIds.colourway, jkt01.companyId, 'Colourway', blackColourway.id, 'PHOTO', 'Seed JKT-01 black.jpg', 'image/jpeg'),
          file(fileIds.page, jkt01.companyId, 'StyleRevision', rev01.id, 'PHOTO', 'Seed JKT-01 rev 1 collar detail.png', 'image/png'),
          file(fileIds.jkt02, jkt02.companyId, 'Style', jkt02.id, 'PHOTO', 'Seed JKT-02.jpg', 'image/jpeg'),
          file(fileIds.pattern, jkt01.companyId, 'StyleRevision', rev01.id, 'ATTACHMENT', 'Seed JKT-01 rev 1 pattern.dxf', 'application/dxf'),
          file(fileIds.marker, jkt02.companyId, 'StyleRevision', rev02.id, 'ATTACHMENT', 'Seed JKT-02 rev 1 marker 50-52.mrk', 'application/octet-stream'),
          file(fileIds.logo, companyA, 'BrandingSet', brandingSetIds.active, 'PHOTO', 'Seed brand P1 logo.png', 'image/png'),
          file(fileIds.artwork, companyA, 'BrandingSet', brandingSetIds.active, 'DOCUMENT', 'Seed brand P1 main label.pdf', 'application/pdf'),
        ],
        skipDuplicates: true,
      })

      // Pictures (PRD-016). The draft revision's page only while it is a draft (a released revision's pictures are frozen).
      const images: (Prisma.StyleImageCreateManyInput & { id: string })[] = [
        { id: imageIds.front, styleId: jkt01.id, fileId: fileIds.front, kind: StyleImageKind.SKETCH, seq: 0, caption: 'Front flat', ...stamp },
        { id: imageIds.colourway, styleId: jkt01.id, colourwayId: blackColourway.id, fileId: fileIds.colourway, kind: StyleImageKind.PHOTO, seq: 1, isMain: true, ...stamp },
        { id: imageIds.jkt02, styleId: jkt02.id, fileId: fileIds.jkt02, kind: StyleImageKind.PHOTO, seq: 0, isMain: true, ...stamp },
      ]
      if (rev01.status === StyleRevisionStatus.DRAFT || (await tx.styleImage.findUnique({ where: { id: imageIds.page }, select: { id: true } }))) {
        images.push({
          id: imageIds.page,
          styleId: jkt01.id,
          revisionId: rev01.id,
          fileId: fileIds.page,
          kind: StyleImageKind.PAGE,
          seq: 2,
          caption: 'Collar detail',
          callouts: [
            { n: 1, x: '0.42', y: '0.18', text: 'Double stitch, 4 mm' },
            { n: 2, x: '0.6', y: '0.35', text: 'Reflective piping' },
          ],
          ...stamp,
        })
      }
      for (const { id: rowId, ...data } of images) await tx.styleImage.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })

      // Pattern and marker files (PRD-218): the draft revision's pattern only while it is a draft; a marker on the released one.
      const revisionFiles: (Prisma.StyleRevisionFileCreateManyInput & { id: string })[] = [
        { id: revisionFileIds.marker, styleId: jkt02.id, revisionId: rev02.id, fileId: fileIds.marker, kind: PatternFileKind.MARKER, format: PatternFileFormat.LECTRA, sizes: ['50', '52'], note: 'Marker for a 50/52 lay (made-up).', ...stamp },
      ]
      if (rev01.status === StyleRevisionStatus.DRAFT || (await tx.styleRevisionFile.findUnique({ where: { id: revisionFileIds.pattern }, select: { id: true } }))) {
        revisionFiles.push({ id: revisionFileIds.pattern, styleId: jkt01.id, revisionId: rev01.id, fileId: fileIds.pattern, kind: PatternFileKind.PATTERN, format: PatternFileFormat.DXF_AAMA, ...stamp })
      }
      for (const { id: rowId, ...data } of revisionFiles) await tx.styleRevisionFile.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })

      // GTINs (PRD-006): company A's block, and three of SEED-JKT-02's SKUs from it; the tenant's first SKU by id keeps none.
      const ranges: (Prisma.GtinRangeCreateManyInput & { id: string })[] = [
        { id: gtinRangeId, companyId: companyA, name: 'Seed GS1 block (in-store prefix 200)', gs1Prefix: '2009999', firstReference: 100, lastReference: 999, nextReference: 103, ...stamp },
        { id: usedUpRangeId, companyId: companyA, name: 'Seed GS1 block, used up', gs1Prefix: '2009998', firstReference: 0, lastReference: 9, nextReference: 10, status: MasterStatus.ARCHIVED, ...stamp, updatedAt: ARCHIVED_AT },
      ]
      for (const { id: rowId, ...data } of ranges) await tx.gtinRange.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })
      const [firstVariant] = await tx.variant.findMany({ orderBy: { id: 'asc' }, take: 1, select: { id: true } })
      const skus = await tx.variant.findMany({ where: { styleId: jkt02.id }, select: { id: true, sku: true } })
      const order = ['BLK-50', 'RED-52', 'BLK-52', 'BLK-54', 'RED-50', 'RED-54'].map((cell) => `SEED-JKT-02-${cell}`)
      const chosen = order
        .map((sku) => skus.find((row) => row.sku === sku))
        .filter((row): row is { id: string; sku: string } => row !== undefined && row.id !== firstVariant?.id)
        .slice(0, 3)
      const gtins = chosen.map((row, index) => ({ variantId: row.id, sku: row.sku, gtin: gtin13(`2009999${String(100 + index).padStart(5, '0')}`) }))
      for (const entry of gtins) await tx.variant.update({ where: { id: entry.variantId }, data: { gtin: entry.gtin, updatedAt: AT }, select: { id: true } })

      // Branding sets (PRD-045): P1's archived 2026 set (no file), its active 2027 set.
      const sets: (Prisma.BrandingSetCreateManyInput & { id: string })[] = [
        { id: brandingSetIds.archived, companyId: companyA, partyId: brandId, code: 'SEED-BS-P1-2026', name: 'Seed brand P1, 2026', brandColourIds: [colourId('SEED-BLK')], status: MasterStatus.ARCHIVED, ...stamp, updatedAt: ARCHIVED_AT },
        {
          id: brandingSetIds.active,
          companyId: companyA,
          partyId: brandId,
          code: 'SEED-BS-P1-2027',
          name: 'Seed brand P1, 2027',
          logoFileIds: [fileIds.logo],
          labelArtworkFileIds: [fileIds.artwork],
          brandColourIds: [colourId('SEED-BLK'), colourId('SEED-RED')],
          packagingRules: [
            { key: 'polybag', text: 'One garment per polybag with the brand sticker (made-up).', itemId: packagingItemId, quantity: '1', per: 'GARMENT' },
            { key: 'hang-tag', text: 'Brand hang tag on the left sleeve zip puller (made-up).' },
          ],
          note: 'The brand sends new artwork each season (made-up).',
          ...stamp,
        },
      ]
      for (const { id: rowId, ...data } of sets) await tx.brandingSet.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })

      // Product settings (PRD-182, PRD-105): the tenant-wide row and company A's.
      const settings: (Prisma.ProductSettingsCreateManyInput & { id: string })[] = [
        {
          id: tenantId,
          editRuleConcept: ProductEditRule.FREE,
          editRuleDevelopment: ProductEditRule.FREE,
          editRuleSampling: ProductEditRule.NEW_REVISION,
          editRuleApproved: ProductEditRule.NEW_REVISION,
          editRuleInProduction: ProductEditRule.CHANGE_ORDER,
          editRulePhaseOut: ProductEditRule.CHANGE_ORDER,
          editRuleDiscontinued: ProductEditRule.BLOCKED,
          consumptionTolerance: ConsumptionTolerance.MAY_DIFFER,
          ...stamp,
        },
        {
          id: companyA,
          companyId: companyA,
          consumptionTolerance: ConsumptionTolerance.WARN_ABOVE,
          consumptionTolerancePct: '3.0000',
          consumptionToleranceByKind: { LEATHER: { rule: 'WARN_ABOVE', percent: '5' }, TEXTILE: { rule: 'MAY_DIFFER' } },
          ...stamp,
        },
      ]
      for (const { id: rowId, ...data } of settings) await tx.productSettings.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })

      return {
        styleIds: { jkt01: jkt01.id, jkt02: jkt02.id },
        profileIds,
        gtinRangeId,
        gtins,
        blockedItemId,
        packagingItemId,
        brandingSetIds,
        imageIds,
        revisionFileIds,
      }
    }),
  )
}
