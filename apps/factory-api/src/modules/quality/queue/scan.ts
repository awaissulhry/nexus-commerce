import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { parseScanId, tenantTag, type ScanType } from '@nexus/factory-domain/numbering/scan-id'
import {
  garmentsToInspect,
  isMine,
  scanTargets,
  takenOf,
  unknownCodeWords,
  type FoundType,
  type QueueKind,
  type QueueRecordType,
  type ScanOutcome,
  type ScanStage,
  type ScanTarget,
  type StartableCheck,
  type Taken,
  type Words,
} from '@nexus/factory-domain/quality/queue/rules'
import type { CommandCaller } from '../../../core/command'
import { benchWorkOrders } from '../final/bench'
import { openInspection } from '../final/inspections'
import { workOrderPlans } from '../final/sheet'
import { openIncoming, scanLot } from '../incoming/open'
import { openCheck } from '../inprocess/checks'
import { PERMISSIONS, may, viewerOf, type Viewer } from './access'
import { modelOf } from './models'

/**
 * Scan to start (B-W2b-106; QHS-065; design floor.final "Scan the work order (W1) or a lot, bundle, serial or carton (W2b)",
 * floor.incoming "Scanning opens the inspection with its plan"). A code read off a label (scan-id: hyphens and case aside, a
 * label of another factory or with a typo said in words) or typed: a lot (our code, the supplier's lot, the dye batch), a hide
 * (its tag, the tannery's number), a bundle (its ticket, also a replaced one), a garment serial, a carton (its parcel's
 * tracking number), a work order (number or batch), an inspection's number. The bench (`stage`) says which inspection a code
 * leads to when it could lead to more than one; a code of another bench is refused in words.
 *
 *   GET  /quality/queue/scan?code&stage   what the code leads to: the OPEN record, what would START (plan, sample), CHOOSE
 *                                         between several, or NOTHING (in words). Read only.
 *   POST /quality/queue/scan              the same, then: an open record is answered (200, nothing written); else the one
 *                                         thing to start is opened through its module's own command with the plan that
 *                                         applies (201): B-W1-45 / B-W2b-97's final inspection (the lot: every garment
 *                                         finished, not released and not in an open inspection), B-W2b-98's incoming
 *                                         inspection, B-W2b-99's first piece or cutting inspection. Online only (a number).
 *
 * The caller's own client reads (a tablet: its site only, row-level security too); the module refuses what the caller may
 * not open.
 */

interface Found {
  readonly type: FoundType
  readonly id: string
  readonly code: string
  readonly label: string
  readonly companyId: string
  readonly siteId: string
  /** What the inspection is of: a lot, a bundle and its work order, work orders, a record. */
  readonly lotId?: string
  readonly bundleId?: string
  readonly workOrderIds?: readonly string[]
  readonly recordStatus?: string
}

interface Ref {
  readonly recordType: QueueRecordType
  readonly id: string
  readonly kind: QueueKind
  readonly number: string | null
  readonly taken: Taken
  readonly version: number
  readonly path: string
}

interface StartOption {
  readonly target: ScanTarget
  readonly kind: QueueKind
  readonly plan: { readonly code: string; readonly number: number; readonly words: string | null } | null
  readonly lotSize: string | null
  readonly uom: string | null
  readonly sampleSize: number | null
  readonly words: Words
  /** How the module opens it. */
  readonly open: { readonly lotId: string } | { readonly workOrderId: string; readonly lotSize: number; readonly planId: string | null } | { readonly check: StartableCheck; readonly workOrderId: string; readonly bundleId: string | null }
}

interface Answer {
  readonly opens: Ref[]
  readonly starts: StartOption[]
  readonly nothing: Words | null
}

const MAX = 10
const is = (code: string) => ({ equals: code, mode: 'insensitive' as const })

// ---- what a code names ---------------------------------------------------------------------------------------------------------------

async function lookUp(db: FactoryClient, code: string, type: ScanType | null): Promise<Found[]> {
  const found: Found[] = []
  const wants = (...types: ScanType[]) => type === null || types.includes(type)
  if (wants('LOT', 'BATCH')) {
    for (const lot of await db.lot.findMany({ where: { OR: [{ code: is(code) }, { supplierLotRef: is(code) }, { dyeBatch: is(code) }] }, select: { id: true, code: true, companyId: true, siteId: true, item: { select: { name: true } } }, take: MAX })) {
      found.push({ type: 'LOT', id: lot.id, code: lot.code, label: lot.item.name, companyId: lot.companyId, siteId: lot.siteId, lotId: lot.id })
    }
  }
  if (wants('HIDE')) {
    for (const hide of await db.hide.findMany({ where: { OR: [{ code: is(code) }, { supplierCode: is(code) }] }, select: { id: true, code: true, siteId: true, lotId: true, lot: { select: { code: true, companyId: true } } }, take: MAX })) {
      found.push({ type: 'HIDE', id: hide.id, code: hide.code, label: `Hide of lot ${hide.lot.code}`, companyId: hide.lot.companyId, siteId: hide.siteId, lotId: hide.lotId })
    }
  }
  if (wants('BUNDLE', 'COUPON')) {
    const select = { id: true, code: true, siteId: true, workOrderId: true, quantity: true, workOrder: { select: { number: true, companyId: true } } } as const
    const bundles = [...(await db.bundle.findMany({ where: { code: is(code) }, select, take: MAX })), ...(await db.bundle.findMany({ where: { replacedCodes: { has: code.toUpperCase() } }, select, take: MAX }))]
    for (const bundle of bundles) {
      found.push({ type: 'BUNDLE', id: bundle.id, code: bundle.code, label: `${bundle.workOrder.number} · ${bundle.quantity} garments`, companyId: bundle.workOrder.companyId, siteId: bundle.siteId, bundleId: bundle.id, workOrderIds: [bundle.workOrderId] })
    }
  }
  if (wants('SERIAL')) {
    for (const serial of await db.garmentSerial.findMany({ where: { serial: is(code) }, select: { id: true, serial: true, siteId: true, workOrderId: true, workOrderSize: { select: { workOrder: { select: { number: true, companyId: true } } } } }, take: MAX })) {
      found.push({ type: 'SERIAL', id: serial.id, code: serial.serial, label: serial.workOrderSize.workOrder.number, companyId: serial.workOrderSize.workOrder.companyId, siteId: serial.siteId, workOrderIds: [serial.workOrderId] })
    }
  }
  if (wants('CARTON')) {
    for (const parcel of await db.parcel.findMany({ where: { trackingNumber: is(code) }, select: { id: true, siteId: true, trackingNumber: true, shipment: { select: { number: true, companyId: true } }, lines: { select: { workOrderId: true } } }, take: MAX })) {
      found.push({ type: 'CARTON', id: parcel.id, code: parcel.trackingNumber ?? code, label: `Carton of ${parcel.shipment.number}`, companyId: parcel.shipment.companyId, siteId: parcel.siteId, workOrderIds: [...new Set(parcel.lines.map((line) => line.workOrderId))] })
    }
  }
  if (wants('WORK_ORDER', 'BATCH')) {
    for (const order of await db.workOrder.findMany({ where: { OR: [{ number: is(code) }, { batchNumber: is(code) }] }, select: { id: true, number: true, companyId: true, siteId: true, style: { select: { code: true } } }, take: MAX })) {
      found.push({ type: 'WORK_ORDER', id: order.id, code: order.number, label: order.style.code, companyId: order.companyId, siteId: order.siteId, workOrderIds: [order.id] })
    }
  }
  if (type === null) {
    for (const row of await db.inspection.findMany({ where: { number: is(code) }, select: { id: true, number: true, companyId: true, siteId: true, workOrderId: true, status: true }, take: MAX })) {
      found.push({ type: 'INSPECTION', id: row.id, code: row.number ?? code, label: row.status, companyId: row.companyId, siteId: row.siteId, workOrderIds: [row.workOrderId], recordStatus: row.status })
    }
    for (const row of await db.incomingInspection.findMany({ where: { number: is(code) }, select: { id: true, number: true, companyId: true, siteId: true, lotId: true, status: true }, take: MAX })) {
      found.push({ type: 'INCOMING_INSPECTION', id: row.id, code: row.number, label: row.status, companyId: row.companyId, siteId: row.siteId, ...(row.lotId ? { lotId: row.lotId } : {}), recordStatus: row.status })
    }
  }
  return found
}

/** The records the code names that the viewer may inspect (a tablet: its own site; the office: a view over the record's site). */
async function foundFor(caller: CommandCaller, viewer: Viewer, typed: string): Promise<{ code: string; found: Found[]; problem: Words | null }> {
  const scan = parseScanId(typed, { tenantTag: tenantTag(viewer.context.tenantId) })
  if (!scan.ok && (scan.problem === 'tenant' || scan.problem === 'check')) {
    const it = scan.problem === 'tenant' ? 'Questa etichetta è di un’altra fabbrica.' : 'Il codice ha un errore di battitura: scansionalo o scrivilo di nuovo.'
    return { code: typed, found: [], problem: { it, en: scan.message } }
  }
  const code = scan.ok ? scan.text : typed
  if (scan.ok && scan.type === 'LOCATION') return { code, found: [], problem: { it: 'Questa è l’etichetta di un’ubicazione: non si collauda.', en: 'This is a location label: nothing is inspected there.' } }
  const all = await caller.withClient((db) => lookUp(db, code, scan.ok ? scan.type : null))
  const seen = new Set<string>()
  const views = [PERMISSIONS.final.view, PERMISSIONS.incoming.view, PERMISSIONS.inprocess.view]
  const found = all.filter((row) => {
    const key = `${row.type}:${row.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return views.some((permission) => may(viewer, permission, row))
  })
  return { code, found, problem: null }
}

// ---- where it leads ------------------------------------------------------------------------------------------------------------------

const none = (words: Words): Answer => ({ opens: [], starts: [], nothing: words })
const errorWords = (error: unknown): Words => {
  const message = error instanceof Error ? error.message : String(error)
  return { it: message, en: message }
}

async function incomingAnswer(caller: CommandCaller, viewer: Viewer, found: Found): Promise<Answer> {
  if (found.type === 'INCOMING_INSPECTION' && found.recordStatus !== 'OPEN') return none({ it: `${found.code} è ${found.recordStatus?.toLowerCase()}: un controllo firmato o annullato non cambia.`, en: `${found.code} is ${found.recordStatus?.toLowerCase()}: a signed or cancelled inspection never changes.` })
  if (!found.lotId) return none({ it: 'Le merci di un terzista non si controllano ancora da qui.', en: 'Goods back from a workshop are not inspected from here yet.' })
  if (!viewer.views.incoming) return none({ it: 'Non hai il controllo in accettazione.', en: 'You do not hold incoming inspection.' })
  let scanned: Awaited<ReturnType<typeof scanLot>>
  try {
    scanned = await scanLot(caller, found.lotId)
  } catch (error) {
    if (error instanceof DomainError) return none(errorWords(error))
    throw error
  }
  if (scanned.open) {
    const id = scanned.open.inspection.id
    const row = (await caller.withClient((db) => db.incomingInspection.findUnique({ where: { id }, select: { number: true, inspectorWorkerId: true, inspectorUserId: true, version: true } })))!
    return { opens: [{ recordType: 'IncomingInspection', id, kind: 'INCOMING', number: row.number, taken: takenOf({ workerId: row.inspectorWorkerId, userId: row.inspectorUserId }, viewer.person), version: row.version, path: `/quality/incoming/${id}` }], starts: [], nothing: null }
  }
  const opening = scanned.opening!
  if (opening.refusal || !opening.plan) return none({ it: opening.refusal ?? 'Nessun piano si applica.', en: opening.refusal ?? 'No plan applies.' })
  if (!may(viewer, PERMISSIONS.incoming.record, found)) return none({ it: 'Puoi vedere questo lotto, non aprirne il controllo.', en: 'You may look at this lot, not open its inspection.' })
  return {
    opens: [],
    starts: [
      {
        target: 'INCOMING',
        kind: 'INCOMING',
        plan: { code: opening.plan.code, number: opening.plan.number, words: null },
        lotSize: opening.lotSize,
        uom: opening.uom,
        sampleSize: opening.sampleSize,
        words: opening.words ?? { it: `Apri il controllo del lotto ${scanned.lot.code}.`, en: `Open the inspection of lot ${scanned.lot.code}.` },
        open: { lotId: found.lotId },
      },
    ],
    nothing: null,
  }
}

/** The inspection of a row as the bench reads its open final inspections. */
interface OpenFinal {
  readonly id: string
  readonly number: string | null
  readonly lotSize: number
  readonly planVersionId: string | null
  readonly inspectorWorkerId: string | null
  readonly inspectorUserId: string | null
  readonly assignedInspectorId: string | null
  readonly assignedInspectorWorkerId: string | null
  readonly version: number
}

const finalRef = (row: OpenFinal, viewer: Viewer): Ref => ({
  recordType: 'Inspection',
  id: row.id,
  kind: 'FINAL',
  number: row.number,
  taken: takenOf({ workerId: row.inspectorWorkerId, userId: row.inspectorUserId }, viewer.person, { workerId: row.assignedInspectorWorkerId, userId: row.assignedInspectorId }),
  version: row.version,
  path: row.planVersionId ? `/quality/inspections/${row.id}/sheet` : `/quality/inspections/${row.id}`,
})

const OPEN_FINAL_SELECT = { id: true, number: true, lotSize: true, planVersionId: true, inspectorWorkerId: true, inspectorUserId: true, assignedInspectorId: true, assignedInspectorWorkerId: true, version: true, status: true } as const

async function finalAnswer(caller: CommandCaller, viewer: Viewer, found: Found, lotSize: number | undefined): Promise<Answer> {
  if (!viewer.views.final) return none({ it: 'Non hai il collaudo finale.', en: 'You do not hold final inspection.' })
  if (found.type === 'INSPECTION') {
    if (found.recordStatus !== 'OPEN') return none({ it: `${found.code} è ${found.recordStatus?.toLowerCase()}: un collaudo firmato o annullato non cambia.`, en: `${found.code} is ${found.recordStatus?.toLowerCase()}: a signed or cancelled inspection never changes.` })
    const row = await caller.withClient((db) => db.inspection.findUnique({ where: { id: found.id }, select: OPEN_FINAL_SELECT }))
    return row ? { opens: [finalRef(row, viewer)], starts: [], nothing: null } : none(unknownCodeWords(found.code))
  }
  const workOrderIds = found.workOrderIds ?? []
  const answers: Answer[] = []
  for (const workOrderId of workOrderIds) answers.push(await workOrderFinal(caller, viewer, workOrderId, lotSize))
  return merge(answers)
}

async function workOrderFinal(caller: CommandCaller, viewer: Viewer, workOrderId: string, lotSize: number | undefined): Promise<Answer> {
  const order = await caller.withClient((db) => db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, companyId: true, siteId: true } }))
  if (!order) return none(unknownCodeWords(workOrderId))
  const open = await caller.withClient((db) => db.inspection.findMany({ where: { workOrderId, status: 'OPEN' }, select: OPEN_FINAL_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
  const refs = open.map((row) => finalRef(row, viewer))
  // B-W2b-213: an inspection a rule opened (nobody's yet) opens like one's own: the scanner takes it, never a second one.
  const mine = refs.filter((ref) => isMine(ref.taken))
  if (mine.length > 0) return { opens: mine, starts: [], nothing: null }
  const bench = (await benchWorkOrders(caller, { number: order.number, limit: 1 })).workOrders.find((row) => row.id === order.id)
  const garments = bench ? garmentsToInspect({ finished: bench.finished, released: bench.released, inOpenInspections: open.reduce((sum, row) => sum + row.lotSize, 0) }) : 0
  if (garments <= 0) {
    const others = refs.length > 0 ? { it: ` Il collaudo aperto (${refs.map((ref) => ref.number).join(', ')}) è di un altro collaudatore.`, en: ` The open inspection (${refs.map((ref) => ref.number).join(', ')}) is another inspector's.` } : { it: '', en: '' }
    const state = bench && !bench.ready && bench.finished !== null && bench.finished <= bench.released
    return none({
      it: `${order.number}: nessun capo finito da collaudare${state ? ' (tutti rilasciati)' : ''}.${others.it}`,
      en: `${order.number}: no finished garment waits for inspection${state ? ' (all released)' : ''}.${others.en}`,
    })
  }
  if (!may(viewer, PERMISSIONS.final.record, order)) return none({ it: 'Puoi vedere questo ordine, non aprirne il collaudo.', en: 'You may look at this work order, not open its inspection.' })
  const size = lotSize !== undefined ? Math.min(lotSize, garments) : garments
  const plans = await workOrderPlans(caller, order.id, { lotSize: size })
  const suggested = plans.plans.find((plan) => plan.id === plans.suggestedId && plan.usable) ?? null
  return {
    opens: [],
    starts: [
      {
        target: 'FINAL',
        kind: 'FINAL',
        plan: suggested?.approved ? { code: suggested.code, number: suggested.approved.number, words: plans.words } : null,
        lotSize: String(size),
        uom: 'PCS',
        sampleSize: plans.sampling?.sampleSize ?? null,
        words: {
          it: `Collaudo di ${order.number}: ${size} ${size === 1 ? 'capo' : 'capi'}${suggested?.approved ? ` sul piano ${suggested.code} v${suggested.approved.number}` : ' con la lista fissa'}.`,
          en: `Final inspection of ${order.number}: ${size} ${size === 1 ? 'garment' : 'garments'}${suggested?.approved ? ` on plan ${suggested.code} v${suggested.approved.number}` : ' on the fixed checklist'}.`,
        },
        open: { workOrderId: order.id, lotSize: size, planId: suggested?.approved ? suggested.id : null },
      },
    ],
    nothing: null,
  }
}

const CHECK_PATH = (id: string) => `/quality/inprocess/checks/${id}`

async function inLineAnswer(caller: CommandCaller, viewer: Viewer, found: Found): Promise<Answer> {
  if (!viewer.views.inprocess) return none({ it: 'Non hai i controlli in linea.', en: 'You do not hold in-process checks.' })
  const workOrderId = found.workOrderIds?.[0]
  if (!workOrderId) return none(unknownCodeWords(found.code))
  const rows = await caller.withClient((db) =>
    db.inProcessCheck.findMany({ where: { status: 'OPEN', ...(found.bundleId ? { bundleId: found.bundleId } : { workOrderId }) }, select: { id: true, kind: true, inspectorWorkerId: true, inspectorUserId: true, version: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  )
  if (rows.length > 0) {
    return { opens: rows.map((row) => ({ recordType: 'InProcessCheck' as const, id: row.id, kind: row.kind as QueueKind, number: null, taken: takenOf({ workerId: row.inspectorWorkerId, userId: row.inspectorUserId }, viewer.person), version: row.version, path: CHECK_PATH(row.id) })), starts: [], nothing: null }
  }
  if (!may(viewer, PERMISSIONS.inprocess.record, found)) return none({ it: 'Puoi vedere questo, non aprirne il controllo.', en: 'You may look at this, not open its check.' })
  const options: StartOption[] = []
  if (found.bundleId) {
    options.push({ target: 'IN_LINE', kind: 'FIRST_PIECE', plan: null, lotSize: null, uom: null, sampleSize: null, words: { it: 'Primo capo di questo fascio a un’operazione (scegli l’operazione).', en: "This bundle's first piece at an operation (pick the operation)." }, open: { check: 'FIRST_PIECE', workOrderId, bundleId: found.bundleId } })
  }
  options.push({ target: 'IN_LINE', kind: 'CUTTING', plan: null, lotSize: null, uom: null, sampleSize: null, words: { it: 'Controllo del taglio di questo ordine.', en: "This work order's cutting inspection." }, open: { check: 'CUTTING', workOrderId, bundleId: found.bundleId ?? null } })
  return { opens: [], starts: options, nothing: null }
}

function merge(answers: readonly Answer[]): Answer {
  const opens = answers.flatMap((answer) => answer.opens)
  const starts = answers.flatMap((answer) => answer.starts)
  return { opens, starts, nothing: opens.length === 0 && starts.length === 0 ? (answers.find((answer) => answer.nothing)?.nothing ?? null) : null }
}

async function answerFor(caller: CommandCaller, viewer: Viewer, found: Found, targets: readonly ScanTarget[], lotSize?: number): Promise<Answer> {
  const answers: Answer[] = []
  for (const target of targets) {
    if (target === 'INCOMING') answers.push(await incomingAnswer(caller, viewer, found))
    else if (target === 'FINAL') answers.push(await finalAnswer(caller, viewer, found, lotSize))
    else answers.push(await inLineAnswer(caller, viewer, found))
  }
  // With no bench named, a bundle's open check or final inspection is the answer before anything to start.
  const merged = merge(answers)
  return merged.opens.length > 0 ? { opens: merged.opens, starts: [], nothing: null } : merged
}

// ---- the answers -------------------------------------------------------------------------------------------------------------------

interface Resolved {
  readonly code: string
  readonly found: Found | null
  readonly outcome: ScanOutcome
  readonly target: ScanTarget | null
  readonly open: Ref | null
  readonly start: StartOption | null
  readonly choices: { readonly target: ScanTarget; readonly kind: QueueKind | null; readonly recordType: QueueRecordType | null; readonly id: string | null; readonly number: string | null; readonly words: Words; readonly start?: StartOption; readonly ref?: Ref }[]
  readonly words: Words
  /** A refusal's code for POST (null when there is something to open). */
  readonly refusal: 'UNKNOWN_CODE' | 'LABEL' | 'OTHER_BENCH' | 'NOTHING_TO_INSPECT' | 'CHOOSE' | null
}

const refWords = (ref: Ref): Words => ({ it: `${ref.number ?? ref.kind} aperto${ref.taken === 'OTHER' ? ' (di un altro collaudatore)' : ''}`, en: `${ref.number ?? ref.kind} open${ref.taken === 'OTHER' ? " (another inspector's)" : ''}` })
const targetOf = (kind: QueueKind): ScanTarget => (kind === 'INCOMING' ? 'INCOMING' : kind === 'FINAL' || kind === 'FINAL_DUE' ? 'FINAL' : 'IN_LINE')

async function resolve(caller: CommandCaller, typed: string, stage: ScanStage | null, options: { readonly kind?: StartableCheck | undefined; readonly lotSize?: number | undefined } = {}): Promise<Resolved> {
  const viewer = viewerOf(caller)
  const { code, found, problem } = await foundFor(caller, viewer, typed.trim())
  const empty = { found: null, target: null, open: null, start: null, choices: [] }
  if (problem) return { code, ...empty, outcome: 'NOTHING', words: problem, refusal: 'LABEL' }
  if (found.length === 0) return { code, ...empty, outcome: 'NOTHING', words: unknownCodeWords(code), refusal: 'UNKNOWN_CODE' }
  // The records the bench takes; a code of another bench only when nothing else fits.
  const fitting = found.map((row) => ({ row, fit: scanTargets(row.type, stage) }))
  const usable = fitting.filter((entry) => entry.fit.ok)
  if (usable.length === 0) {
    const first = fitting[0]!
    return { code, ...empty, found: first.row, outcome: 'NOTHING', words: first.fit.ok ? unknownCodeWords(code) : first.fit.words, refusal: 'OTHER_BENCH' }
  }
  const answers = await Promise.all(usable.map(async (entry) => ({ row: entry.row, answer: await answerFor(caller, viewer, entry.row, entry.fit.ok ? entry.fit.targets : [], options.lotSize) })))
  const opens = answers.flatMap((entry) => entry.answer.opens.map((ref) => ({ row: entry.row, ref })))
  // A check named (FIRST_PIECE, CUTTING) is an in-line start: only that one.
  const starts = answers.flatMap((entry) => entry.answer.starts.map((start) => ({ row: entry.row, start }))).filter((entry) => !options.kind || entry.start.kind === options.kind)
  const head = answers[0]!.row
  if (opens.length === 1) {
    const { row, ref } = opens[0]!
    return { code, found: row, outcome: 'OPEN', target: targetOf(ref.kind), open: ref, start: null, choices: [], words: { it: `${ref.number ?? 'Il controllo'} è aperto: continua da qui.`, en: `${ref.number ?? 'The check'} is open: carry on here.` }, refusal: null }
  }
  if (opens.length > 1) {
    return {
      code,
      found: head,
      outcome: 'CHOOSE',
      target: null,
      open: null,
      start: null,
      choices: opens.map(({ ref }) => ({ target: targetOf(ref.kind), kind: ref.kind, recordType: ref.recordType, id: ref.id, number: ref.number, words: refWords(ref), ref })),
      words: { it: 'Più controlli aperti: scegli quale.', en: 'More than one inspection is open: pick one.' },
      refusal: 'CHOOSE',
    }
  }
  if (starts.length === 1) {
    const { row, start } = starts[0]!
    return { code, found: row, outcome: 'START', target: start.target, open: null, start, choices: [], words: start.words, refusal: null }
  }
  if (starts.length > 1) {
    return {
      code,
      found: head,
      outcome: 'CHOOSE',
      target: null,
      open: null,
      start: null,
      choices: starts.map(({ start }) => ({ target: start.target, kind: start.kind, recordType: null, id: null, number: null, words: start.words, start })),
      words: { it: 'Cosa vuoi controllare? Scegli. Un controllo in linea o di fine linea si registra in un passo.', en: 'What do you inspect? Pick one. A roving or end-of-line check is recorded in one step.' },
      refusal: 'CHOOSE',
    }
  }
  const nothing = answers.find((entry) => entry.answer.nothing)?.answer.nothing ?? unknownCodeWords(code)
  return { code, found: head, outcome: 'NOTHING', target: null, open: null, start: null, choices: [], words: nothing, refusal: 'NOTHING_TO_INSPECT' }
}

const foundOut = (found: Found | null) => (found ? { type: found.type, id: found.id, code: found.code, label: found.label } : null)
const startOut = (start: StartOption | null) => (start ? { target: start.target, kind: start.kind, plan: start.plan, lotSize: start.lotSize, uom: start.uom, sampleSize: start.sampleSize, words: start.words } : null)

/** GET /quality/queue/scan */
export async function resolveScan(caller: CommandCaller, query: { readonly code: string; readonly stage?: ScanStage | undefined }) {
  const resolved = await resolve(caller, query.code, query.stage ?? null)
  return {
    code: resolved.code,
    found: foundOut(resolved.found),
    outcome: resolved.outcome,
    target: resolved.target,
    open: resolved.open,
    start: startOut(resolved.start),
    choices: resolved.choices.map(({ target, kind, recordType, id, number, words }) => ({ target, kind, recordType, id, number, words })),
    words: resolved.words,
  }
}

/** A scan that opens nothing, in words: 404 for a code that names nothing, else 409 `refusal/<CODE>`. */
export class ScanRefusedError extends ConflictError {
  override name = 'ScanRefusedError'
  override readonly issues: readonly Issue[]
  constructor(code: string, words: Words, choices: readonly Issue[] = []) {
    super(words.en)
    this.issues = [{ path: `refusal/${code}`, message: words.en }, ...choices]
  }
}

export interface StartBody {
  readonly code: string
  readonly stage?: ScanStage | undefined
  readonly kind?: StartableCheck | undefined
  readonly workOrderOperationId?: string | undefined
  readonly lotSize?: number | undefined
}

/** POST /quality/queue/scan */
export async function startFromScan(caller: CommandCaller, body: StartBody, idempotencyKey: string | undefined) {
  const resolved = await resolve(caller, body.code, body.stage ?? null, { kind: body.kind, lotSize: body.lotSize })
  if (resolved.outcome === 'OPEN') {
    const open = resolved.open!
    return { outcome: 'OPEN' as const, started: false as const, open, model: await modelOf(caller, open), words: resolved.words }
  }
  if (resolved.outcome !== 'START') {
    if (resolved.refusal === 'UNKNOWN_CODE') throw new NotFoundError(resolved.words.en)
    const choices = resolved.choices.map((choice, index) => ({ path: `choices/${index}/${choice.kind ?? choice.target}`, message: choice.words.en }))
    throw new ScanRefusedError(resolved.refusal ?? 'NOTHING_TO_INSPECT', resolved.words, choices)
  }
  const start = resolved.start!
  const open = start.open
  let ref: Ref
  if ('lotId' in open) {
    const answer = await openIncoming(caller, { lotId: open.lotId }, idempotencyKey)
    const row = answer.inspection
    ref = { recordType: 'IncomingInspection', id: row.id, kind: 'INCOMING', number: row.number, taken: 'MINE', version: row.version, path: `/quality/incoming/${row.id}` }
  } else if ('check' in open) {
    if (open.check === 'FIRST_PIECE' && !body.workOrderOperationId) throw new ValidationError('A first piece is checked at an operation: pick the operation.', [{ path: 'body/workOrderOperationId', message: 'Required for a first piece.' }])
    const answer = await openCheck(caller, { kind: open.check, workOrderId: open.workOrderId, ...(open.bundleId ? { bundleId: open.bundleId } : {}), ...(body.workOrderOperationId ? { workOrderOperationId: body.workOrderOperationId } : {}) }, idempotencyKey)
    ref = { recordType: 'InProcessCheck', id: answer.check.id, kind: answer.check.kind as QueueKind, number: null, taken: 'MINE', version: answer.check.version, path: CHECK_PATH(answer.check.id) }
  } else {
    const answer = await openInspection(caller, { workOrderId: open.workOrderId, lotSize: open.lotSize, ...(open.planId ? { planId: open.planId } : {}) }, idempotencyKey)
    const row = answer.inspection
    ref = { recordType: 'Inspection', id: row.id, kind: 'FINAL', number: row.inspectionNumber, taken: 'MINE', version: row.version, path: row.planVersion ? `/quality/inspections/${row.id}/sheet` : `/quality/inspections/${row.id}` }
  }
  return { outcome: 'STARTED' as const, started: true as const, open: ref, model: await modelOf(caller, ref), words: start.words }
}
