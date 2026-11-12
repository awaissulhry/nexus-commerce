import type { Prisma } from '@nexus/factory-db'
import { versionsByBatch } from '@nexus/factory-domain/compliance/declarations/batches'
import type { Source } from '@nexus/factory-domain/compliance/declarations/rules'
import { batchLeaflets, languagePacks, type PackDocument } from '@nexus/factory-domain/compliance/user-information/packs'
import { USER_INFORMATION_CHECK, USER_INFORMATION_GENERATE, USER_INFORMATION_VIEW } from '@nexus/factory-domain/compliance/user-information/permissions'
import { differences, listsChanged, sectionsOf, sectionsToType, sourceWords, type Section } from '@nexus/factory-domain/compliance/user-information/rules'
import { DRAFT_BANNER, SECTION_LAW, type SectionKey } from '@nexus/factory-domain/compliance/user-information/template'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { declarationsClock, mayWriteDocument, namesFor, officeOf, readVisibleStyle, refused, todayOf, type Reader } from '../declarations/common'
import { chosenRevision } from '../declarations/facts'
import { rowViews } from '../declarations/read'
import { KIND, LEAFLET_SELECT, readVisibleLeaflet, type LeafletRow } from './common'
import { packMarkets, recompose } from './generate'
import { renderLeaflet } from './pdf'
// B-W2b-288 (FU2:01): a generated leaflet reads GATE-PPE-TEXTS from the PPE consultant's yes per template.
import { ppeGateFor } from '../ppe-texts/store'

/**
 * The user information, read side (B-W2b-258; design compliance.declarations, the user-information kind): one leaflet with
 * its Annex II 1.4 sections and where each came from (stale sections and lists against the records today), the protector
 * positions (PRD-353) and the spare protectors (PRD-354), its languages, the language packs per market of its revision
 * (PRD-351), the versions by batch (PRD-352), and the draft's PDF. The grid, the coverage matrix and the tiles of both kinds
 * are the DoC generator's (GET /compliance/declarations, …/coverage). The signed leaflets are W1's (B-W1-20: their PDF is the
 * uploaded file); a generated one is a draft until GATE-PPE-TEXTS and says so (`gate`).
 */

export const GATE = Object.freeze({
  name: 'GATE-PPE-TEXTS' as const,
  words: 'Draft until checked: a PPE consultant checks the generated texts once; until then the signed leaflet uploaded on the style stays the live user information.',
})

/** The names of the records the sources name (codes and numbers, for the source words). */
async function sourceNames(db: Reader, sections: readonly Section[]): Promise<Record<string, string>> {
  const ids = new Map<string, Set<string>>()
  const add = (source: Source) => {
    if (!source.recordType || !source.recordId) return
    const set = ids.get(source.recordType) ?? new Set<string>()
    set.add(source.recordId)
    ids.set(source.recordType, set)
  }
  for (const section of sections) {
    add(section.source)
    for (const value of section.values ?? []) add(value.source)
  }
  const names: Record<string, string> = {}
  const list = (type: string) => [...(ids.get(type) ?? [])]
  const read = async <T extends { id: string }>(type: string, query: (idList: string[]) => Promise<T[]>, name: (row: T) => string) => {
    const idList = list(type)
    if (idList.length === 0) return
    for (const row of await query(idList)) names[row.id] = name(row)
  }
  await read('Style', (idList) => db.style.findMany({ where: { id: { in: idList } }, select: { id: true, code: true } }), (row) => row.code)
  await read('StyleRevision', (idList) => db.styleRevision.findMany({ where: { id: { in: idList } }, select: { id: true, revision: true } }), (row) => String(row.revision))
  await read('Certificate', (idList) => db.certificate.findMany({ where: { id: { in: idList } }, select: { id: true, number: true } }), (row) => row.number)
  await read('NotifiedBody', (idList) => db.notifiedBody.findMany({ where: { id: { in: idList } }, select: { id: true, number: true, name: true } }), (row) => `${row.name} (${row.number})`)
  await read('RegulationOrStandard', (idList) => db.regulationOrStandard.findMany({ where: { id: { in: idList } }, select: { id: true, code: true, edition: true } }), (row) => (row.edition ? `${row.code}:${row.edition}` : row.code))
  await read('Phrase', (idList) => db.phrase.findMany({ where: { id: { in: idList } }, select: { id: true, key: true } }), (row) => row.key)
  await read('Party', (idList) => db.party.findMany({ where: { id: { in: idList } }, select: { id: true, legalName: true } }), (row) => row.legalName)
  await read('Company', (idList) => db.company.findMany({ where: { id: { in: idList } }, select: { id: true, code: true } }), (row) => row.code)
  await read('LabelTemplate', (idList) => db.labelTemplate.findMany({ where: { id: { in: idList } }, select: { id: true, code: true, revision: true } }), (row) => `${row.code} r${row.revision}`)
  await read('MarketProfile', (idList) => db.marketProfile.findMany({ where: { id: { in: idList } }, select: { id: true, code: true } }), (row) => row.code)
  await read('ProtectorPlacement', (idList) => db.protectorPlacement.findMany({ where: { id: { in: idList } }, select: { id: true, seq: true, pocket: true } }), (row) => `${row.seq} (${String(row.pocket).toLowerCase()})`)
  return names
}

const sectionView = (section: Section, names: Readonly<Record<string, string>>) => ({
  key: section.key,
  text: section.text,
  law: SECTION_LAW[section.key as SectionKey] ?? null,
  source: { ...section.source },
  sourceWords: sourceWords(section.source, names),
  wording: section.wording ? { ...section.wording } : null,
  values: (section.values ?? []).map((value) => ({ field: value.field, value: value.value, source: { ...value.source }, sourceWords: sourceWords(value.source, names) })),
})

const packDocumentOf = (row: Pick<LeafletRow, 'id' | 'language' | 'revision' | 'status' | 'origin' | 'translationOfId' | 'translationStatus' | 'marketCode' | 'number'>): PackDocument => ({
  id: row.id,
  language: row.language,
  revision: row.revision,
  status: row.status,
  origin: row.origin,
  translationOfId: row.translationOfId,
  translationStatus: row.translationStatus,
  marketCode: row.marketCode,
  number: row.number,
})

/** The language packs of one style revision (PRD-351): per market of the company, its languages and their leaflets. */
async function packsOf(db: Reader, styleId: string, companyId: string | null, revision: number) {
  const documents = await db.complianceDocument.findMany({ where: { styleId, kind: KIND, revision }, select: { id: true, language: true, revision: true, status: true, origin: true, translationOfId: true, translationStatus: true, marketCode: true, number: true } })
  return languagePacks(await packMarkets(db, companyId), documents.map(packDocumentOf), companyId)
}

/** One leaflet with its sections (and their sources), lists, languages, packs, versions by batch and what the caller may do. */
export async function detailOf(db: Reader, context: OfficeContext, row: LeafletRow) {
  const [view] = await rowViews(db, [row])
  const stored = sectionsOf(row.sections)
  const original = row.translationOfId ? await db.complianceDocument.findUnique({ where: { id: row.translationOfId }, select: { id: true, language: true, status: true } }) : null
  const familyRoot = row.translationOfId ?? row.id
  const family = await db.complianceDocument.findMany({ where: { OR: [{ id: familyRoot }, { translationOfId: familyRoot }] }, select: LEAFLET_SELECT, orderBy: { language: 'asc' } })
  const familyViews = await rowViews(db, family)
  const authors = await namesFor(db, [row.createdById])
  const generated = row.origin === 'GENERATED'
  const draft = row.status === 'DRAFT'

  // Stale sections: what the records give today (a generated draft; a person's typed words are never stale).
  let stale: { differences: ReturnType<typeof differences>; lists: ReturnType<typeof listsChanged>; problems: { code: string; point: string | null; message: string }[] } | null = null
  let problems: { code: string; point: string | null; message: string }[] = []
  if (generated && draft) {
    const fresh = await recompose(db, row, todayOf())
    problems = [...fresh.composition.blocking, ...fresh.composition.warnings].map((problem) => ({ ...problem }))
    stale = { differences: differences(stored.sections, fresh.composition.content.sections), lists: listsChanged(stored, fresh.composition.content), problems: fresh.composition.blocking.map((problem) => ({ ...problem })) }
  }

  // Versions by batch (PRD-352): every signed leaflet of the style and the batches and shipments recorded with it.
  const siblings = await db.complianceDocument.findMany({ where: { styleId: row.styleId, kind: KIND, origin: 'SIGNED' }, select: { id: true, kind: true, language: true, revision: true, number: true, status: true } })
  const records = siblings.length === 0 ? [] : await db.complianceDocumentBatch.findMany({ where: { documentId: { in: siblings.map((entry) => entry.id) } }, select: { id: true, documentId: true, batchNumber: true, workOrderId: true, shipmentId: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const shipmentIds = [...new Set(records.map((entry) => entry.shipmentId).filter((id): id is string => id !== null))]
  const shipments = new Map((shipmentIds.length === 0 ? [] : await db.shipment.findMany({ where: { id: { in: shipmentIds } }, select: { id: true, number: true } })).map((entry) => [entry.id, entry.number]))
  const timeline = versionsByBatch(
    records.map((entry) => ({ ...entry, createdAt: toUtcIso(entry.createdAt) })),
    siblings.map((entry) => ({ ...entry })),
  ).map((group) => ({ ...group, batches: group.batches.map((batch) => ({ ...batch, shipments: batch.shipmentIds.map((id) => ({ id, number: shipments.get(id) ?? '?' })) })) }))

  const names = await sourceNames(db, stored.sections)
  const docAddress = stored.sections.find((section) => section.key === 'docAddress')?.values?.find((value) => value.field === 'address')?.value ?? null
  const may = (permission: Permission) => mayWriteDocument(context, permission, row.companyId)
  const checked = row.translationStatus === 'CHECKED'
  return {
    ...view!,
    sections: stored.sections.map((section) => sectionView(section, names)),
    protectorPositions: stored.protectorPositions.map((entry) => ({ ...entry, protector: { ...entry.protector }, sizes: [...entry.sizes] })),
    spareProtectors: stored.spareProtectors.map((entry) => ({ ...entry, zones: [...entry.zones], certificate: { ...entry.certificate } })),
    sectionsToType: sectionsToType(stored.sections),
    template: generated ? stored.template : null,
    // B-W2b-288 (FU2:01): the gate reads the PPE consultant's yes to its template (its language, its company).
    gate: generated ? await ppeGateFor(db, { kind: 'USER_INFORMATION', templateId: stored.template ?? null, language: row.language, companyId: row.companyId }) : null,
    createdBy: authors(row.createdById),
    original: original ? { id: original.id, language: original.language, status: original.status } : null,
    languages: familyViews.map((entry, index) => ({
      id: entry.id,
      language: entry.language,
      status: entry.status,
      origin: entry.origin,
      translationStatus: entry.translationStatus,
      translationCheckedBy: entry.translationCheckedBy,
      marketCode: entry.marketCode,
      sectionsToType: sectionsToType(sectionsOf(family[index]!.sections).sections),
      original: entry.translationOfId === null,
    })),
    stale,
    problems,
    packs: await packsOf(db, row.styleId, row.companyId, row.revision),
    batches: timeline,
    publication: docAddress ? { docAddress } : null,
    may: {
      edit: generated && draft && !checked && may(USER_INFORMATION_GENERATE),
      refresh: generated && draft && !checked && may(USER_INFORMATION_GENERATE),
      translate: generated && draft && row.translationOfId === null && may(USER_INFORMATION_GENERATE),
      check: generated && draft && row.translationOfId !== null && !checked && may(USER_INFORMATION_CHECK),
      withdraw: generated && draft && may(USER_INFORMATION_GENERATE),
    },
  }
}
export type LeafletDetail = Awaited<ReturnType<typeof detailOf>>

/** GET /compliance/user-information/:documentId */
export async function getLeaflet(caller: CommandCaller, documentId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => ({ leaflet: await detailOf(db, context, await readVisibleLeaflet(db, context, documentId)) }))
}

/** The detail after a write (read again, outside the command). */
export const leafletAfter = (caller: CommandCaller, documentId: string) => getLeaflet(caller, documentId)

// ---- language packs per market (PRD-351) -------------------------------------------------------------------------------------

/** GET /compliance/user-information/packs?styleId&revisionId: the language packs of a style revision, per market. */
export async function leafletPacks(caller: CommandCaller, query: { readonly styleId: string; readonly revisionId?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const style = await readVisibleStyle(db, context, query.styleId)
    const revision = await chosenRevision(db, style.id, query.revisionId)
    if (!revision) throw new NotFoundError(`Style ${style.code} has no revision.`)
    const original = await db.complianceDocument.findFirst({ where: { styleId: style.id, kind: KIND, revision: revision.revision, origin: 'GENERATED', translationOfId: null }, select: { id: true, language: true, status: true } })
    return {
      style: { id: style.id, code: style.code, name: style.name },
      revision: { id: revision.id, revision: revision.revision, status: revision.status },
      original: original ? { ...original } : null,
      packs: await packsOf(db, style.id, style.companyId, revision.revision),
      asOf: toUtcIso(new Date()),
      gate: GATE,
    }
  })
}

// ---- the version per batch (PRD-352) -----------------------------------------------------------------------------------------

/** GET /compliance/user-information/batches?workOrderId | styleId&batchNumber: which leaflet goes (or went) with a batch. */
export async function leafletBatches(caller: CommandCaller, query: { readonly workOrderId?: string | undefined; readonly styleId?: string | undefined; readonly batchNumber?: string | undefined }) {
  const context = officeOf(caller)
  if (!query.workOrderId && !(query.styleId && query.batchNumber)) throw new ValidationError('Name the batch.', [{ path: 'querystring/workOrderId', message: 'A work order, or a style and a batch number.' }])
  return caller.withClient(async (db) => {
    const reach = scopeWhere(actorOf(context), USER_INFORMATION_VIEW, { company: 'companyId' }) as Prisma.WorkOrderWhereInput
    const order = query.workOrderId
      ? isUuid(query.workOrderId)
        ? await db.workOrder.findFirst({ where: { AND: [reach, { id: query.workOrderId }] }, select: { id: true, number: true, batchNumber: true, styleId: true, styleRevisionId: true } })
        : null
      : null
    if (query.workOrderId && !order) throw new NotFoundError('There is no such work order.')
    const style = await readVisibleStyle(db, context, order?.styleId ?? query.styleId!)
    const revision = order?.styleRevisionId ? await db.styleRevision.findUnique({ where: { id: order.styleRevisionId }, select: { revision: true } }) : null
    const batchNumber = order ? order.batchNumber : query.batchNumber!.trim()
    const documents = await db.complianceDocument.findMany({ where: { styleId: style.id, kind: KIND }, select: { id: true, language: true, revision: true, status: true, origin: true, translationOfId: true, translationStatus: true, marketCode: true, number: true } })
    const records = batchNumber ? await db.complianceDocumentBatch.findMany({ where: { styleId: style.id, batchNumber, documentId: { in: documents.map((entry) => entry.id) } }, select: { documentId: true, batchNumber: true, workOrderId: true, shipmentId: true } }) : []
    const answer = batchNumber
      ? batchLeaflets({ workOrder: order ? { id: order.id, number: order.number, batchNumber: order.batchNumber, styleId: order.styleId, revision: revision?.revision ?? null } : null, batchNumber, records, documents: documents.map(packDocumentOf) })
      : { leaflets: [], drafts: [] }
    const shipmentIds = [...new Set(answer.leaflets.flatMap((entry) => entry.recorded?.shipmentIds ?? []))]
    const shipments = new Map((shipmentIds.length === 0 ? [] : await db.shipment.findMany({ where: { id: { in: shipmentIds } }, select: { id: true, number: true } })).map((entry) => [entry.id, entry.number]))
    return {
      batch: {
        batchNumber,
        style: { id: style.id, code: style.code },
        workOrder: order ? { id: order.id, number: order.number, revision: revision?.revision ?? null } : null,
        /** A work order not released yet has no batch number: nothing is recorded or due. */
        released: batchNumber !== null,
      },
      leaflets: answer.leaflets.map((entry) => ({ ...entry, recorded: entry.recorded ? { shipments: entry.recorded.shipmentIds.map((id) => ({ id, number: shipments.get(id) ?? '?' })) } : null })),
      drafts: answer.drafts,
      gate: GATE,
    }
  })
}

// ---- the draft's PDF -------------------------------------------------------------------------------------------------------

/** GET /compliance/user-information/:id/pdf: a generated leaflet as it would print (painted now, never kept). */
export async function leafletPdf(caller: CommandCaller, documentId: string): Promise<{ pdf: Buffer; fileName: string }> {
  const context = officeOf(caller)
  const row = await caller.withClient(async (db) => {
    const found = await readVisibleLeaflet(db, context, documentId)
    if (found.origin !== 'GENERATED') {
      throw refused('invalid_state', { code: 'SIGNED', message: "A signed leaflet's PDF is the file uploaded with it: GET /product/styles/:styleId/compliance/documents/:documentId/files/:fileId/download." })
    }
    return found
  })
  const content = sectionsOf(row.sections)
  const locale = row.language === 'it' ? 'it' : 'en'
  const pdf = await renderLeaflet({
    language: row.language,
    title: row.number ?? 'User information',
    banner: DRAFT_BANNER[locale],
    sections: content.sections.map((section) => ({ key: section.key, text: section.text })),
    footer: `${row.number ?? ''} · ${locale === 'it' ? 'generata dai dati, modello' : 'generated from the records, template'} ${content.template} · ${locale === 'it' ? 'bozza' : 'draft'} v${row.version}`,
    createdAt: declarationsClock().now(),
  })
  return { pdf, fileName: `${row.number ?? 'user-information'} ${locale === 'it' ? 'bozza' : 'draft'}.pdf` }
}

