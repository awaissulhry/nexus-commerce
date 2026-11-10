import type { Prisma } from '@nexus/factory-db'
import { versionsByBatch } from '@nexus/factory-domain/compliance/declarations/batches'
import { coverageCounts, coverageMatrix, type CoverageDocument, type CoverageKind, type CoverageMarket, type CoverageStyle } from '@nexus/factory-domain/compliance/declarations/coverage'
import { DECLARATIONS_CHECK, DECLARATIONS_GENERATE, DECLARATIONS_VIEW } from '@nexus/factory-domain/compliance/declarations/permissions'
import { composeDeclaration, contentOf, differences, sourceWords, wordsFor, type AnnexPoint, type Problem, type Source, type TranslationState } from '@nexus/factory-domain/compliance/declarations/rules'
import { DRAFT_BANNER, fillWords } from '@nexus/factory-domain/compliance/declarations/template'
import { publicDocAddress, publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { processEmail } from '../../../platform/email-out/service'
import { dateDay, declarationsClock, DOCUMENT_SELECT, mayRead, mayWriteDocument, namesFor, officeOf, readVisibleDocument, refused, STYLE_SELECT, todayOf, type DocumentRow, type Reader } from './common'
import { readComposition, readPhraseBook, readRevision } from './facts'
import { renderDeclaration } from './pdf'

/**
 * The declarations, read side (B-W2b-257; design compliance.declarations): the grid (every DoC and leaflet per style,
 * language and revision, signed and generated), one declaration with its Annex IX points and where each value came from
 * (stale points against the records today), its languages, its versions by batch and its publication, and the language
 * coverage with the tiles. The signed documents are W1's (B-W1-20: their PDF is the uploaded file); a generated one is a
 * draft until GATE-PPE-TEXTS and says so (`gate`).
 */

export const GATE = Object.freeze({
  name: 'GATE-PPE-TEXTS',
  words: 'Draft until checked: a PPE consultant checks the generated texts once; until then the signed PDF stays the live declaration.',
})

const pointView = (point: AnnexPoint, names: Readonly<Record<string, string>>) => ({
  point: point.point,
  text: point.text,
  source: { ...point.source },
  sourceWords: sourceWords(point.source, names),
  wording: point.wording ? { ...point.wording } : null,
  values: (point.values ?? []).map((value) => ({ field: value.field, value: value.value, source: { ...value.source }, sourceWords: sourceWords(value.source, names) })),
})

/** The names of the records the points' sources name (codes and numbers, for the source words). */
async function sourceNames(db: Reader, points: readonly AnnexPoint[]): Promise<Record<string, string>> {
  const ids = new Map<string, Set<string>>()
  const add = (source: Source) => {
    if (!source.recordType || !source.recordId) return
    const set = ids.get(source.recordType) ?? new Set<string>()
    set.add(source.recordId)
    ids.set(source.recordType, set)
  }
  for (const point of points) {
    add(point.source)
    for (const value of point.values ?? []) add(value.source)
  }
  const names: Record<string, string> = {}
  const list = (type: string) => [...(ids.get(type) ?? [])]
  for (const row of await db.style.findMany({ where: { id: { in: list('Style') } }, select: { id: true, code: true } })) names[row.id] = row.code
  for (const row of await db.styleRevision.findMany({ where: { id: { in: list('StyleRevision') } }, select: { id: true, revision: true } })) names[row.id] = String(row.revision)
  for (const row of await db.certificate.findMany({ where: { id: { in: list('Certificate') } }, select: { id: true, number: true } })) names[row.id] = row.number
  for (const row of await db.notifiedBody.findMany({ where: { id: { in: list('NotifiedBody') } }, select: { id: true, number: true, name: true } })) names[row.id] = `${row.name} (${row.number})`
  for (const row of await db.regulationOrStandard.findMany({ where: { id: { in: list('RegulationOrStandard') } }, select: { id: true, code: true, edition: true } })) names[row.id] = row.edition ? `${row.code}:${row.edition}` : row.code
  for (const row of await db.phrase.findMany({ where: { id: { in: list('Phrase') } }, select: { id: true, key: true } })) names[row.id] = row.key
  for (const row of await db.party.findMany({ where: { id: { in: list('Party') } }, select: { id: true, legalName: true } })) names[row.id] = row.legalName
  for (const row of await db.company.findMany({ where: { id: { in: list('Company') } }, select: { id: true, code: true } })) names[row.id] = row.code
  for (const row of await db.labelTemplate.findMany({ where: { id: { in: list('LabelTemplate') } }, select: { id: true, code: true, revision: true } })) names[row.id] = `${row.code} r${row.revision}`
  return names
}

/** The batches and shipments recorded under each document. */
async function batchCounts(db: Reader, documentIds: readonly string[]): Promise<Map<string, { batches: number; shipments: number }>> {
  if (documentIds.length === 0) return new Map()
  const rows = await db.complianceDocumentBatch.findMany({ where: { documentId: { in: [...documentIds] } }, select: { documentId: true, batchNumber: true, shipmentId: true } })
  const out = new Map<string, { batches: Set<string>; shipments: Set<string> }>()
  for (const row of rows) {
    const entry = out.get(row.documentId) ?? { batches: new Set<string>(), shipments: new Set<string>() }
    entry.batches.add(row.batchNumber)
    if (row.shipmentId) entry.shipments.add(row.shipmentId)
    out.set(row.documentId, entry)
  }
  return new Map([...out].map(([id, entry]) => [id, { batches: entry.batches.size, shipments: entry.shipments.size }]))
}

/** The switched-on, active markets that apply to a company's documents (its own and every company's). */
export async function activeMarkets(db: Reader): Promise<(CoverageMarket & { switchedOn: boolean })[]> {
  const rows = await db.marketProfile.findMany({ where: { status: 'ACTIVE', switchedOn: true }, select: { code: true, companyId: true, docLanguages: true, userInfoLanguages: true, switchedOn: true }, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return rows
}

const languagesFor = (markets: readonly CoverageMarket[], companyId: string | null, kind: CoverageKind, language: string): string[] =>
  markets.filter((market) => (market.companyId === null || companyId === null || market.companyId === companyId) && (kind === 'DECLARATION_OF_CONFORMITY' ? market.docLanguages : market.userInfoLanguages).includes(language)).map((market) => market.code)

export function rowView(row: DocumentRow, extra: { style: { code: string; name: string }; certificateNumber: string | null; counts: { batches: number; shipments: number }; markets: string[]; checkedBy: { id: string; name: string } | null }) {
  const content = contentOf(row.content)
  return {
    id: row.id,
    styleId: row.styleId,
    style: extra.style,
    companyId: row.companyId,
    kind: row.kind as CoverageKind,
    language: row.language,
    revision: row.revision,
    number: row.number,
    status: row.status,
    origin: row.origin,
    translationOfId: row.translationOfId,
    translationStatus: row.translationStatus as TranslationState | null,
    translationCheckedAt: row.translationCheckedAt ? toUtcIso(row.translationCheckedAt) : null,
    translationCheckedBy: extra.checkedBy,
    marketCode: row.marketCode,
    certificate: row.certificateId ? { id: row.certificateId, number: extra.certificateNumber ?? '?' } : null,
    maker: { name: row.makerName, address: row.makerAddress, partyId: row.makerPartyId, role: row.makerPartyId ? ('BRAND' as const) : ('COMPANY' as const) },
    standards: row.standards,
    signedByName: row.signedByName,
    signedByFunction: row.signedByFunction,
    signedPlace: row.signedPlace,
    signedOn: row.signedOn ? dateDay(row.signedOn) : null,
    issuedAt: row.issuedAt ? toUtcIso(row.issuedAt) : null,
    batches: extra.counts.batches,
    shipments: extra.counts.shipments,
    marketsNeeding: extra.markets,
    /** A generated document is a draft until GATE-PPE-TEXTS. */
    draftUntilChecked: row.origin === 'GENERATED',
    /** Points still holding the original's words or words to type (a generated translation). */
    pointsToType: content.points.filter((point) => point.source.kind === 'UNTRANSLATED' || point.source.kind === 'TO_TYPE').map((point) => point.point),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}
export type DeclarationRowView = ReturnType<typeof rowView>

/** The rows' views, read together. */
export async function rowViews(db: Reader, rows: readonly DocumentRow[]): Promise<DeclarationRowView[]> {
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.styleId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const certificates = new Map((await db.certificate.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.certificateId).filter((id): id is string => id !== null))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const counts = await batchCounts(db, rows.map((row) => row.id))
  const markets = await activeMarkets(db)
  const names = await namesFor(db, rows.map((row) => row.translationCheckedById))
  return rows.map((row) =>
    rowView(row, {
      style: { code: styles.get(row.styleId)?.code ?? '?', name: styles.get(row.styleId)?.name ?? '?' },
      certificateNumber: row.certificateId ? (certificates.get(row.certificateId) ?? null) : null,
      counts: counts.get(row.id) ?? { batches: 0, shipments: 0 },
      markets: languagesFor(markets, row.companyId, row.kind as CoverageKind, row.language),
      checkedBy: names(row.translationCheckedById),
    }),
  )
}

export interface ListQuery {
  readonly styleId?: string | undefined
  readonly kind?: CoverageKind | undefined
  readonly origin?: 'SIGNED' | 'GENERATED' | undefined
  readonly status?: 'DRAFT' | 'ISSUED' | 'SUPERSEDED' | 'WITHDRAWN' | undefined
  readonly language?: string | undefined
  readonly q?: string | undefined
  readonly limit?: number | undefined
}

export const LIST_MAX = 500

/** GET /compliance/declarations: every DoC and leaflet the caller may see (styles of the companies reached). */
export async function listDeclarations(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const limit = Math.min(query.limit ?? LIST_MAX, LIST_MAX)
  return caller.withClient(async (db) => {
    const reach = scopeWhere(actor, DECLARATIONS_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.ComplianceDocumentWhereInput
    const styleReach = scopeWhere(actor, DECLARATIONS_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.StyleWhereInput
    const filters: Prisma.ComplianceDocumentWhereInput[] = [reach, { style: styleReach }]
    if (query.styleId) filters.push({ styleId: query.styleId })
    if (query.kind) filters.push({ kind: query.kind })
    if (query.origin) filters.push({ origin: query.origin })
    if (query.status) filters.push({ status: query.status })
    if (query.language) filters.push({ language: query.language })
    if (query.q) filters.push({ OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { style: { code: { contains: query.q, mode: 'insensitive' } } }, { style: { name: { contains: query.q, mode: 'insensitive' } } }] })
    const rows = await db.complianceDocument.findMany({
      where: { AND: filters },
      select: DOCUMENT_SELECT,
      orderBy: [{ styleId: 'asc' }, { kind: 'asc' }, { revision: 'desc' }, { language: 'asc' }, { origin: 'asc' }],
      take: limit + 1,
    })
    return { declarations: await rowViews(db, rows.slice(0, limit)), more: rows.length > limit, asOf: toUtcIso(new Date()), gate: GATE }
  })
}

/** One declaration with its points (and their sources), languages, versions by batch, publication and what the caller may do. */
export async function detailOf(db: Reader, context: OfficeContext, row: DocumentRow) {
  const [view] = await rowViews(db, [row])
  const content = contentOf(row.content)
  const original = row.translationOfId ? await db.complianceDocument.findUnique({ where: { id: row.translationOfId }, select: { id: true, language: true, status: true, version: true } }) : null
  const familyRoot = row.translationOfId ?? row.id
  const family = await db.complianceDocument.findMany({ where: { OR: [{ id: familyRoot }, { translationOfId: familyRoot }] }, select: DOCUMENT_SELECT, orderBy: { language: 'asc' } })
  const familyViews = await rowViews(db, family)
  const checkers = await namesFor(db, [row.createdById])

  // Stale points: what the records give today (a generated draft; a person's typed words are never stale).
  let stale: { differences: ReturnType<typeof differences>; problems: Problem[] } | null = null
  let problems: Problem[] = []
  if (row.origin === 'GENERATED' && row.status === 'DRAFT' && row.kind === 'DECLARATION_OF_CONFORMITY') {
    const style = await db.style.findUnique({ where: { id: row.styleId }, select: STYLE_SELECT })
    if (style) {
      const revision = await readRevision(db, row.styleId, row.revision)
      const signatoryRow = original ? await db.complianceDocument.findUnique({ where: { id: original.id }, select: DOCUMENT_SELECT }) : row
      const signatory = { name: signatoryRow?.signedByName ?? null, function: signatoryRow?.signedByFunction ?? null, place: signatoryRow?.signedPlace ?? null, on: signatoryRow?.signedOn ? dateDay(signatoryRow.signedOn) : null }
      const { facts, book } = await readComposition(db, { style, revision, companyId: row.companyId, marketCode: row.marketCode, day: todayOf(), citedCertificateId: row.certificateId, signatory }, [row.language])
      const originalPoints = original ? contentOf((await db.complianceDocument.findUnique({ where: { id: original.id }, select: { content: true } }))?.content).points : null
      const fresh = composeDeclaration(facts, row.language, book, originalPoints)
      problems = [...fresh.blocking, ...fresh.warnings]
      stale = { differences: differences(content.points, fresh.content.points), problems: [...fresh.blocking] }
    }
  }

  // Versions by batch: every revision of this style, kind and language family (signed documents carry the batches).
  const siblings = await db.complianceDocument.findMany({ where: { styleId: row.styleId, kind: row.kind }, select: { id: true, kind: true, language: true, revision: true, number: true, status: true, origin: true } })
  const records = await db.complianceDocumentBatch.findMany({ where: { documentId: { in: siblings.map((entry) => entry.id) } }, select: { id: true, documentId: true, batchNumber: true, workOrderId: true, shipmentId: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const shipments = new Map((await db.shipment.findMany({ where: { id: { in: [...new Set(records.map((entry) => entry.shipmentId).filter((id): id is string => id !== null))] } }, select: { id: true, number: true } })).map((entry) => [entry.id, entry.number]))
  const timeline = versionsByBatch(
    records.map((entry) => ({ ...entry, createdAt: toUtcIso(entry.createdAt) })),
    siblings.filter((entry) => entry.origin === 'SIGNED').map((entry) => ({ id: entry.id, kind: entry.kind, language: entry.language, revision: entry.revision, number: entry.number, status: entry.status })),
  ).map((group) => ({ ...group, batches: group.batches.map((batch) => ({ ...batch, shipments: batch.shipmentIds.map((id) => ({ id, number: shipments.get(id) ?? '?' })) })) }))

  const names = await sourceNames(db, content.points)
  const style = await db.style.findUnique({ where: { id: row.styleId }, select: { id: true } })
  const live = await db.complianceDocument.count({ where: { styleId: row.styleId, kind: 'DECLARATION_OF_CONFORMITY', origin: 'SIGNED', status: { in: ['ISSUED', 'SUPERSEDED'] } } })
  const generated = row.origin === 'GENERATED'
  const draft = row.status === 'DRAFT'
  const checked = row.translationStatus === 'CHECKED'
  return {
    ...view!,
    points: content.points.map((point) => pointView(point, names)),
    template: generated ? content.template : null,
    gate: generated ? { ...GATE, open: true } : null,
    createdBy: checkers(row.createdById),
    original: original ? { id: original.id, language: original.language, status: original.status } : null,
    languages: familyViews.map((entry) => ({ id: entry.id, language: entry.language, status: entry.status, origin: entry.origin, translationStatus: entry.translationStatus, translationCheckedBy: entry.translationCheckedBy, marketCode: entry.marketCode, pointsToType: entry.pointsToType, original: entry.translationOfId === null })),
    stale,
    problems,
    batches: timeline,
    publication: style ? { styleCode: publicDocCodeOf(style.id), address: publicDocAddress(processEmail().webOrigin, publicDocCodeOf(style.id)), live: live > 0 } : null,
    may: {
      edit: generated && draft && !checked && mayWriteDocument(context, DECLARATIONS_GENERATE, row.companyId),
      refresh: generated && draft && !checked && row.kind === 'DECLARATION_OF_CONFORMITY' && mayWriteDocument(context, DECLARATIONS_GENERATE, row.companyId),
      translate: generated && draft && row.translationOfId === null && mayWriteDocument(context, DECLARATIONS_GENERATE, row.companyId),
      check: generated && draft && row.translationOfId !== null && !checked && mayWriteDocument(context, DECLARATIONS_CHECK, row.companyId),
      withdraw: generated && draft && mayWriteDocument(context, DECLARATIONS_GENERATE, row.companyId),
    },
  }
}
export type DeclarationDetail = Awaited<ReturnType<typeof detailOf>>

/** GET /compliance/declarations/:documentId */
export async function getDeclaration(caller: CommandCaller, documentId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => ({ declaration: await detailOf(db, context, await readVisibleDocument(db, context, documentId)) }))
}

/** The detail after a write (read again, outside the command). */
export const detailAfter = (caller: CommandCaller, documentId: string) => getDeclaration(caller, documentId)

// ---- language coverage -----------------------------------------------------------------------------------------------------

/** GET /compliance/declarations/coverage: the language matrix of the PPE styles' current revisions and the tiles. */
export async function declarationsCoverage(caller: CommandCaller, query: { readonly styleId?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const styleReach = scopeWhere(actor, DECLARATIONS_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.StyleWhereInput
    const styles = await db.style.findMany({
      where: { AND: [styleReach, { status: 'ACTIVE', ppeCategory: { not: 'NOT_PPE' } }, ...(query.styleId ? [{ id: query.styleId }] : [])] },
      select: { id: true, code: true, name: true, companyId: true },
      orderBy: [{ code: 'asc' }],
      take: LIST_MAX,
    })
    const revisions = await db.styleRevision.findMany({ where: { styleId: { in: styles.map((style) => style.id) } }, select: { styleId: true, revision: true, status: true } })
    const currentOf = (styleId: string): number | null => {
      const own = revisions.filter((entry) => entry.styleId === styleId).sort((a, b) => b.revision - a.revision)
      return (own.find((entry) => entry.status === 'RELEASED') ?? own[0])?.revision ?? null
    }
    const coverageStyles: CoverageStyle[] = styles.map((style) => ({ ...style, revision: currentOf(style.id) }))
    const documents = await db.complianceDocument.findMany({ where: { styleId: { in: styles.map((style) => style.id) } }, select: { id: true, styleId: true, kind: true, language: true, revision: true, status: true, origin: true, translationStatus: true, updatedAt: true } })
    const coverageDocuments: CoverageDocument[] = documents.map((entry) => ({ ...entry, kind: entry.kind as CoverageKind, hasFile: entry.status !== 'DRAFT' }))
    const markets = (await activeMarkets(db)).filter((market) => mayRead(context, market.companyId))
    const { languages, rows } = coverageMatrix(coverageStyles, coverageDocuments, markets)
    const counts = coverageCounts(rows, coverageDocuments)
    const now = new Date()
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const superseded = documents.filter((entry) => entry.status === 'SUPERSEDED' && entry.updatedAt >= since).length
    const { unrecorded } = await unrecordedCount(db, context)
    return {
      languages,
      rows: rows.map((row) => ({ style: { id: row.style.id, code: row.style.code, name: row.style.name, revision: row.style.revision }, kind: row.kind, cells: row.cells.map((cell) => ({ ...cell, markets: [...cell.markets] })) })),
      tiles: { ...counts, supersededIn30Days: superseded, batchesShippedWithoutVersion: unrecorded },
      asOf: toUtcIso(now),
      gate: GATE,
    }
  })
}

/** The shipment × batch pairs that left (SHIPPED or DELIVERED) carrying PPE with no version recorded for that shipment. */
export async function unrecordedPairs(db: Reader, context: OfficeContext, limit = 200) {
  const actor = actorOf(context)
  const reach = scopeWhere(actor, DECLARATIONS_VIEW, { company: 'companyId' }) as Prisma.ShipmentWhereInput
  const shipments = await db.shipment.findMany({ where: { AND: [reach, { status: { in: ['SHIPPED', 'DELIVERED'] } }] }, select: { id: true, number: true, companyId: true, shippedAt: true }, orderBy: [{ shippedAt: 'desc' }, { id: 'desc' }], take: 2000 })
  if (shipments.length === 0) return []
  const lines = await db.shipmentLine.findMany({ where: { shipmentId: { in: shipments.map((entry) => entry.id) } }, select: { shipmentId: true, workOrderId: true } })
  const orders = await db.workOrder.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.workOrderId))] } }, select: { id: true, number: true, batchNumber: true, styleId: true } })
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(orders.map((order) => order.styleId))] } }, select: { id: true, code: true, ppeCategory: true } })).map((style) => [style.id, style]))
  const recorded = await db.complianceDocumentBatch.findMany({ where: { shipmentId: { in: shipments.map((entry) => entry.id) } }, select: { shipmentId: true, batchNumber: true } })
  const has = new Set(recorded.map((entry) => `${entry.shipmentId}|${entry.batchNumber}`))
  const orderOf = new Map(orders.map((order) => [order.id, order]))
  const out: { shipmentId: string; shipmentNumber: string; shippedAt: string | null; workOrderId: string; workOrderNumber: string; batchNumber: string; styleId: string; styleCode: string }[] = []
  const seen = new Set<string>()
  for (const shipment of shipments) {
    for (const line of lines.filter((entry) => entry.shipmentId === shipment.id)) {
      const order = orderOf.get(line.workOrderId)
      const style = order ? styles.get(order.styleId) : undefined
      if (!order?.batchNumber || !style || style.ppeCategory === 'NOT_PPE') continue
      const key = `${shipment.id}|${order.batchNumber}`
      if (has.has(key) || seen.has(key)) continue
      seen.add(key)
      out.push({ shipmentId: shipment.id, shipmentNumber: shipment.number, shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null, workOrderId: order.id, workOrderNumber: order.number, batchNumber: order.batchNumber, styleId: style.id, styleCode: style.code })
      if (out.length >= limit) return out
    }
  }
  return out
}

async function unrecordedCount(db: Reader, context: OfficeContext) {
  const pairs = await unrecordedPairs(db, context, 1000)
  return { unrecorded: pairs.length }
}

// ---- the draft's PDF -------------------------------------------------------------------------------------------------------

/** GET /compliance/declarations/:id/pdf: a generated draft as it would print (painted now, never kept). */
export async function declarationPdf(caller: CommandCaller, documentId: string): Promise<{ pdf: Buffer; fileName: string }> {
  const context = officeOf(caller)
  const { row, book } = await caller.withClient(async (db) => {
    const found = await readVisibleDocument(db, context, documentId)
    if (found.origin !== 'GENERATED') {
      throw refused('invalid_state', { code: 'SIGNED', message: 'A signed declaration\'s PDF is the file uploaded with it: GET /product/styles/:styleId/compliance/documents/:documentId/files/:fileId/download.' })
    }
    if (found.kind !== 'DECLARATION_OF_CONFORMITY') throw refused('invalid_state', { code: 'USER_INFORMATION', message: 'This is user information: its PDF is the leaflet step\'s (B-W2b-258).' })
    return { row: found, book: await readPhraseBook(db, found.companyId, [found.language]) }
  })
  const title = wordsFor(book, 'doc.title', row.language).words ?? wordsFor(book, 'doc.title', 'en').words!
  const numberWords = wordsFor(book, 'doc.number', row.language).words ?? 'No. {number}'
  const locale = row.language === 'it' ? 'it' : 'en'
  const pdf = await renderDeclaration({
    language: row.language,
    title,
    number: row.number ? fillWords(numberWords, { number: row.number }) : null,
    banner: DRAFT_BANNER[locale],
    points: contentOf(row.content).points.map((point) => ({ point: point.point, text: point.text })),
    footer: `${row.number ?? ''} · ${locale === 'it' ? 'generata dai dati, modello' : 'generated from the records, template'} ${contentOf(row.content).template} · ${locale === 'it' ? 'bozza' : 'draft'} v${row.version}`,
    createdAt: declarationsClock().now(),
  })
  return { pdf, fileName: `${row.number ?? 'DoC'} ${locale === 'it' ? 'bozza' : 'draft'}.pdf` }
}
