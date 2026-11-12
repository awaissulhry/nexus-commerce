import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { summaryOf } from '../../quality/complaints/store'
import { RETURN_REASON_LIST, type ReturnGrade, type ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import type { ComplaintStatus } from '@nexus/factory-domain/quality/complaints/rules'
import type { CapaStatus, CapaType } from '@nexus/factory-domain/quality/capa/rules'
import {
  cancelHeld,
  chipOf,
  complaintNextStep,
  complaintStateOf,
  complaintTakesPhotos,
  COMPLAINT_STATE_WORDS,
  CASE_CHIPS,
  decisionWords,
  disciplinesOf,
  DISPOSITION_WORDS,
  GRADE_WORDS,
  inChip,
  isOpenReturn,
  OUTCOME_WANTED_WORDS,
  returnMilestones,
  returnNextStep,
  RETURN_STATE_WORDS,
  returnStateOf,
  returnTakesPhotos,
  stageReachedWords,
  type CaseChip,
  type NextStep,
  type Words,
} from '@nexus/factory-domain/sales/portal-returns/rules'
import { reasonWords } from '../../../platform/reasons/service'
import { w2aDispositionOf } from '../returns/store'
import { answerByFor } from './create'
import {
  capasOf,
  COMPLAINT_RECORD,
  creditNotesOf,
  dayOrNull,
  isoOrNull,
  LINE_RECORD,
  openTasksOn,
  readComplaints,
  readLines,
  readReturns,
  RETURN_RECORD,
  sharedFilesOf,
  stagesReachedOf,
  type CaseComplaint,
  type CaseLine,
  type CaseRma,
  type Place,
  type Reader,
  type SharedFile,
} from './store'

/**
 * What the customer reads of its cases (B-W2b-192; design portal.customer.returns: the cases grid, the complaints list, the
 * record tabs Request and Status; links.claim's "your cases"): pure assembly over store.ts's reads, the same for a portal
 * person and a claim link. Words in Italian and English (`words`), never an internal note, a triage, a cost or a person of
 * ours.
 *
 *   options.seesPrices       the credit note's reference (a money document) only for roles with the price grain
 *   options.readsComplaints  the investigation, the answer letter and the 8D (portal.complaints.view; a claim link reads
 *                            those of the complaints it opened)
 */

export interface ViewOptions {
  readonly seesPrices: boolean
  readonly readsComplaints: boolean
  readonly now: Date
}

const iso = (value: Date): string => toUtcIso(value)

/** A file as the customer is shown it (the download goes through this module's own route). */
export function fileView(file: SharedFile, role: 'PHOTO' | 'ANSWER_LETTER' | 'EIGHT_D' | 'DOCUMENT') {
  return { id: file.id, role, name: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, addedAt: iso(file.createdAt) }
}

const rmaRef = (row: CaseRma) => ({ type: RETURN_RECORD, id: row.id })
const complaintRef = (row: CaseComplaint) => ({ type: COMPLAINT_RECORD, id: row.id })

/** A return in the cases list. */
function returnItem(row: CaseRma, lines: readonly CaseLine[], tasks: ReadonlySet<string>, answerBy: BusinessDate | null) {
  const status = row.status as ReturnStatus
  const next = returnNextStep({ status, goodsDueBy: dayOrNull(row.goodsDueBy), answerBy, rejectReason: status === 'REJECTED' ? row.statusReason : null, openTask: tasks.has(`${RETURN_RECORD}:${row.id}`), dispositions: lines.flatMap((line) => (line.disposition ? [w2aDispositionOf(line.disposition)!] : [])) })
  const open = isOpenReturn(status)
  return {
    type: 'RETURN' as const,
    id: row.id,
    number: row.number,
    yourRef: row.customerRef,
    opened: iso(row.requestedAt),
    status,
    state: returnStateOf(status),
    words: RETURN_STATE_WORDS[returnStateOf(status)],
    next,
    open,
    items: lines.slice(0, 3).map((line) => ({ description: line.description, size: line.size, serial: line.serial, pieces: line.quantity })),
    lines: lines.length,
    pieces: lines.reduce((sum, line) => sum + line.quantity, 0),
    lastUpdate: iso(row.updatedAt),
    chips: chipOf({ open, forYou: next.forYou }),
  }
}

/** A complaint in the cases list (every role of the page sees that it exists and where it is). */
function complaintItem(row: CaseComplaint, tasks: ReadonlySet<string>, styles: ReadonlyMap<string, { code: string; name: string }>, readsAnswer: boolean, fallbackAnswerBy: BusinessDate | null) {
  const status = row.status as ComplaintStatus
  const next = complaintNextStep({ status, answerBy: dayOrNull(row.answerDueOn) ?? fallbackAnswerBy, openTask: tasks.has(`${COMPLAINT_RECORD}:${row.id}`), readsAnswer })
  const open = status !== 'CLOSED'
  const style = row.styleId ? styles.get(row.styleId) : undefined
  return {
    type: 'COMPLAINT' as const,
    id: row.id,
    number: row.number,
    yourRef: row.customerRef,
    opened: iso(row.receivedAt),
    status,
    state: complaintStateOf(status),
    words: COMPLAINT_STATE_WORDS[complaintStateOf(status)],
    next,
    open,
    items: [{ description: style ? `${style.code} ${style.name}` : summaryOf(row.description, 60), size: row.size, serial: row.serial, pieces: null }],
    lines: 1,
    pieces: null,
    lastUpdate: iso(row.updatedAt),
    chips: chipOf({ open, forYou: next.forYou }),
  }
}

async function stylesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, { code: string; name: string }>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.style.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, { code: row.code, name: row.name }]))
}

export interface ListQuery {
  readonly chip?: CaseChip | undefined
  readonly q?: string | undefined
}

/** The cases of a place (RMAs and complaints), newest first, with the chips' counts. `only`: a claim link's own cases. */
export async function listCases(db: Reader, place: Place, query: ListQuery, options: ViewOptions, only?: ReadonlySet<string>) {
  const chip = query.chip ?? 'OPEN'
  const rmas = (await readReturns(db, place)).filter((row) => !only || only.has(`${RETURN_RECORD}:${row.id}`))
  const complaints = (await readComplaints(db, place)).filter((row) => !only || only.has(`${COMPLAINT_RECORD}:${row.id}`))
  const lines = await readLines(db, rmas.map((row) => row.id))
  const tasks = await openTasksOn(db, place.partyId, [...rmas.map(rmaRef), ...complaints.map(complaintRef)])
  const styles = await stylesOf(db, complaints.map((row) => row.styleId))
  const answerBy = rmas.some((row) => row.status === 'REQUESTED') || complaints.some((row) => row.status === 'NEW') ? await answerByFor(db, place.companyId, options.now) : null
  const all = [
    ...rmas.map((row) => returnItem(row, lines.filter((line) => line.returnId === row.id), tasks, row.status === 'REQUESTED' ? answerBy : null)),
    ...complaints.map((row) => complaintItem(row, tasks, styles, options.readsComplaints, row.status === 'NEW' ? answerBy : null)),
  ].sort((a, b) => (a.opened < b.opened ? 1 : a.opened > b.opened ? -1 : a.id < b.id ? 1 : -1))
  const words = (query.q ?? '').trim().toLowerCase()
  const found = words === '' ? all : all.filter((item) => [item.number, item.yourRef ?? '', ...item.items.flatMap((entry) => [entry.description, entry.serial ?? ''])].some((text) => text.toLowerCase().includes(words)))
  return {
    chip,
    chips: CASE_CHIPS.map((entry) => ({ chip: entry, count: found.filter((item) => inChip(entry, { open: item.open, forYou: item.next.forYou })).length })),
    items: found.filter((item) => inChip(chip, { open: item.open, forYou: item.next.forYou })),
  }
}

/** The complaints with their investigation (design complaints "Complaint no., subject, opened, 8D step reached, answer due"). */
export async function listComplaints(db: Reader, place: Place, only?: ReadonlySet<string>) {
  const rows = (await readComplaints(db, place)).filter((row) => !only || only.has(`${COMPLAINT_RECORD}:${row.id}`))
  const capas = await capasOf(db, rows.map((row) => row.id))
  return rows.map((row) => {
    const capa = capas.get(row.id)
    return {
      id: row.id,
      number: row.number,
      yourRef: row.customerRef,
      subject: summaryOf(row.description),
      opened: iso(row.receivedAt),
      status: row.status as ComplaintStatus,
      words: COMPLAINT_STATE_WORDS[complaintStateOf(row.status as ComplaintStatus)],
      stepReached: capa ? stageReachedWords(capa.type, capa.status as CapaStatus) : null,
      answerDueOn: dayOrNull(row.answerDueOn),
      answeredAt: isoOrNull(row.answeredAt),
    }
  })
}

/** The reasons a return may give (the RETURN list's active codes, in both languages). */
export async function returnReasons(db: Reader) {
  const words = await reasonWords(db, RETURN_REASON_LIST)
  return [...words.values()].filter((reason) => reason.active).map((reason) => ({ code: reason.code, words: { en: reason.labelEn, it: reason.labelIt }, needsNote: reason.needsDetail }))
}

/** One return as the customer reads it: Request and Status (design rec Return). */
export async function returnRecord(db: Reader, place: Place, row: CaseRma, options: ViewOptions & { readonly mayRequest: boolean; readonly mayUpload: boolean }) {
  const status = row.status as ReturnStatus
  const lines = await readLines(db, [row.id])
  const reasons = await reasonWords(db, RETURN_REASON_LIST)
  const tasks = await openTasksOn(db, place.partyId, [rmaRef(row)])
  const files = await sharedFilesOf(db, place.partyId, [rmaRef(row), ...lines.map((line) => ({ type: LINE_RECORD, id: line.id }))])
  const receipts = await db.returnReceipt.findMany({ where: { returnId: row.id }, select: { receivedAt: true, parcels: true, carrierName: true, trackingNumber: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] })
  const credits = options.seesPrices ? await creditNotesOf(db, lines.map((line) => line.id)) : []
  const replacement = row.replacementOrderId ? await db.salesOrder.findUnique({ where: { id: row.replacementOrderId }, select: { id: true, number: true, status: true } }) : null
  const site = await db.site.findUnique({ where: { id: row.siteId }, select: { name: true } })
  const answerBy = status === 'REQUESTED' ? await answerByFor(db, place.companyId, options.now) : null
  const dispositions = lines.flatMap((line) => (line.disposition ? [w2aDispositionOf(line.disposition)!] : []))
  const next: NextStep = returnNextStep({ status, goodsDueBy: dayOrNull(row.goodsDueBy), answerBy, rejectReason: status === 'REJECTED' ? row.statusReason : null, openTask: tasks.has(`${RETURN_RECORD}:${row.id}`), dispositions })
  const cancel = cancelHeld(status)
  const takesPhotos = returnTakesPhotos(status)
  const reasonOf = (code: string): Words => {
    const fact = reasons.get(code)
    return fact ? { en: fact.labelEn, it: fact.labelIt } : { en: code, it: code }
  }
  return {
    type: 'RETURN' as const,
    id: row.id,
    number: row.number,
    yourRef: row.customerRef,
    status,
    state: returnStateOf(status),
    words: RETURN_STATE_WORDS[returnStateOf(status)],
    next,
    version: row.version,
    request: {
      opened: iso(row.requestedAt),
      // B-W2b-F13b (wave 23): the RMA's own columns (before them, the request's audit row said these).
      via: row.channel,
      outcomeWanted: row.outcomeWanted ? { code: row.outcomeWanted, words: OUTCOME_WANTED_WORDS[row.outcomeWanted] } : null,
      note: row.customerNote,
      photos: files.filter((file) => file.recordType === RETURN_RECORD).map((file) => fileView(file, 'PHOTO')),
      lines: lines.map((line) => ({
        id: line.id,
        seq: line.seq,
        description: line.description,
        size: line.size,
        serial: line.serial,
        pieces: line.quantity,
        reason: { code: line.reasonCode, words: reasonOf(line.reasonCode) },
        reasonNote: line.reasonNote,
        photos: files.filter((file) => file.recordType === LINE_RECORD && file.recordId === line.id).map((file) => fileView(file, 'PHOTO')),
      })),
    },
    progress: {
      milestones: returnMilestones({ status, requestedAt: iso(row.requestedAt), authorisedAt: isoOrNull(row.authorisedAt), receivedAt: isoOrNull(row.receivedAt), inspectedAt: isoOrNull(row.inspectedAt), closedAt: isoOrNull(row.closedAt) }),
      decision: decisionWords({ status, goodsDueBy: dayOrNull(row.goodsDueBy), rejectReason: status === 'REJECTED' ? row.statusReason : null, authorised: row.authorisedAt !== null }),
      goodsDueBy: dayOrNull(row.goodsDueBy),
      sendTo: site?.name ?? null,
      /** The return instructions to print (once authorised, until the goods are back): GET …/instructions. */
      instructions: status === 'AUTHORISED',
      parcels: receipts.map((receipt) => ({ receivedAt: iso(receipt.receivedAt), parcels: receipt.parcels, carrier: receipt.carrierName, trackingNumber: receipt.trackingNumber })),
      inspection: lines
        .filter((line) => line.grade !== null || line.disposition !== null)
        .map((line) => ({
          seq: line.seq,
          received: line.receivedQuantity,
          grade: line.grade ? { code: line.grade, words: GRADE_WORDS[line.grade as ReturnGrade] } : null,
          outcome: line.disposition ? { code: w2aDispositionOf(line.disposition)!, words: DISPOSITION_WORDS[w2aDispositionOf(line.disposition)!] } : null,
        })),
      creditNotes: credits,
      replacementOrder: replacement ? { id: replacement.id, number: replacement.number } : null,
    },
    actions: {
      cancel: { allowed: options.mayRequest && cancel === null, held: cancel ?? (options.mayRequest ? null : { en: 'Your access does not ask for returns.', it: 'Il tuo accesso non chiede resi.' }) },
      addPhotos: { allowed: options.mayUpload && takesPhotos, held: takesPhotos ? (options.mayUpload ? null : { en: 'Your access does not send files.', it: 'Il tuo accesso non invia file.' }) : { en: 'We decided already: write to us in the messages.', it: 'Abbiamo già deciso: scrivici nei messaggi.' } },
    },
  }
}

/** The documents of a complaint the customer may read: the letters sent (COMPLAINT_ANSWER versions) and the 8D copies. */
async function complaintDocuments(db: Reader, row: CaseComplaint, files: readonly SharedFile[]) {
  const documents = files.filter((file) => file.kind !== 'PHOTO')
  if (documents.length === 0) return []
  const letters = await db.generatedDocument.findMany({ where: { recordType: COMPLAINT_RECORD, recordId: row.id, kind: 'COMPLAINT_ANSWER', fileId: { in: documents.map((file) => file.id) } }, select: { fileId: true, version: true } })
  const sources = [...new Set(documents.flatMap((file) => (file.sourceFileId ? [file.sourceFileId] : [])))]
  const eightD = sources.length ? new Set((await db.generatedDocument.findMany({ where: { kind: 'EIGHT_D', fileId: { in: sources } }, select: { fileId: true } })).map((doc) => doc.fileId)) : new Set<string>()
  const letterOf = new Map(letters.map((letter) => [letter.fileId, letter.version]))
  const newest = Math.max(0, ...letterOf.values())
  return documents.map((file) => {
    const role = letterOf.has(file.id) ? ('ANSWER_LETTER' as const) : file.sourceFileId && eightD.has(file.sourceFileId) ? ('EIGHT_D' as const) : ('DOCUMENT' as const)
    const version = letterOf.get(file.id) ?? null
    /** A letter replaced by a newer one is kept for the record but not the answer. */
    return { ...fileView(file, role), version, current: version === null || version === newest }
  })
}

/** One complaint as the customer reads it; the investigation, the letter and the 8D only with `readsComplaints`. */
export async function complaintRecord(db: Reader, place: Place, row: CaseComplaint, options: ViewOptions & { readonly mayUpload: boolean }) {
  const status = row.status as ComplaintStatus
  const tasks = await openTasksOn(db, place.partyId, [complaintRef(row)])
  const files = await sharedFilesOf(db, place.partyId, [complaintRef(row)])
  const style = row.styleId ? await db.style.findUnique({ where: { id: row.styleId }, select: { code: true, name: true } }) : null
  const order = row.salesOrderId ? await db.salesOrder.findUnique({ where: { id: row.salesOrderId }, select: { id: true, number: true, customerRef: true } }) : null
  const shipment = row.shipmentId ? await db.shipment.findUnique({ where: { id: row.shipmentId }, select: { id: true, number: true } }) : null
  const fallback = status === 'NEW' ? await answerByFor(db, place.companyId, options.now) : null
  const answerBy = dayOrNull(row.answerDueOn) ?? fallback
  const next = complaintNextStep({ status, answerBy, openTask: tasks.has(`${COMPLAINT_RECORD}:${row.id}`), readsAnswer: options.readsComplaints })
  const takesPhotos = complaintTakesPhotos(status)
  let investigation = null
  if (options.readsComplaints) {
    const capa = (await capasOf(db, [row.id])).get(row.id) ?? null
    const reached = capa ? await stagesReachedOf(db, capa) : new Map<string, BusinessDate>()
    investigation = {
      capa: capa ? { number: capa.number, type: capa.type, stepReached: stageReachedWords(capa.type as CapaType, capa.status as CapaStatus) } : null,
      steps: capa ? disciplinesOf(capa.type as CapaType, capa.status as CapaStatus, reached) : null,
      answeredAt: isoOrNull(row.answeredAt),
      answeredVia: row.answeredVia,
      documents: await complaintDocuments(db, row, files),
    }
  }
  return {
    type: 'COMPLAINT' as const,
    id: row.id,
    number: row.number,
    yourRef: row.customerRef,
    status,
    state: complaintStateOf(status),
    words: COMPLAINT_STATE_WORDS[complaintStateOf(status)],
    next,
    version: row.version,
    request: {
      opened: iso(row.receivedAt),
      via: row.channel,
      description: row.description,
      item: { style: style ? { code: style.code, name: style.name } : null, size: row.size, serial: row.serial, batchNumber: row.batchNumber },
      order: order ? { id: order.id, number: order.number, yourRef: order.customerRef } : null,
      shipment: shipment ? { id: shipment.id, number: shipment.number } : null,
      photos: files.filter((file) => file.kind === 'PHOTO').map((file) => fileView(file, 'PHOTO')),
    },
    progress: { answerBy, answeredAt: isoOrNull(row.answeredAt) },
    investigation,
    actions: {
      addPhotos: { allowed: options.mayUpload && takesPhotos, held: takesPhotos ? (options.mayUpload ? null : { en: 'Your access does not send files.', it: 'Il tuo accesso non invia file.' }) : { en: 'We answered already: write to us in the messages.', it: 'Abbiamo già risposto: scrivici nei messaggi.' } },
    },
  }
}
