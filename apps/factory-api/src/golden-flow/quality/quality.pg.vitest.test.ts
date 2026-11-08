import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { callerFor, COMMAND_SETTINGS } from '../../core/command'
import { escalationTaskId, reminderTaskId, runCapaReminders } from '../../modules/quality/capa/reminders'
import { runCheckReminders } from '../../modules/plant/statutory/reminders'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import type { Browser } from '../../platform/auth/sessions/testing/harness'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { systemContext } from '../../platform/outbox/system'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { fireTimer } from '../../platform/timers/fire'
import { admin, announce, call, floorWorker, ok, pdf, person, putBytes, QUIET, sha256, signOn, startWorld, stepped, tablet, type FloorWorker, type Person, type World } from '../testing/world'
import { assertEveryHandler, everyHandler, searchIndexers, settler } from '../daily/testing/day'

/**
 * The W2b-2 golden flow (B-W2b-150; design check I5): records that cross quality, stock, production, plant and safety THROUGH THE
 * HTTP ROUTES, each act by the role that does it, on the seeded factory; the flow proves they agree:
 *
 *   L  a lot from the dock to a cut piece: six black hides received against the open rest of SEED-PO-0001 (quarantine, Cr VI
 *      pending); the worker's rule opens the incoming inspection; the lab's result and release; hide by hide (area against the
 *      tannery, shade group, grade, a scar) and the split decision signed (3 accepted, 1 rejected, 2 to sort) with the hold of
 *      the rest from the record's prefill; at the cutting table the same-shade refusal for SEED-WO-0001 and the team leader's
 *      "Cut anyway" with the PIN; the cut log; a hold by genealogy of the lot (the work order ON_HOLD), released by another
 *      inspector.
 *   Q  the line and the end: a first piece on INL-FIRST that holds the run, approved with the PIN; end-of-line checks through the
 *      floor queue and the DHU the line and its TV board read; FIN-JACKET v2 (the photo set) approved by four eyes while
 *      SEED-INS-0009 stays on v1; the AQL sample; SEED-INS-0009 finished (count, batch, a photo) and signed; its result locked,
 *      corrected by a countersigned amendment; its report kept and shared on the shipment that carried the batch; the shipment's
 *      certificate of conformity; then the two shells cut from the new lot made into two jackets (a bundle reported through
 *      cutting, sewing, inspection and packing) and inspected on v2, its AQL sample and its photo set holding the signature.
 *   C  a cut order with a lay: the grey lining of SEED-WO-0002 planned on a marker, released, the roll allocated, the ticket
 *      scanned, the lay spread, counted at both ends and cut, the fabric used confirmed (ONE issue to the work order), reconciled;
 *      the cutting room board and the yield report.
 *   N  an NCR to a CAPA with an action overdue: the cost typed by the owner, the CAPA from the NCR, an action due today, the
 *      reminder cron's reminder and, two days on, its escalation; the CAPA reads it overdue; closed once done.
 *   M  a machine check: the earthing check of the cutting table planned, reminded, FAILED: one command makes the safety job and
 *      locks the table; its report and PDF; a change of status refused while locked; signed safe by maintenance.
 *   S  a safety year: DVR v3 frozen from the consultant's PDF, signed on paper and by the doctor in the office, sealed; a measure
 *      moved by its owner and verified; a new cutter's role sheet fills the training, PPE and health-visit lists, which empty when
 *      the courses, the kit and the doctor's judgement are recorded.
 *   I  an injury reported on the tablet, the injured person opened by HR, the INAIL filing due 48 hours after the certificate,
 *      the reminder of its clock fired, the filing made.
 *   P  every health and injury read refused for a role without it (nothing recorded), and each allowed view recorded and listed.
 *   H  the new W2b-2 reads that name a worker (the lead who signed "Cut anyway", the floor inspector of a first piece and of an
 *      incoming inspection, who measured a hide, who reported an incident) searched in their raw JSON with the PERFORMANCE gate on
 *      and off (Statuto dei Lavoratori art. 4; Owner answer W1), as the people suite does for B-W2b-F3/F4.
 *
 * World: the W1 golden world (../testing/world.ts: a throwaway PostgreSQL 17 database from the migrations, EVERY base seed plus the
 * W1 golden scenario, the real app with the real sign-in, every outside provider FAKE) and the W2a day's worker (../daily/testing/
 * day.ts: EVERY handler list of background.ts, run in-process by the real outbox relay). SQL only reads ids and asserts: no step is
 * made by SQL. Crons (the CAPA reminders, the check reminders) and the INAIL timer run in-process with a clock passed to them;
 * Date is moved only to read the CAPA two days on, and only for reads. Every name and figure is made up. Run with
 * `node scripts/factory/golden-flow.mjs quality`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
const P = {} as Record<'owner' | 'warehouse' | 'inspector' | 'inspector2' | 'manager' | 'planner' | 'supervisor' | 'maintenance' | 'safety' | 'hr' | 'drVerdi', Person>
/** What the flow made, step by step. */
const G = {} as Record<string, any>
/** What the API reported as unexpected (a 500) during the flow: none at the end. */
const unexpected: ErrorReport[] = []
/** Every record the flow made: the end checks look for their audit rows. */
const made = new Set<string>()
const keep = (...ids: (string | undefined | null)[]) => ids.forEach((recordId) => recordId && made.add(recordId))
const id = (key: string) => w.id(key)
/** A seed row written with the seeds' firstId (ids that start with eight zeros: the isolation tests' first rows). */
const first = (key: string) => `00000000${w.id(key).slice(8)}`
const siteA1 = () => id('site:A1')
const companyA = () => id('company:A')
const pathsOf = (error: Json): string[] => ((error?.issues ?? []) as Json[]).map((issue) => String(issue.path))
const today = () => businessDate(new Date())
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

/** The seeded work the flow goes on with: SEED-WO-0001 (IN_PROGRESS, cut so far from SEED-LOT-LEA-01) and its final inspection. */
const S = () => ({
  wo: id('production:work-order:WO-0001'),
  blk52: id('production:WO-0001:cell:BLK:52'),
  opSew: id('production:WO-0001:operation:20'),
  opQc: id('production:WO-0001:operation:30'),
  ins9: id('inspection-plans:inspection:WO-0001'),
})
/** The cut order's work: SEED-WO-0002 (a DRAFT of one BLK 52 whose BOM holds the grey lining) and the lining rolls of SEED-LOT-LIN-01. */
const C = () => ({ wo: first('production:work-order:WO-0002'), cell: first('production:WO-0002:cell:BLK:52'), rl1: first('leather:roll:1'), rl2: id('leather:roll:2') })

/** A file of a record through the real routes: announced, its bytes sent to the presigned URL, completed. */
async function upload(who: Person, owner: { companyId: string; recordType: string; recordId: string }, name: string, body: Buffer): Promise<string> {
  const announced = await ok(who, 'POST', '/files', { ...owner, kind: 'DOCUMENT', ...announce(name, body) }, 201)
  await putBytes(w, announced, body)
  expect((await ok(who, 'POST', `/files/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
  return announced.file.id as string
}

let floorSeq = 0
/** One event of a tablet's queue (POST /floor/sync), with the signed-in worker. */
const floorEvent = (kind: string, payload: Json) => ({ clientEventId: `gf-q-${++floorSeq}-${kind}`.slice(0, 60), seq: floorSeq, kind, occurredAt: new Date().toISOString(), payload })

/** The event types the flow must leave behind (Z1). */
const EVENTS = [
  // L: the lot from the dock to a cut piece
  'inventory.receipt_posted',
  'inspection_trigger.inspection_opened',
  'lot.test_recorded',
  'lot.released',
  'incoming_inspection.recorded',
  'incoming_inspection.decided',
  'inventory.hide_measured',
  'inventory.hide_graded',
  'quality.hold_placed',
  'quality.alert_fired',
  'production.cut_logged',
  'production.cut_overridden',
  'inventory.issued',
  'quality.hold_released',
  // Q: the line's checks and the shipment inspected and certified
  'in_process_check.first_piece',
  'in_process_check.changed',
  'inspection_plan.version_approved',
  'quality.inspection_assigned',
  'final_inspection.recorded',
  'quality.inspection_decided',
  'inspection_amendment.requested',
  'inspection_amendment.answered',
  'inspection_report.made',
  'inspection_report.shared',
  'conformity_certificate.made',
  'conformity_certificate.shared',
  // C: the cut order with a lay
  'workorder.released',
  'cut_order.changed',
  'cut_ticket.changed',
  'lay.changed',
  'cut_consumption.changed',
  'fabric_roll.changed',
  'cut_order.reconciled',
  // N, M: the CAPA and the machine check
  'ncr.created',
  'capa.opened',
  'capa.action_due',
  'capa.action_overdue',
  'machine_check_plan.changed',
  'machine_check.due',
  'machine_check.recorded',
  'maintenance_request.locked',
  'maintenance_job.created',
  'maintenance_request.signed_safe',
  'machine.status_changed',
  // S, I: the safety year and the incident
  'risk_assessment_version.changed',
  'risk_signature.collected',
  'risk_measure.changed',
  'safety_appointment.changed',
  'employee.role_changed',
  'training.recorded',
  'ppe.issued',
  'health_visit.changed',
  'fitness_judgement.changed',
  'incident.reported',
  'inail_filing.changed',
  'timer.fired',
  // H: the gate
  'legal_gate.changed',
]

/** Every worker of A1 and the employee behind them: what no closed read may hold. */
async function namesAndIds(): Promise<string[]> {
  const rows = await admin<{ worker: string; workerName: string; employee: string | null; display: string | null; full: string | null }>(
    w,
    `SELECT w.id::text AS worker, w."displayName" AS "workerName", e.id::text AS employee, e."displayName" AS display, e."firstName" || ' ' || e."lastName" AS full FROM "Worker" w LEFT JOIN "Employee" e ON e.id = w."employeeId" WHERE w."siteId" = $1`,
    [siteA1()],
  )
  return [...new Set(rows.flatMap((row) => [row.worker, row.workerName, row.employee, row.display, row.full]).filter((value): value is string => typeof value === 'string' && value !== ''))]
}

/**
 * The W2b-2 reads that name a floor worker behind the PERFORMANCE gate (B-W2b-F3's rule), each with the flag that says a person
 * is on it; read by the production manager. Out of scope on purpose (they name a worker by design, build notes B-W2b-125/134/97):
 * plant requests and jobs, PPE receipts, training attendance, final inspections and releases, an NCR's finder.
 */
const gatedReads = (): readonly { readonly label: string; readonly url: string; readonly flag: string }[] => [
  { label: 'the lead who signed "Cut anyway" (B-W2b-103)', url: `/production/cutting/work-orders/${S().wo}/cut-log`, flag: 'overrideLeadHidden' },
  { label: 'a first piece checked on the tablet (B-W2b-99)', url: `/quality/inprocess/checks/${G.firstPiece}`, flag: 'workerHidden' },
  { label: 'an incoming inspection of the floor (B-W2b-98)', url: `/quality/incoming/${first('inspection-plans:incoming:1')}`, flag: 'hidden' },
  { label: 'who measured a hide (B-W2b-94)', url: `/inventory/hides/${id('inventory:hide:H1')}/measures`, flag: 'hidden' },
  { label: 'who reported an incident on the tablet (B-W2b-125)', url: `/safety/incidents/${G.incident.id}`, flag: 'hidden' },
]

async function rawRead(url: string): Promise<string> {
  const answer = await call(P.manager.browser, 'GET', url)
  expect(answer.status, `${url}: ${answer.response.body}`).toBe(200)
  return answer.response.body
}

async function gateOpens(): Promise<void> {
  const needles = await namesAndIds()
  for (const { label, url, flag } of gatedReads()) {
    const raw = await rawRead(url)
    expect(needles.filter((needle) => raw.includes(needle)).length, `${label} names somebody with the gate on`).toBeGreaterThan(0)
    expect(raw, label).toContain(`"${flag}":false`)
    expect(raw, label).not.toContain(`"${flag}":true`)
  }
}

async function gateCloses(): Promise<void> {
  const needles = await namesAndIds()
  for (const { label, url, flag } of gatedReads()) {
    const raw = await rawRead(url)
    expect(needles.filter((needle) => raw.includes(needle)).join(', '), label).toBe('')
    expect(raw, `${label} says a person is on it`).toContain(`"${flag}":true`)
  }
}

const gateVersion = async (): Promise<number> => ((await ok(P.owner, 'GET', `/people/privacy/sites/${siteA1()}`)).purposes as Json[]).find((entry) => entry.purpose === 'PERFORMANCE')!.gate.version

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  for (const [key, role] of [
    ['owner', 'owner'],
    ['warehouse', 'warehouse'],
    ['inspector', 'quality_inspector'],
    ['inspector2', 'quality_inspector'],
    ['manager', 'production_manager'],
    ['planner', 'planner'],
    ['supervisor', 'floor_supervisor'],
    ['maintenance', 'maintenance'],
    ['safety', 'safety_officer'],
    ['hr', 'hr'],
    ['drVerdi', 'company_doctor'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  vi.useRealTimers()
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

// One step may take a while on a loaded machine (a step renders PDFs, runs the worker).
describe('the W2b-2 golden flow: a lot from the dock to a cut piece, a shipment inspected and certified, a CAPA, a machine check and a safety year through the HTTP routes', { timeout: 180_000 }, () => {
  it('00 the world: the worker runs every handler list of background.ts; the seeds drain; nothing names a worker yet (PERFORMANCE off at A1)', async () => {
    assertEveryHandler()
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
    expect(((await ok(P.owner, 'GET', `/people/privacy/sites/${siteA1()}`)).purposes as Json[]).some((entry) => entry.purpose === 'PERFORMANCE')).toBe(true)
  })

  it('A01 the supervisor enrols six tablets and six floor workers (a cutter, a team leader, a floor inspector, three operators), each with a badge and a PIN; HR makes the sewing operator an employee', async () => {
    G.tablets = {
      cutter: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:CUT-01'), 'Golden cutting'),
      lead: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:CUT-01'), 'Golden lead'),
      qa: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:SEW-01'), 'Golden line inspection'),
      hurt: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:SEW-02'), 'Golden sewing 2'),
      bench: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:QC-01'), 'Golden inspection bench'),
      pack: await tablet(w, P.supervisor, siteA1(), id('site:A1:station:PACK-01'), 'Golden packing'),
    } as Record<string, Browser>
    G.pins = { cutter: '481537', lead: '592648', qa: '603759', hurt: '714860', bench: '825971', pack: '936082' }
    G.workers = {} as Record<string, FloorWorker>
    for (const [key, name, role] of [
      ['cutter', 'Elia Taglio', 'role:cutting_operator'],
      ['lead', 'Dario Capo', 'role:team_leader'],
      ['qa', 'Greta Controllo', 'role:floor_inspector'],
      ['hurt', 'Ivo Ferito', 'role:operator'],
      ['bench', 'Lia Banco', 'role:operator'],
      ['pack', 'Pia Pacco', 'role:operator'],
    ] as const) {
      const worker = await floorWorker(w, P.supervisor, siteA1(), name, id(role))
      await signOn(G.tablets[key], worker, G.pins[key])
      G.workers[key] = worker
      keep(worker.id)
    }
    G.employees = { hurt: (await ok(P.hr, 'POST', '/people/employees/from-worker', { workerId: G.workers.hurt.id, employeeCode: 'GOLD-Q-01' }, 201)).employee.id }
    keep(G.employees.hurt)
    await settle()
  })

  // ---- L: a lot from the dock to a cut piece ------------------------------------------------------------------------------------

  it('L01 the warehouse receives six black hides of the open rest of SEED-PO-0001 (one dye batch, the Cr VI test pending: quarantine); the worker’s rule opens the incoming inspection', async () => {
    const received = await ok(
      P.warehouse,
      'POST',
      '/inventory/receipts',
      {
        purchaseOrderId: id('link:P2:record'),
        supplierDdtNumber: 'DDT-Q-1',
        supplierDdtDate: today(),
        lines: [{ purchaseOrderLineId: id('supply:PO1:10'), lots: [{ supplierLotRef: 'TAN-Q-BLK', dyeBatch: 'SEED-DB-01', shade: 'Nero 01', hides: Array.from({ length: 6 }, (_, n) => ({ supplierCode: `TQ-${n + 1}`, area: '50.0', grade: 'A', thicknessMm: '1.20' })) }] }],
      },
      201,
    )
    expect(received.receipt).toMatchObject({ status: 'POSTED', purchaseOrder: { status: 'PARTLY_RECEIVED' } })
    const lot = (received.receipt.lines as Json[]).flatMap((line) => line.lots as Json[])[0]!
    expect(lot).toMatchObject({ qualityStatus: 'QUARANTINE', holds: ['CR_VI_TEST'], crViStatus: 'PENDING' })
    const lots = (await ok(P.warehouse, 'GET', `/inventory/receipts/${received.receipt.id}/lots`)).lots as Json[]
    G.lot = lot
    G.hides = (lots.find((entry) => entry.id === lot.id)!.hides as Json[]).map((hide) => ({ id: hide.id, code: hide.code }))
    expect(G.hides).toHaveLength(6)
    keep(received.receipt.id, lot.id, ...G.hides.map((hide: Json) => hide.id))
    await settle()
    const listed = (await ok(P.inspector, 'GET', `/quality/incoming?lotId=${lot.id}&status=OPEN`)).items as Json[]
    expect(listed).toEqual([expect.objectContaining({ plan: expect.objectContaining({ code: 'INC-LEATHER', number: 1 }), inspectorKind: null })])
    G.iin = listed[0]!.id
    keep(G.iin)
    const twice = await ok(P.inspector, 'POST', '/quality/incoming', { lotId: lot.id }, 409)
    expect(twice.error.message).toContain('open incoming inspection already')
  })

  it('L02 the inspector (not the receiver) records the Cr VI result with the lab report and releases the lot (a wrong confirmation code refused)', async () => {
    const base = `/quality/lots/${G.lot.id}`
    let lot = (await ok(P.inspector, 'GET', base)).lot
    expect(lot.receivedById).toBe(P.warehouse.id)
    const report = pdf('Cr VI test report TL-Q-1')
    const announced = await ok(P.inspector, 'POST', `${base}/results/report`, announce('cr6-q.pdf', report), 201)
    await putBytes(w, announced, report)
    const recorded = await ok(P.inspector, 'POST', `${base}/results`, { version: lot.version, test: 'CR_VI', method: 'EN ISO 17075-1', valueMgKg: '1.1', lab: 'Test Lab One (made up)', reportNumber: 'TL-Q-1', testedOn: today(), evidence: 'LOT_REPORT', fileId: announced.file.id }, 201)
    expect(recorded).toMatchObject({ result: { verdict: 'PASS' }, checklist: { ready: true } })
    lot = recorded.lot
    expect(pathsOf((await ok(P.inspector, 'POST', `${base}/release`, { version: lot.version, confirmCode: 'NOT-THE-LOT' }, 400)).error)).toContain('body/confirmCode')
    expect((await ok(P.inspector, 'POST', `${base}/release`, { version: lot.version, confirmCode: lot.code })).lot.qualityStatus).toBe('RELEASED')
    await settle()
  })

  it('L03 hide by hide: the inspector takes the rule’s inspection with the first hide (area against the tannery, shade group, grade), three accepted, one rejected with its scar, one to sort; the second inspector may not write on it', async () => {
    const base = `/quality/incoming/${G.iin}`
    let record = await ok(P.inspector, 'GET', base)
    // ISO 2859-1 on the company's AQL-STD: a lot of 6 hides, code letter A, inspect 5 whole hides; no major or minor accepted.
    expect(record.sampling).toMatchObject({ method: 'AQL', profile: { code: 'AQL-STD' }, words: { en: 'Inspect 5 of 6 hides · 0 done' } })
    expect(record.inspection).toMatchObject({ number: expect.stringMatching(/^IIN-\d{4}-\d{4}$/), lotSize: '6.0000', uom: 'HIDE', sampleSize: 5, codeLetter: 'A', acceptMajor: 0, acceptMinor: 0 })
    const groups = Object.fromEntries((record.choices.shadeGroups as Json[]).map((group) => [group.label, group.id]))
    const grades = Object.fromEntries((record.choices.grades as Json[]).map((grade) => [grade.code, grade.id]))
    const [h0, h1, h2, h3, h4] = G.hides as Json[]
    const put = async (hide: Json, body: Json, who: Person = P.inspector, status = 200) => {
      const answer = await ok(who, 'PUT', `${base}/hides/${hide.id}`, { version: record.inspection.version, ...body }, status)
      if (status === 200) record = answer
      return answer
    }
    await put(h0!, { measuredArea: '49.5', declaredArea: '50', areaUom: 'FT2', shadeGroupId: groups['1'], gradeId: grades['A'], decision: 'ACCEPTED' })
    expect(record).toMatchObject({ yours: true, inspector: { kind: 'OFFICE' } })
    await put(h1!, { shadeGroupId: groups['1'], gradeId: grades['A'], decision: 'ACCEPTED' })
    await put(h2!, { shadeGroupId: groups['1'], gradeId: grades['A'], decision: 'ACCEPTED' })
    await put(h3!, { marks: [{ kind: 'DEFECT', x: 0.41, y: 0.32, code: 'HIDE-SCAR', zone: 'B' }], decision: 'REJECTED', note: 'Scar across the back (made up).' })
    await put(h4!, { decision: 'TO_SORT' })
    expect(record.progress).toMatchObject({ done: 5, remaining: 0, accepted: 3, rejected: 1, toSort: 1 })
    expect(record.inspection.found).toMatchObject({ critical: 0, major: 1 })
    const other = await call(P.inspector2.browser, 'PUT', `${base}/hides/${h4!.id}`, { version: record.inspection.version, decision: 'ACCEPTED' })
    expect(other.status).toBe(403)
  })

  it('L04 the plan’s checks (a shade outside the plan refused); the split decision signed with a fresh code: 3 accepted, 1 rejected, 2 to sort; the hold of what was not accepted placed from the record’s prefill', async () => {
    const base = `/quality/incoming/${G.iin}`
    let record = await ok(P.inspector, 'GET', base)
    const checkOf = (code: string) => (record.checks as Json[]).find((check) => check.code === code)!
    const shade = checkOf('SHADE')
    const thickness = checkOf('THICKNESS')
    const results = (value: string) => ({ version: record.inspection.version, results: [{ planCheckId: shade.id ?? shade.planCheckId, outcome: 'PASS', value }, { planCheckId: thickness.id ?? thickness.planCheckId, outcome: 'PASS', value: '1.25' }] })
    expect(pathsOf((await ok(P.inspector, 'PUT', `${base}/results`, results('9'), 400)).error)).toContain('body/results/0/value')
    record = await ok(P.inspector, 'PUT', `${base}/results`, results('1'))
    expect(record.checksNow.mandatoryMissing).toEqual([])
    const decision = { version: record.inspection.version, accepted: '3', rejected: '1', toSort: '2' }
    const unproved = await call(P.inspector.browser, 'POST', `${base}/decide`, decision)
    expect(unproved.status).toBe(403)
    await stepped(w, P.inspector)
    record = await ok(P.inspector, 'POST', `${base}/decide`, decision)
    expect(record.inspection).toMatchObject({ status: 'DECIDED', computedResult: 'FAIL', overrideReason: null, signatureSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(record.inspection.decision).toMatchObject({ accepted: '3.0000', rejected: '1.0000', toSort: '2.0000' })
    expect(record.next).toMatchObject({ step: 'SORT' })
    // The signature writes what the sample found onto the stock: the accepted hides' grade and shade group.
    const [h0] = G.hides as Json[]
    const graded = await admin<{ grade: string; shade: string }>(w, 'SELECT g.code AS grade, s.label AS shade FROM "Hide" h JOIN "LeatherGrade" g ON g.id = h."gradeId" JOIN "ShadeGroup" s ON s.id = h."shadeGroupId" WHERE h.id = $1', [h0!.id])
    expect(graded).toEqual([{ grade: 'A', shade: '1' }])
    const prefill = record.next.holdPrefill as Json
    expect(prefill).toMatchObject({ subjectType: 'Hide' })
    const held = await ok(P.inspector, 'POST', '/quality/holds', { subjectType: 'Hide', subjectIds: prefill.subjectIds, reasonCode: 'QUALITY_CHECK', reasonNote: prefill.reasonNote, sourceType: 'IncomingInspection', sourceId: G.iin }, 201)
    expect(held.hold).toMatchObject({ status: 'ACTIVE', subjectType: 'Hide', number: expect.stringMatching(/^HLD-/) })
    G.sortHold = held.hold
    keep(held.hold.id)
    await settle()
  })

  it('L05 at the cutting table an accepted hide of the new lot warns for SEED-WO-0001 (cut so far from SEED-LOT-LEA-01): the cut is refused, a held hide refused too', async () => {
    const T = G.tablets.cutter as Browser
    const [h0, , , h3] = G.hides as Json[]
    const card = await ok(T, 'GET', `/production/cutting/hides?code=${encodeURIComponent(h0!.code)}&workOrderId=${S().wo}`)
    const forIt = (card.workOrders as Json[]).find((entry) => entry.id === S().wo || entry.workOrder?.id === S().wo) ?? card.workOrders[0]
    expect(forIt.checks).toMatchObject({ standing: ['SHADE'], passed: [] })
    expect(forIt.checks.warnings).toEqual([expect.objectContaining({ kind: 'SHADE', code: 'SHADE_LOT' })])
    G.cut = { clientEventId: 'q-cut-shell-1', code: h0!.code, lines: [{ workOrderSizeId: S().blk52, parts: [{ part: 'Outer shell', pieces: 1 }] }], area: { area: '2' } }
    const refused = await ok(T, 'POST', `/production/cutting/work-orders/${S().wo}/cuts`, G.cut, 409, { 'idempotency-key': G.cut.clientEventId })
    expect(pathsOf(refused.error)).toEqual(['refusal/CUT_WARNING', 'warnings/SHADE/SHADE_LOT'])
    const held = await ok(T, 'POST', `/production/cutting/work-orders/${S().wo}/cuts`, { ...G.cut, clientEventId: 'q-cut-held-1', code: h3!.code }, 409, { 'idempotency-key': 'q-cut-held-1' })
    expect(pathsOf(held.error)[0]).toBe('refusal/QUALITY_HOLD')
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "CutLog" WHERE "hideId" = ANY($1::uuid[])', [[h0!.id, h3!.id]])).toEqual([{ n: 0 }])
  })

  it('L06 "Cut anyway": the cutter cannot be the lead and "Other" needs words; the team leader signs with the PIN and a reason: the piece is cut, the hide issued, the override written with the entry; the next cut asks nobody', async () => {
    const T = G.tablets.cutter as Browser
    const anyway = (extra: Json = {}) => ({ cut: { ...G.cut, clientEventId: 'q-cut-anyway-1' }, lead: { workerId: G.workers.lead.id, pin: G.pins.lead }, reasonCode: 'CHECKED_BY_EYE', warnings: ['SHADE'], ...extra })
    const post = (body: Json, status: number) => ok(T, 'POST', `/production/cutting/work-orders/${S().wo}/cuts/anyway`, body, status, { 'idempotency-key': body.cut.clientEventId })
    expect(pathsOf((await post(anyway({ lead: { workerId: G.workers.cutter.id, pin: G.pins.cutter } }), 409)).error)[0]).toBe('refusal/LEAD_IS_CUTTER')
    expect(pathsOf((await post(anyway({ reasonCode: 'OTHER' }), 409)).error)[0]).toBe('refusal/LEAD_NOTE_MISSING')
    const cut = await post(anyway(), 201)
    expect(cut.override).toEqual({ overrides: ['SHADE'], reasonCode: 'CHECKED_BY_EYE' })
    expect(cut.cut).toMatchObject({ overrides: ['SHADE'] })
    expect(cut.hide.state).toBe('PARTLY_CUT')
    G.cutEntry = cut.cut
    // The cut issued the hide to the work order: an ISSUE move of the new lot (no office pick, no reservation).
    expect((await admin<{ n: number }>(w, `SELECT count(*)::int AS n FROM "StockMove" WHERE reason = 'ISSUE' AND "lotId" = $1 AND "workOrderId" = $2`, [G.lot.id, S().wo]))[0]!.n).toBeGreaterThan(0)
    const card = await ok(T, 'GET', `/production/cutting/hides?code=${encodeURIComponent(G.cut.code)}&workOrderId=${S().wo}`)
    const forIt = (card.workOrders as Json[]).find((entry) => entry.id === S().wo || entry.workOrder?.id === S().wo) ?? card.workOrders[0]
    expect(forIt.checks).toMatchObject({ standing: [], passed: ['SHADE'] })
    const next = await ok(T, 'POST', `/production/cutting/work-orders/${S().wo}/cuts`, { ...G.cut, clientEventId: 'q-cut-shell-2' }, 201, { 'idempotency-key': 'q-cut-shell-2' })
    expect(next.cut.overrides).toEqual([])
    const overridden = (await admin<{ payload: Json }>(w, `SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'production.cut_overridden'`, [w.tenant.id])).map((row) => row.payload)
    expect(overridden).toEqual([expect.objectContaining({ workOrderId: S().wo, hideId: G.hides[0].id, lotId: G.lot.id, overrides: ['SHADE'], reasonCode: 'CHECKED_BY_EYE' })])
    await settle()
  })

  it('L07 the office reads the cut log: the override and its reason; the lead who signed stays hidden while the PERFORMANCE gate is off', async () => {
    const entries = (await ok(P.manager, 'GET', `/production/cutting/work-orders/${S().wo}/cut-log`)).entries as Json[]
    const entry = entries.find((row) => row.id === G.cutEntry.id)!
    expect(entry).toMatchObject({ overrides: ['SHADE'], overrideLead: null, overrideLeadHidden: true })
    expect(JSON.stringify(entries)).not.toContain(G.workers.lead.id)
  })

  it('L08 a hold by genealogy of the new lot: the shipped branch refused at its key; ONE group holds the lot, the cut hides and SEED-WO-0001 (what the sorting hold covers left as it is); a cut is refused', async () => {
    const tree = await ok(P.inspector, 'GET', `/quality/holds/genealogy?type=Lot&id=${G.lot.id}`)
    const keysOf = (state: string) => (tree.nodes as Json[]).filter((node) => node.hold === state).map((node) => node.key as string)
    const picks = [...keysOf('HOLDABLE'), ...keysOf('HELD'), ...(tree.nodes as Json[]).filter((node) => node.kind === 'CELL').map((node) => node.key as string)]
    const left = keysOf('LEFT')
    const body = { type: 'Lot', id: G.lot.id, reasonCode: 'QUALITY_CHECK', reasonNote: 'A scar found at the incoming inspection: hold what the lot made until the sorting ends (made up).', askQuarantine: true }
    if (left.length > 0) expect(pathsOf((await ok(P.inspector, 'POST', '/quality/holds/genealogy', { ...body, picks: [...picks, ...left] }, 409)).error)).toEqual(left.map((key) => `picks/${key}`))
    const placed = await ok(P.inspector, 'POST', '/quality/holds/genealogy', { ...body, picks }, 201)
    expect(placed.group).toMatchObject({ sourceType: 'Lot', sourceId: G.lot.id })
    const kinds = (placed.holds as Json[]).map((hold) => hold.subjectType)
    expect(kinds).toEqual(expect.arrayContaining(['Lot', 'WorkOrder']))
    expect(new Set(kinds).size).toBe(kinds.length)
    G.genealogy = placed
    keep(placed.group.id, ...(placed.holds as Json[]).map((hold) => hold.id))
    expect((await ok(P.manager, 'GET', `/production/work-orders/${S().wo}`)).workOrder.status).toBe('ON_HOLD')
    const refused = await ok(G.tablets.cutter, 'POST', `/production/cutting/work-orders/${S().wo}/cuts`, { ...G.cut, clientEventId: 'q-cut-onhold' }, 409, { 'idempotency-key': 'q-cut-onhold' })
    expect(pathsOf(refused.error)[0]).toMatch(/^refusal\/(QUALITY_HOLD|WORK_ORDER_ON_HOLD)$/)
    await settle()
  })

  it('L09 the group’s holds released one by one by the second inspector (the placer refused): the work order goes back to work', async () => {
    const { holds } = await ok(P.inspector, 'GET', `/quality/holds?groupId=${G.genealogy.group.id}`)
    const workOrderHold = (holds as Json[]).find((hold) => hold.subjectType === 'WorkOrder')!
    await stepped(w, P.inspector)
    const own = await ok(P.inspector, 'POST', `/quality/holds/${workOrderHold.id}/release`, { version: workOrderHold.version, note: 'Sorting done.', notMakerStatement: true }, 409)
    expect(pathsOf(own.error)).toContain('release/NOT_PLACER')
    for (const hold of (holds as Json[]).filter((entry) => entry.status === 'ACTIVE' && entry.id !== G.sortHold.id)) {
      const current = (await ok(P.inspector2, 'GET', `/quality/holds/${hold.id}`)).hold
      await stepped(w, P.inspector2)
      const freed = await ok(P.inspector2, 'POST', `/quality/holds/${hold.id}/release`, { version: current.version, note: 'The sorting found nothing more on the lot (made up).', notMakerStatement: true })
      expect(freed.hold.status).toBe('RELEASED')
    }
    expect((await ok(P.manager, 'GET', `/production/work-orders/${S().wo}`)).workOrder.status).toBe('IN_PROGRESS')
    await settle()
  })

  // ---- Q: the line's checks and a shipment inspected and certified --------------------------------------------------------------

  it('Q01 the floor inspector scans a bundle of SEED-WO-0001 at the inspection operation: a first piece opens on INL-FIRST and holds the run; deciding before the plan’s checks is refused', async () => {
    const T = G.tablets.qa as Browser
    const choose = await ok(T, 'GET', '/quality/queue/scan?code=SEED-BN-0001&stage=IN_LINE')
    expect(choose).toMatchObject({ outcome: 'CHOOSE', found: { type: 'BUNDLE' } })
    const started = await ok(T, 'POST', '/quality/queue/scan', { code: 'SEED-BN-0001', stage: 'IN_LINE', kind: 'FIRST_PIECE', workOrderOperationId: S().opQc }, 201)
    expect(started).toMatchObject({ outcome: 'STARTED', open: { recordType: 'InProcessCheck', kind: 'FIRST_PIECE' } })
    expect(started.model.check).toMatchObject({ status: 'OPEN', holdsRun: true, plan: { code: 'INL-FIRST' } })
    G.firstPiece = started.open.id
    keep(G.firstPiece)
    const card = await ok(T, 'GET', '/production/scans/card?code=SEED-BN-0002')
    expect(card.firstPiece.heldOperationIds).toContain(S().opQc)
    const check = (await ok(T, 'GET', `/quality/inprocess/checks/${G.firstPiece}`)).check
    const early = await ok(T, 'POST', `/quality/inprocess/checks/${G.firstPiece}/decide`, { version: check.version, outcome: 'APPROVED', pieces: 1 }, 409)
    expect(pathsOf(early.error)).toContain('refusal/PLAN_RESULTS')
  })

  it('Q02 the seam check through the floor queue; the first piece approved with the PIN: the run is free; a second first piece of the same run refused', async () => {
    const T = G.tablets.qa as Browser
    const synced = await ok(T, 'POST', '/floor/sync', { events: [floorEvent('quality.inprocess.results', { checkId: G.firstPiece, results: [{ code: 'SEAM', outcome: 'PASS' }] })] })
    expect(synced.events[0]).toMatchObject({ status: 'accepted' })
    const check = (await ok(T, 'GET', `/quality/inprocess/checks/${G.firstPiece}`)).check
    expect(check.blockers).toEqual([])
    await ok(T, 'POST', '/floor/step-up', { pin: G.pins.qa })
    const decided = (await ok(T, 'POST', `/quality/inprocess/checks/${G.firstPiece}/decide`, { version: check.version, outcome: 'APPROVED', pieces: 1 })).check
    expect(decided).toMatchObject({ status: 'DECIDED', outcome: 'APPROVED', holdsRun: false, signatureSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const again = await ok(T, 'POST', '/quality/queue/scan', { code: 'SEED-BN-0001', stage: 'IN_LINE', kind: 'FIRST_PIECE', workOrderOperationId: S().opQc }, 409)
    expect(pathsOf(again.error)).toContain('refusal/ALREADY_APPROVED')
    await settle()
  })

  it('Q03 two end-of-line checks through the queue (one PASS, one FAIL sent back to sewing): the line’s DHU moves by 3 defects in 40 pieces, and the line’s TV board says the same', async () => {
    const T = G.tablets.qa as Browser
    const before = await ok(P.inspector, 'GET', `/quality/inprocess/dhu?lineId=${id('site:A1:line:L1')}`)
    const synced = await ok(T, 'POST', '/floor/sync', {
      events: [
        floorEvent('quality.inprocess.record', { kind: 'END_OF_LINE', bundleCode: 'SEED-BN-0001', decision: { outcome: 'PASS', pieces: 20 } }),
        floorEvent('quality.inprocess.record', { kind: 'END_OF_LINE', workOrderId: S().wo, bundleId: id('production:bundle:WO-0001:2'), workOrderOperationId: S().opSew, decision: { outcome: 'FAIL', pieces: 20, defectivePieces: 2, defects: 3, defectCodeId: id('holds:defect:STITCH-SKIP') } }),
      ],
    })
    expect(synced.events.map((event: Json) => event.status)).toEqual(['accepted', 'accepted'])
    const after = await ok(P.inspector, 'GET', `/quality/inprocess/dhu?lineId=${id('site:A1:line:L1')}`)
    expect(after.pieces - before.pieces).toBe(40)
    expect(after.defects - before.defects).toBe(3)
    expect(Number(after.dhu)).toBeCloseTo((after.defects * 100) / after.pieces, 1)
    const tv = await ok(P.manager, 'GET', `/production/boards/tv?lineId=${id('site:A1:line:L1')}`)
    expect(tv.quality).toMatchObject({ dhu: after.dhu, defects: after.defects })
    await settle()
  })

  it('Q04 FIN-JACKET v2 adds the photo set; its editor may not approve it, the production manager does (four eyes, a fresh code); the plan of SEED-WO-0001 is now v2', async () => {
    const plan = first('inspection-plans:plan:FIN-JACKET')
    const v2 = first('inspection-plans:version:FIN-JACKET:2')
    const url = `/quality/plans/${plan}/versions/${v2}`
    let version = (await ok(P.inspector, 'GET', url)).version
    const photo = (code: string, it: string, en: string) => ({ code, labelIt: it, labelEn: en, type: 'PHOTO' })
    version = (
      await ok(P.inspector, 'PUT', url, {
        version: version.version,
        changeNote: 'Adds the photo set the customer asks for.',
        checks: [
          { code: 'CE_MARK', labelIt: 'Marcatura CE', labelEn: 'CE marking', type: 'PASS_FAIL', checkClass: 'CRITICAL' },
          { code: 'CHEST', labelIt: 'Mezzo torace', labelEn: 'Chest half', type: 'MEASUREMENT', checkClass: 'MAJOR', nominal: '58', tolerance: '1', uom: 'CM' },
          photo('FRONT', 'Foto fronte', 'Front photo'),
          photo('BACK', 'Foto retro', 'Back photo'),
          photo('LABEL', 'Foto etichetta', 'Label photo'),
        ],
      })
    ).version
    await stepped(w, P.inspector)
    expect(pathsOf((await ok(P.inspector, 'POST', `${url}/approve`, { version: version.version }, 409)).error)).toContain('refusal/EDITOR')
    await stepped(w, P.manager)
    const approved = await ok(P.manager, 'POST', `${url}/approve`, { version: version.version })
    expect(approved.version).toMatchObject({ id: v2, status: 'APPROVED', approvedBy: { id: P.manager.id } })
    const plans = await ok(P.inspector, 'GET', `/quality/final/work-orders/${S().wo}/plans?lotSize=2`)
    expect(JSON.stringify(plans)).toContain(v2)
    await settle()
  })

  it('Q05 SEED-INS-0009 stays on v1 (a version is fixed when an inspection opens); a new final has nothing finished to inspect yet', async () => {
    expect((await ok(P.inspector, 'GET', `/quality/inspections/${S().ins9}`)).inspection.planVersion).toMatchObject({ number: 1 })
    const refused = await ok(P.inspector, 'POST', '/quality/inspections', { workOrderId: S().wo, lotSize: 2, planId: first('inspection-plans:plan:FIN-JACKET') }, 400)
    expect(pathsOf(refused.error)).toContain('body/lotSize')
    const aql = await ok(P.inspector, 'GET', '/quality/aql/calculate?lotSize=480&profileId=' + id('inspection-plans:aql:STD'))
    expect(aql.plan).toMatchObject({ codeLetter: 'H', sampleSize: 50 })
  })

  it('Q06 the inspector takes SEED-INS-0009 and finishes it: a decision without the count and the identity refused; the count, the batch, a photo of the CE mark; PASS signed with a fresh code', async () => {
    const base = `/quality/inspections/${S().ins9}`
    const current = (await ok(P.inspector, 'GET', base)).inspection
    await ok(P.inspector, 'POST', '/quality/inspections/assign', { inspections: [{ id: S().ins9, version: current.version }], assigneeId: P.inspector.id })
    let sheet = await ok(P.inspector, 'GET', `${base}/sheet`)
    expect(sheet.plan).toMatchObject({ code: 'FIN-JACKET', number: 1 })
    await stepped(w, P.inspector)
    expect(pathsOf((await ok(P.inspector, 'POST', `${base}/decide`, { version: sheet.inspection.version, result: 'PASS' }, 400)).error)).toEqual(expect.arrayContaining(['body/identity', 'body/inspected']))
    sheet = await ok(P.inspector, 'POST', `${base}/count`, { version: sheet.inspection.version, inspected: 2 })
    sheet = await ok(P.inspector, 'POST', `${base}/identity`, { version: sheet.inspection.version, add: ['SEED-BT-0001'] })
    expect(sheet.identity).toMatchObject({ mode: 'BATCH', done: true, ok: true })
    const image = Buffer.from('made-up front photo of the golden flow')
    const announced = await ok(P.inspector, 'POST', `${base}/results/${id('inspection-plans:result:final:CE_MARK')}/photos`, { originalName: 'front.jpg', contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha256(image) }, 201)
    expect(announced.file).toMatchObject({ kind: 'PHOTO', status: 'PENDING_UPLOAD' })
    await putBytes(w, announced, image)
    expect((await ok(P.inspector, 'POST', `${base}/results/${id('inspection-plans:result:final:CE_MARK')}/photos/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
    sheet = await ok(P.inspector, 'GET', `${base}/sheet`)
    await stepped(w, P.inspector)
    const decided = (await ok(P.inspector, 'POST', `${base}/decide`, { version: sheet.inspection.version, result: 'PASS' })).inspection
    expect(decided).toMatchObject({ status: 'PASSED', overridden: false, planVersion: { number: 1 }, inspected: 2 })
    keep(S().ins9)
    await settle()
  })

  it('Q07 the result stays locked: a change is refused; a correction is an amendment the second inspector countersigns (not its asker); the report kept again', async () => {
    const base = `/quality/inspections/${S().ins9}`
    const sheet = await ok(P.inspector, 'GET', `${base}/sheet`)
    const locked = await ok(P.inspector, 'POST', `${base}/count`, { version: sheet.inspection.version, inspected: 1 }, 409)
    expect(locked.error.code).toBe('invalid_state')
    const kept = await ok(P.inspector, 'POST', `${base}/reports`, { language: 'en' }, 201)
    expect(kept).toMatchObject({ made: true, report: { version: 1 } })
    const asked = await ok(P.inspector, 'POST', `${base}/amendments`, { field: 'measured', row: { type: 'InspectionMeasurement', id: id('inspection-plans:measure:final:CHEST') }, after: '58.6', reason: 'Read from the wrong tape.' }, 201)
    await stepped(w, P.inspector)
    expect(pathsOf((await ok(P.inspector, 'POST', `/quality/amendments/${asked.amendmentId}/sign`, {}, 409)).error)).toContain('refusal/SAME_PERSON')
    await stepped(w, P.inspector2)
    const signed = await ok(P.inspector2, 'POST', `/quality/amendments/${asked.amendmentId}/sign`, {}, 201)
    expect(JSON.stringify(signed)).toContain('SIGNED')
    const amended = (await ok(P.inspector, 'GET', '/quality/inspections?amended=true')).inspections as Json[]
    expect(amended.map((row) => row.id)).toContain(S().ins9)
    const printed = await call(P.inspector.browser, 'GET', `${base}/report?language=en`)
    expect(printed.status).toBe(200)
    expect(printed.response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    // An amendment's audit rows are the inspection's (the record amended): the request and the countersignature.
    expect((await admin<{ n: number }>(w, `SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordId" = $1 AND "after"::text LIKE $2`, [S().ins9, `%${asked.amendmentId}%`]))[0]!.n).toBeGreaterThanOrEqual(2)
    await settle()
  })

  it('Q08 the report shared on the shipment that carried the batch; its certificate of conformity made and shared; a draft shipment cannot be certified', async () => {
    const base = `/quality/inspections/${S().ins9}`
    const shared = await ok(P.inspector, 'POST', `${base}/reports/share`, { shipmentId: id('shipping:shipment:SH-0001') }, 201)
    expect(shared.shared).toMatchObject({ shipmentNumber: 'SEED-SH-0001' })
    const made = await ok(P.inspector, 'POST', `/quality/shipments/${id('shipping:shipment:SH-0001')}/certificates`, {}, 201)
    expect(made).toMatchObject({ made: true, certificate: { version: 1, createdBy: { id: P.inspector.id } } })
    expect((await ok(P.inspector, 'GET', `/quality/shipments/${id('shipping:shipment:SH-0001')}/certificates`)).ready).toMatchObject({ ok: true, held: [] })
    await ok(P.inspector, 'POST', `/quality/shipments/${id('shipping:shipment:SH-0001')}/certificates/share`, {}, 201)
    const draft = await ok(P.inspector, 'POST', `/quality/shipments/${first('shipping:shipment:SH-0002')}/certificates`, {}, 409)
    expect(pathsOf(draft.error)[0]).toBe('held/NOT_CERTIFIABLE')
    await settle()
  })

  it('Q09 the two shells cut from the new lot become a bundle of two BLK 52 jackets; reported through cutting, sewing, inspection and packing, each at its station: two garments finished', async () => {
    const made = await ok(G.tablets.cutter, 'POST', `/production/bundles/work-orders/${S().wo}/bundles`, { cells: [{ workOrderSizeId: S().blk52, quantities: [2] }], printerId: id('print:printer:A1:LBL') }, 201)
    const bundle = (made.bundles as Json[])[0]!
    expect(bundle).toMatchObject({ quantity: 2 })
    G.bundle = bundle
    keep(bundle.id)
    const { operations } = await ok(G.tablets.cutter, 'GET', `/production/bundles/work-orders/${S().wo}`)
    expect((operations as Json[]).map((operation) => operation.id)).toEqual(expect.arrayContaining([S().opSew, S().opQc]))
    for (const [n, [tablet, operationId]] of ([
      ['cutter', id('production:WO-0001:operation:10')],
      ['hurt', S().opSew],
      ['bench', S().opQc],
      ['pack', id('production:WO-0001:operation:40')],
    ] as const).entries()) {
      const clientScanId = `gf-q-scan-${n + 1}-${bundle.code}`
      const scan = await ok(G.tablets[tablet], 'POST', '/production/scans', { clientScanId, code: bundle.code, workOrderOperationId: operationId, good: 2 }, 201, { 'idempotency-key': clientScanId })
      expect(scan.scan.goodQuantity).toBe(2)
    }
    const wip = await ok(P.manager, 'GET', `/production/scans/work-orders/${S().wo}/wip`)
    expect((wip.cells as Json[]).find((cell) => cell.workOrderSizeId === S().blk52)).toMatchObject({ finished: 2 })
    await settle()
  })

  it('Q10 a new final inspection of the two jackets opens on FIN-JACKET v2 with its AQL sample; the photo set holds the signature until front, back and label are taken; PASS signed', async () => {
    const opened = (await ok(P.inspector2, 'POST', '/quality/inspections', { workOrderId: S().wo, lotSize: 2, planId: first('inspection-plans:plan:FIN-JACKET') }, 201)).inspection
    expect(opened.planVersion).toMatchObject({ code: 'FIN-JACKET', number: 2 })
    expect(opened.plan).toMatchObject({ sampleSize: 2 })
    G.final = opened
    keep(opened.id)
    const base = `/quality/inspections/${opened.id}`
    let sheet = await ok(P.inspector2, 'GET', `${base}/sheet`)
    expect((sheet.photos.slots as Json[]).map((slot) => slot.code)).toEqual(['FRONT', 'BACK', 'LABEL'])
    sheet = await ok(P.inspector2, 'PUT', `${base}/results`, {
      version: sheet.inspection.version,
      results: [
        { checkCode: 'CE_MARK', sampleIndex: 1, outcome: 'PASS' },
        { checkCode: 'CE_MARK', sampleIndex: 2, outcome: 'PASS' },
        { checkCode: 'FRONT', outcome: 'PASS' },
        { checkCode: 'BACK', outcome: 'PASS' },
        { checkCode: 'LABEL', outcome: 'PASS' },
      ],
    })
    sheet = await ok(P.inspector2, 'PUT', `${base}/measurements`, { version: sheet.inspection.version, measurements: [{ checkCode: 'CHEST', size: '52', sampleIndex: 1, measured: '58.2' }, { checkCode: 'CHEST', size: '52', sampleIndex: 2, measured: '57.8' }] })
    sheet = await ok(P.inspector2, 'POST', `${base}/count`, { version: sheet.inspection.version, inspected: 2 })
    sheet = await ok(P.inspector2, 'POST', `${base}/identity`, { version: sheet.inspection.version, add: ['SEED-BT-0001'] })
    expect(sheet.photos.waiting).toEqual(['Front photo', 'Back photo', 'Label photo'])
    await stepped(w, P.inspector2)
    const early = await call(P.inspector2.browser, 'POST', `${base}/decide`, { version: sheet.inspection.version, result: 'PASS' })
    expect(early.status).toBe(400)
    expect(pathsOf(early.body.error)).toEqual(['body/photos'])
    for (const code of ['FRONT', 'BACK', 'LABEL']) {
      const resultId = (sheet.checks as Json[]).find((check) => check.code === code)!.results[0].id
      const image = Buffer.from(`made-up ${code} photo of the golden flow`)
      const url = `${base}/results/${resultId}/photos`
      const announced = await ok(P.inspector2, 'POST', url, { originalName: `${code.toLowerCase()}.jpg`, contentType: 'image/jpeg', sizeBytes: image.length, sha256: sha256(image) }, 201)
      await putBytes(w, announced, image)
      await ok(P.inspector2, 'POST', `${url}/${announced.file.id}/complete`)
    }
    sheet = await ok(P.inspector2, 'GET', `${base}/sheet`)
    expect(sheet.photos).toMatchObject({ waiting: [], mandatoryMissing: [] })
    await stepped(w, P.inspector2)
    const decided = (await ok(P.inspector2, 'POST', `${base}/decide`, { version: sheet.inspection.version, result: 'PASS' })).inspection
    expect(decided).toMatchObject({ status: 'PASSED', planVersion: { number: 2 }, inspected: 2 })
    await settle()
  })

  // ---- C: a cut order with a lay (the grey lining of SEED-WO-0002) -----------------------------------------------------------

  it('C01 the planner releases SEED-WO-0002 (a cut order on the DRAFT refused) and plans ONE fabric cut order for its lining: marker, one ply, one lay; the same cell again refused', async () => {
    // Today's board and yield before the cut order: the seeds' cutting room is dated, so C05 counts what this flow adds.
    G.boardBefore = await ok(P.planner, 'GET', `/production/cutboard?siteId=${siteA1()}&date=${today()}`)
    G.yieldBefore = await ok(P.planner, 'GET', `/production/cutboard/yield?siteId=${siteA1()}&from=${today()}&to=${today()}`)
    const plan = { siteId: siteA1(), kind: 'FABRIC', itemId: id('product:item:lining'), itemColourId: id('product:item-colour:lining:GRY'), stationId: id('site:A1:station:CUT-01'), dueDate: today(), marker: { name: 'MK-GF-1', length: '1.8', uom: 'M', widthCm: '140' }, plies: 1, lays: [1], lines: [{ workOrderSizeId: C().cell, ratio: 1 }] }
    expect(pathsOf((await ok(P.planner, 'POST', '/production/cut-orders', plan, 409)).error)).toContain('refusal/WORK_ORDER_NOT_OPEN')
    const check = await ok(P.planner, 'GET', `/production/work-orders/${C().wo}/release-check`)
    const released = (await ok(P.planner, 'POST', `/production/work-orders/${C().wo}/release`, { version: check.workOrder?.version ?? check.version, ...(check.releasable ? {} : { materialOverride: { reason: 'The lining is cut first; the leather follows with the next delivery.' } }) })).workOrder
    expect(released.status).toBe('RELEASED')
    const waiting = await ok(P.planner, 'GET', `/production/cut-orders/waiting?siteId=${siteA1()}&itemId=${id('product:item:lining')}&itemColourId=${id('product:item-colour:lining:GRY')}`)
    expect(JSON.stringify(waiting)).toContain('SEED-WO-0002')
    const planned = (await ok(P.planner, 'POST', '/production/cut-orders', plan, 201)).cutOrder
    expect(planned).toMatchObject({ kind: 'FABRIC', status: 'PLANNED', garments: 1, plies: 1, number: expect.stringMatching(/^CO-\d{4}-\d{4}$/) })
    expect(planned.marker).toMatchObject({ length: '1.8000', uom: 'M', garmentsPerPly: 1 })
    const full = await ok(P.planner, 'POST', '/production/cut-orders', plan, 409)
    expect(pathsOf(full.error)).toContain('refusal/CELL_FULL')
    G.cutOrder = planned
    keep(planned.id, C().wo)
    await settle()
  })

  it('C02 released: its ticket numbered; the planner allocates the untouched lining roll to the lay (rolls of two shades, more plies than planned refused)', async () => {
    const base = `/production/cut-orders/${G.cutOrder.id}`
    const released = await ok(P.planner, 'POST', `${base}/release`, { version: G.cutOrder.version })
    expect(released.cutOrder.status).toBe('RELEASED')
    G.lay = released.lays[0]
    G.ticket = released.tickets[0]
    expect(G.ticket).toMatchObject({ status: 'OPEN', number: expect.stringMatching(/^CTA-\d{4}-\d{5}$/) })
    const rolls = (await ok(P.planner, 'GET', `${base}/rolls`)).rolls as Json[]
    expect(rolls.map((roll) => roll.code ?? roll.roll?.code)).toEqual(expect.arrayContaining(['SEED-RL-0001', 'SEED-RL-0002']))
    const allocate = (body: Json, status: number) => ok(P.planner, 'POST', `${base}/lays/${G.lay.id}/rolls`, { version: G.lay.version, ...body }, status)
    expect(pathsOf((await allocate({ rolls: [{ rollId: C().rl1, plies: 1 }, { rollId: C().rl2, plies: 1 }] }, 409)).error)).toContain('refusal/MIXED_SHADE')
    expect(pathsOf((await allocate({ rolls: [{ rollId: C().rl1, plies: 2 }] }, 409)).error)).toContain('refusal/LAY_FULL')
    const allocated = await allocate({ rolls: [{ rollId: C().rl1, plies: 1 }] }, 201)
    expect(allocated.allocation).toMatchObject({ layId: G.lay.id, allocated: 1 })
    keep(G.lay.id, G.ticket.id)
    await settle()
  })

  it('C03 at the table: the ticket scanned (a recut ticket refused), started; the lay spread from the roll (a roll of another shade refused), both ends counted (a miscount refused), cut', async () => {
    const T = G.tablets.cutter as Browser
    const code = G.ticket.code ?? G.ticket.number
    const card = await ok(T, 'GET', `/production/cut-tickets/scan?code=${encodeURIComponent(String(code).toLowerCase())}`)
    expect(card.next).toMatchObject({ next: 'START', refusal: null })
    expect(card.lay).toMatchObject({ seq: 1, plies: 1, status: 'PLANNED' })
    expect(pathsOf((await ok(T, 'GET', '/production/cut-tickets/scan?code=SEED-CT-0001', undefined, 409)).error)).toContain('refusal/TICKET_IS_RECUT')
    expect(pathsOf((await ok(T, 'POST', `/production/lays/${G.lay.id}/spread`, {}, 409)).error)).toContain('refusal/TICKET_NOT_STARTED')
    const started = await ok(T, 'POST', '/production/cut-tickets/start', { code })
    expect(started).toMatchObject({ ticket: { status: 'STARTED' }, cutOrder: { status: 'IN_PROGRESS' } })
    expect(pathsOf((await ok(T, 'POST', '/production/cut-tickets/finish', { code }, 409)).error)).toContain('refusal/PLIES_NOT_COUNTED')
    const spread = await ok(T, 'POST', `/production/lays/${G.lay.id}/spread`, {})
    expect(spread).toMatchObject({ lay: { status: 'SPREADING' }, spread: { plies: 1, rolls: 1 } })
    expect(pathsOf((await ok(T, 'POST', `/production/lays/${G.lay.id}/rolls`, { code: 'SEED-RL-0002', plies: 1 }, 409)).error)).toContain('refusal/MIXED_SHADE')
    await ok(T, 'POST', `/production/lays/${G.lay.id}/rolls`, { code: 'SEED-RL-0001' }, 201)
    const differ = await ok(T, 'POST', `/production/lays/${G.lay.id}/count`, { left: 1, right: 2 }, 409)
    expect(pathsOf(differ.error)).toContain('refusal/PLIES_DIFFER')
    expect((await ok(T, 'POST', `/production/lays/${G.lay.id}/count`, { left: 1, right: 1 })).lay).toMatchObject({ status: 'CHECKED' })
    const finished = await ok(T, 'POST', '/production/cut-tickets/finish', { code })
    expect(finished).toMatchObject({ ticket: { status: 'DONE' }, lay: { status: 'CUT' }, cutOrder: { status: 'CUT' } })
    await settle()
  })

  it('C04 nothing reconciles before the fabric is confirmed; the cutter confirms the fabric used: ONE issue of 1.8 m from the roll to the work order, the roll left at 58.2 m', async () => {
    const base = `/production/cut-orders/${G.cutOrder.id}`
    const early = await ok(P.planner, 'GET', `${base}/reconciliation`)
    expect(early.refusal).toMatchObject({ code: 'FABRIC_NOT_CONFIRMED' })
    expect((await ok(G.tablets.cutter, 'GET', `/production/lays/${G.lay.id}`)).fabricUsed).toMatchObject({ posted: false, estimated: '1.8000' })
    const used = await ok(G.tablets.cutter, 'POST', `/production/lays/${G.lay.id}/fabric-used`, {})
    expect(used.fabricUsed).toMatchObject({ posted: true, confirmed: '1.8000' })
    await settle()
    const moves = await admin(w, `SELECT "workOrderId"::text AS "workOrderId", quantity::text AS quantity, "lotId"::text AS "lotId" FROM "StockMove" WHERE reason = 'ISSUE' AND "idempotencyKey" LIKE $1`, [`lay-fabric:${G.lay.id}:%`])
    expect(moves).toEqual([{ workOrderId: C().wo, quantity: '1.8000', lotId: id('inventory:lot:LIN-01') }])
    expect(await admin(w, 'SELECT "lengthLeft"::text AS "lengthLeft", state::text AS state FROM "FabricRoll" WHERE id = $1', [C().rl1])).toEqual([{ lengthLeft: '58.2000', state: 'PARTIAL' }])
    expect((await ok(P.planner, 'GET', `/production/work-orders/${C().wo}`)).workOrder.status).toBe('IN_PROGRESS')
  })

  it('C05 the planner reconciles the cut order (1 ordered, 1 cut, 1.8 m estimated, used and issued); the cutting room board and the yield report agree; a reader without the cutting room is refused the board', async () => {
    const base = `/production/cut-orders/${G.cutOrder.id}`
    const preview = await ok(P.planner, 'GET', `${base}/reconciliation`)
    expect(preview.refusal).toBeNull()
    expect(preview.garments).toMatchObject({ ordered: 1, cut: 1 })
    expect(preview.material.sum).toMatchObject({ estimated: '1.8000', used: '1.8000', issued: '1.8000' })
    const reconciled = (await ok(P.planner, 'POST', `${base}/reconcile`, { version: preview.cutOrder.version })).cutOrder
    expect(reconciled.status).toBe('RECONCILED')
    expect(pathsOf((await ok(P.planner, 'POST', `${base}/reconcile`, { version: reconciled.version }, 409)).error)).toContain('refusal/NOT_CUT')
    await settle()
    // The board and the report count what the table did: one cut order, one lay, 1.8 m estimated and used.
    const added = (after: Json, before: Json, keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, Math.round((Number(after[key]) - Number(before[key])) * 10_000) / 10_000]))
    const board = await ok(P.planner, 'GET', `/production/cutboard?siteId=${siteA1()}&date=${today()}`)
    expect(added(board.cut, G.boardBefore.cut, ['cutOrders', 'lays'])).toEqual({ cutOrders: 1, lays: 1 })
    expect(added(board.fabric, G.boardBefore.fabric, ['lays', 'confirmed', 'estimated', 'used'])).toEqual({ lays: 1, confirmed: 1, estimated: 1.8, used: 1.8 })
    const report = await ok(P.planner, 'GET', `/production/cutboard/yield?siteId=${siteA1()}&from=${today()}&to=${today()}`)
    expect(added(report.cut, G.yieldBefore.cut, ['orders', 'ordered', 'cut', 'difference'])).toEqual({ orders: 1, ordered: 1, cut: 1, difference: 0 })
    expect((report.orders as Json[]).find((row) => row.id === G.cutOrder.id || row.number === G.cutOrder.number)).toMatchObject({ kind: 'FABRIC', status: 'RECONCILED', reconciled: true })
    expect(added(report.fabric, G.yieldBefore.fabric, ['lays', 'estimated', 'used'])).toEqual({ lays: 1, estimated: 1.8, used: 1.8 })
    await ok(P.inspector, 'GET', `/production/cutboard?siteId=${siteA1()}&date=${today()}`, undefined, 403)
    await ok(P.inspector, 'GET', `/production/cutboard/yield?siteId=${siteA1()}&from=${today()}&to=${today()}`)
  })

  // ---- N: an NCR to a CAPA with an action overdue -------------------------------------------------------------------------------

  it('N01 the inspector raises an NCR; the owner types its cost (the inspector may not read it)', async () => {
    const raised = await ok(P.inspector, 'POST', '/quality/ncr', { siteId: siteA1(), title: 'Grain crack repeats on the butt', quantityAffected: '2', uom: 'PCS', severity: 'MAJOR', foundAt: 'FINAL' }, 201)
    G.ncr = raised.record.ncr
    expect(G.ncr).toMatchObject({ stage: 'OPEN', number: expect.stringMatching(/^NCR-\d{4}-\d{4}$/) })
    keep(G.ncr.id)
    const cost = await ok(P.owner, 'POST', `/quality/ncr/${G.ncr.id}/cost/lines`, { kind: 'FREIGHT', description: 'Courier of the jacket back (made-up)', amount: 1500 }, 201)
    expect(cost.sheet).toMatchObject({ total: 1500, lines: [expect.objectContaining({ kind: 'FREIGHT', source: 'TYPED', amount: 1500 })] })
    expect((await ok(P.owner, 'POST', `/quality/ncr/${G.ncr.id}/cost/compute`, {})).sheet.computed).toMatchObject({ upToDate: true })
    await ok(P.inspector, 'GET', `/quality/ncr/${G.ncr.id}/cost`, undefined, 403)
    await settle()
  })

  it('N02 a CAPA from it, owned by the production manager; an NCR already escalated to an 8D is refused as a second source', async () => {
    const seededNcr = first('holds:ncr:NCR-0001')
    const preview = await ok(P.inspector, 'GET', `/quality/capa/escalate?recordType=Nonconformance&ids=${G.ncr.id},${seededNcr}`)
    expect(preview.ready).toBe(false)
    expect((preview.records as Json[]).find((row) => row.id === seededNcr || row.recordId === seededNcr)?.problem?.path).toBe('held/ESCALATED_ELSEWHERE')
    const opened = await ok(
      P.inspector,
      'POST',
      '/quality/capa',
      { type: 'CAPA', title: 'Grain cracks keep coming back', dueOn: addDays(today(), 30), priority: 'HIGH', ownerId: P.manager.id, team: [{ userId: P.inspector.id, role: 'Quality' }], problemWhat: 'Grain cracks across the butt', sources: [{ recordType: 'Nonconformance', recordId: G.ncr.id, note: 'Repeat' }] },
      201,
    )
    G.capa = opened.record.capa
    expect(G.capa).toMatchObject({ type: 'CAPA', status: 'PLAN', number: expect.stringMatching(/^CAPA-\d{4}-\d{4}$/), ownerId: P.manager.id })
    keep(G.capa.id)
    expect((await ok(P.inspector, 'GET', `/quality/ncr/${G.ncr.id}`)).record.ncr.capa).toMatchObject({ number: G.capa.number })
    const twice = await ok(P.inspector, 'POST', `/quality/capa/${G.capa.id}/sources`, { sources: [{ recordType: 'Nonconformance', recordId: seededNcr }] }, 409)
    expect(pathsOf(twice.error)[0]).toBe('held/ESCALATED_ELSEWHERE')
    await settle()
  })

  it('N03 a corrective action due today (a day already past refused); the reminder cron reminds its owner, and two days on escalates it overdue to the owner and the inspectors', async () => {
    const base = `/quality/capa/${G.capa.id}`
    const action = { kind: 'CORRECTIVE', description: 'Check every hide under the light table', ownerId: P.manager.id, dueOn: today() }
    expect(pathsOf((await ok(P.inspector, 'POST', `${base}/actions`, { ...action, dueOn: addDays(today(), -1) }, 400)).error)).toContain('body/dueOn')
    const added = await ok(P.inspector, 'POST', `${base}/actions`, action, 201)
    G.actionId = added.actionId
    expect(added.record.actions[0]).toMatchObject({ seq: 1, status: 'OPEN', overdue: false, remindersSent: 0 })
    const at = (days: number) => ({ now: () => new Date(businessDayStart(addDays(today(), days)).getTime() + 60_000) })
    await runCapaReminders({ database: w.h.database, log: QUIET, clock: at(1) })
    const tasks = await admin(w, 'SELECT id::text, "assigneeId"::text AS "assigneeId", title FROM "Task" WHERE id = $1', [reminderTaskId(G.actionId, 1)])
    expect(tasks).toEqual([expect.objectContaining({ assigneeId: P.manager.id, title: expect.stringMatching(/CAPA-/) })])
    await runCapaReminders({ database: w.h.database, log: QUIET, clock: at(2) })
    const [escalated] = await admin<{ escalatedAt: Date | null }>(w, 'SELECT "escalatedAt" FROM "CapaAction" WHERE id = $1', [G.actionId])
    expect(escalated!.escalatedAt).not.toBeNull()
    const overdue = (await admin<{ payload: Json }>(w, `SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'capa.action_overdue'`, [w.tenant.id])).map((row) => row.payload).filter((payload) => payload.actionId === G.actionId)
    expect(overdue).toEqual([expect.objectContaining({ seq: 1, dueOn: today() })])
    for (const who of [P.manager, P.inspector]) {
      expect(await admin(w, 'SELECT count(*)::int AS n FROM "Task" WHERE id = $1', [escalationTaskId(G.actionId, who.id)])).toEqual([{ n: 1 }])
    }
    await settle()
    const bell = (await ok(P.inspector, 'GET', '/notifications?tab=ASSIGNMENT')).items as Json[]
    expect(bell.some((item) => item.record?.type === 'Capa' && item.record?.id === G.capa.id)).toBe(true)
  })

  it('N04 two days on, the CAPA reads the action overdue (list, record, tiles); closing with it open is refused; done, then closed', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(businessDayStart(addDays(today(), 2)).getTime() + 3_600_000) })
    try {
      const record = (await ok(P.inspector, 'GET', `/quality/capa/${G.capa.id}`)).record
      expect(record.actions.find((entry: Json) => entry.id === G.actionId || entry.seq === 1)).toMatchObject({ overdue: true })
      expect((await ok(P.inspector, 'GET', '/quality/capa?view=overdue')).capas.map((capa: Json) => capa.id)).toContain(G.capa.id)
      expect((await ok(P.inspector, 'GET', '/quality/capa/counts')).tiles.actionsOverdue).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
    const base = `/quality/capa/${G.capa.id}`
    let capa = (await ok(P.inspector, 'GET', base)).record.capa
    for (const to of ['ACT', 'CHECK']) capa = (await ok(P.inspector, 'POST', `${base}/stage`, { version: capa.version, to })).record.capa
    const held = await ok(P.inspector, 'POST', `${base}/close`, { version: capa.version, note: 'No crack in the next ten lots.' }, 409)
    expect(pathsOf(held.error)).toEqual(expect.arrayContaining(['held/ACTIONS_OPEN']))
    const action = (await ok(P.manager, 'GET', base)).record.actions.find((entry: Json) => entry.seq === 1)
    await ok(P.manager, 'POST', `${base}/actions/${G.actionId}/done`, { version: action.version, evidenceNote: 'Every hide of the last three lots checked under the light table (made-up).' })
    capa = (await ok(P.inspector, 'GET', base)).record.capa
    expect((await ok(P.inspector, 'POST', `${base}/close`, { version: capa.version, note: 'No crack in the next ten lots.' })).record.capa.status).toBe('CLOSED')
    await settle()
  })

  // ---- M: a machine check that fails and locks the machine -------------------------------------------------------------------

  it('M01 the production manager plans the earthing check of the cutting table (a second plan, a check of another class refused); the reminder cron tells it when its window opens', async () => {
    const machine = id('plant:machine:SEED-CT-01')
    const earthing = id('plantcare:check-type:EARTHING')
    const plan = await ok(P.manager, 'POST', '/plant/checks/plans', { machineId: machine, checkTypeId: earthing, firstDueOn: addDays(today(), 40), reminderDays: 30, ownerId: P.maintenance.id }, 201)
    expect(plan.plan).toMatchObject({ interval: 2, intervalUnit: 'YEAR', nextDueOn: addDays(today(), 40), status: 'ACTIVE', machine: { locked: false } })
    G.checkPlan = plan.plan
    keep(plan.plan.id)
    expect(pathsOf((await ok(P.manager, 'POST', '/plant/checks/plans', { machineId: machine, checkTypeId: earthing, firstDueOn: today() }, 409)).error)[0]).toBe('refusal/PLAN_EXISTS')
    expect(pathsOf((await ok(P.manager, 'POST', '/plant/checks/plans', { machineId: machine, checkTypeId: first('plantcare:check-type:PRESS_GUARDS'), firstDueOn: today() }, 409)).error)[0]).toBe('refusal/TYPE_OTHER_CLASS')
    const due = async () => (await admin<{ payload: Json }>(w, `SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'machine_check.due' AND subject = $2`, [w.tenant.id, G.checkPlan.id])).length
    await runCheckReminders({ database: w.h.database, log: QUIET, clock: { now: () => new Date() } })
    expect(await due()).toBe(0)
    await runCheckReminders({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 11 * 86_400_000) } })
    expect(await due()).toBe(1)
    expect((await ok(P.manager, 'GET', `/plant/checks/plans/${G.checkPlan.id}`)).plan.lastRemindedAt).not.toBeNull()
    await settle()
  })

  it('M02 the outside body’s check FAILS: ONE command records it, makes the safety job for maintenance and locks the table DO_NOT_USE; a second job and a second lock are refused', async () => {
    const failed = await ok(
      P.manager,
      'POST',
      '/plant/checks/results',
      { planId: G.checkPlan.id, performedOn: today(), outcome: 'FAILED', remarks: 'Earth continuity out of limits (made-up).', performedBy: 'Made-up Verifiche S.r.l.', job: { assigneeId: P.maintenance.id }, lock: { note: 'Tag hung on the table' } },
      201,
    )
    expect(failed.result).toMatchObject({ outcome: 'FAILED' })
    expect(failed.job).toMatchObject({ source: 'STATUTORY_CHECK', type: 'SAFETY', number: expect.stringMatching(/^MJ-\d{4}-\d{4}$/) })
    expect(failed.lock).toMatchObject({ unsafe: true })
    expect(failed.machine).toMatchObject({ status: 'DO_NOT_USE', locked: true })
    G.checkResult = failed.result
    G.lock = failed.lock
    keep(failed.result.id, failed.job.id, failed.lock.id)
    expect(pathsOf((await ok(P.manager, 'POST', `/plant/checks/results/${failed.result.id}/job`, {}, 409)).error)[0]).toBe('refusal/JOB_EXISTS')
    expect(pathsOf((await ok(P.manager, 'POST', `/plant/checks/results/${failed.result.id}/lock`, {}, 409)).error)[0]).toBe('refusal/LOCKED_ALREADY')
    await settle()
    // A1's plant rules ask a hazard report on a lock: the safety register gets it from the worker (plant → safety).
    expect(await admin(w, `SELECT kind::text AS kind FROM "Incident" WHERE "maintenanceRequestId" = $1`, [G.lock.id])).toEqual([{ kind: 'HAZARD' }])
  })

  it('M03 the outside body’s report filed with the result; the result’s PDF printed and kept once', async () => {
    const base = `/plant/checks/results/${G.checkResult.id}`
    const body = pdf('Earthing check report (made-up)')
    const announced = await ok(P.manager, 'POST', `${base}/reports`, { kind: 'DOCUMENT', ...announce('earthing.pdf', body) }, 201)
    await putBytes(w, announced, body)
    expect((await ok(P.manager, 'POST', `${base}/reports/${announced.file.id}/complete`)).file).toMatchObject({ status: 'AVAILABLE', recordType: 'MachineCheckResult' })
    expect((await ok(P.manager, 'GET', base)).result.reportOnFile).toBe(true)
    const printed = await call(P.manager.browser, 'GET', `${base}/pdf?language=it`)
    expect(printed.status).toBe(200)
    expect(printed.response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect(await ok(P.manager, 'POST', `${base}/pdf`, { language: 'it' }, 201)).toMatchObject({ made: true })
    expect(await ok(P.manager, 'POST', `${base}/pdf`, { language: 'it' }, 201)).toMatchObject({ made: false })
  })

  it('M04 the locked table: a change of status refused in words; maintenance signs it safe with a fresh code (the manager may not); then the status changes', async () => {
    const machine = id('plant:machine:SEED-CT-01')
    let card = (await ok(P.manager, 'GET', `/plant/machines/${machine}`)).card.machine
    expect(card).toMatchObject({ status: 'DO_NOT_USE', locked: true })
    expect(pathsOf((await ok(P.manager, 'POST', `/plant/machines/${machine}/status`, { version: card.version, to: 'RUNNING', reason: 'Try to free it (made-up)' }, 409)).error)).toContain('refusal/LOCKED_UNSAFE')
    const { request } = await ok(P.maintenance, 'GET', `/plant/requests/${G.lock.id}`)
    await ok(P.manager, 'POST', `/plant/requests/${G.lock.id}/sign-safe`, { version: request.version, note: 'Not mine to sign.' }, 403)
    await stepped(w, P.maintenance)
    const safe = await ok(P.maintenance, 'POST', `/plant/requests/${G.lock.id}/sign-safe`, { version: request.version, note: 'Earth continuity re-measured within limits (made-up).' })
    expect(safe.machine).toMatchObject({ status: 'RUNNING', locked: false })
    expect(safe.request.signedSafe.by).toMatchObject({ kind: 'USER', id: P.maintenance.id })
    card = (await ok(P.manager, 'GET', `/plant/machines/${machine}`)).card.machine
    const changed = await ok(P.manager, 'POST', `/plant/machines/${machine}/status`, { version: card.version, to: 'UNDER_MAINTENANCE', reason: 'Earthing cable replaced (made-up)' })
    expect(changed.machine.status).toBe('UNDER_MAINTENANCE')
    await settle()
  })

  // ---- S: a safety year: the DVR, a role sheet that fills three lists --------------------------------------------------------

  it('S01 the safety officer cannot freeze while v2 waits; v2 withdrawn, the occupational doctor named at A1, v3 frozen from the consultant’s PDF', async () => {
    const assessment = first('safety:dvr:A1')
    const record = await ok(P.safety, 'GET', `/safety/risk/assessments/${assessment}`)
    const waiting = (record.versions as Json[]).find((version) => version.status === 'AWAITING_SIGNATURES')!
    expect(waiting).toMatchObject({ label: expect.any(String), missing: expect.arrayContaining(['RSPP', 'DOCTOR']) })
    const body = pdf('DVR A1 v3, noise survey of the cutting hall')
    const fileId = await upload(P.safety, { companyId: companyA(), recordType: 'RiskAssessment', recordId: assessment }, 'dvr-a1-v3.pdf', body)
    const freeze = { fileId, label: 'v3', effectiveOn: addDays(today(), 7), authorKind: 'CONSULTANT', authorName: 'Seed Safety Consultancy (made-up)', changeSummary: 'Noise survey of the cutting hall (made-up).' }
    expect(pathsOf((await ok(P.safety, 'POST', `/safety/risk/assessments/${assessment}/versions`, freeze, 409)).error)).toContain('refusal/VERSION_WAITING')
    const withdrawn = await ok(P.safety, 'POST', `/safety/risk/versions/${waiting.id}/withdraw`, { version: waiting.version, reason: 'Superseded by the cutting-hall noise survey (made-up).' })
    expect(withdrawn.version).toMatchObject({ status: 'WITHDRAWN', missing: [] })
    const appointed = await ok(P.safety, 'POST', '/safety/appointments', { companyId: companyA(), siteId: siteA1(), role: 'DOCTOR', outsideName: 'Dr Verdi', fromDate: today() }, 201)
    G.drAppt = appointed.appointment.id
    const frozen = (await ok(P.safety, 'POST', `/safety/risk/assessments/${assessment}/versions`, freeze, 201)).version
    expect(frozen).toMatchObject({ versionNo: 3, label: 'v3', status: 'AWAITING_SIGNATURES', sha256: sha256(body), missing: ['EMPLOYER', 'RSPP', 'RLS', 'DOCTOR'], file: { fileId } })
    G.dvr = frozen
    keep(frozen.id, waiting.id, G.drAppt)
    await settle()
  })

  it('S02 the paper signatures with their scans (employer, RSPP, RLS); a second employer signature, a seal too early and the officer signing for the doctor are refused', async () => {
    const signerOf = (role: string) => (G.dvr.signers as Json[]).find((signer) => signer.role === role)!
    const v3 = G.dvr.id as string
    for (const [role, signerName] of [
      ['EMPLOYER', 'Seed Legal Representative (made-up)'],
      ['RSPP', 'Seed Safety Consultancy (made-up)'],
      ['RLS', 'Seed Employee Two'],
    ] as const) {
      expect(pathsOf((await ok(P.safety, 'POST', `/safety/risk/versions/${v3}/signatures`, { role, signerName, signedOn: today() }, 409)).error)).toContain('refusal/SCAN_MISSING')
      await upload(P.safety, { companyId: companyA(), recordType: 'RiskAssessmentSignature', recordId: signerOf(role).signatureId }, `dvr-v3-${role.toLowerCase()}.pdf`, pdf(`signed page of DVR v3: ${role}`))
      const signed = await ok(P.safety, 'POST', `/safety/risk/versions/${v3}/signatures`, { role, signerName, signedOn: today() }, 201)
      expect(signed).toMatchObject({ complete: false, sealed: false })
    }
    expect(pathsOf((await ok(P.safety, 'POST', `/safety/risk/versions/${v3}/signatures`, { role: 'EMPLOYER', signerName: 'Seed Legal Representative (made-up)', signedOn: today() }, 409)).error)).toContain('refusal/SIGNED_ALREADY')
    expect(pathsOf((await ok(P.safety, 'POST', `/safety/risk/versions/${v3}/seal`, { language: 'it' }, 409)).error)).toContain('refusal/NOT_SIGNED')
    expect(pathsOf((await ok(P.safety, 'POST', `/safety/risk/versions/${v3}/sign`, { role: 'DOCTOR', signerName: 'Dr Verdi' }, 409)).error)).toContain('refusal/NOT_THE_SIGNER')
    await settle()
  })

  it('S03 the doctor signs in the office with a fresh code: v3 SIGNED, in force with a certain date, sealed as a DVR_FROZEN document; v1 superseded', async () => {
    const assessment = first('safety:dvr:A1')
    const v3 = G.dvr.id as string
    const before = await ok(P.drVerdi, 'GET', `/safety/risk/assessments/${assessment}`)
    expect((before.versions as Json[]).find((version) => version.id === v3)!.signers.find((signer: Json) => signer.role === 'DOCTOR')).toMatchObject({ mine: true, holder: { appointmentId: G.drAppt } })
    const unproved = await call(P.drVerdi.browser, 'POST', `/safety/risk/versions/${v3}/sign`, { role: 'DOCTOR', signerName: 'Dr Verdi' })
    expect(unproved.status).toBe(403)
    expect(pathsOf(unproved.body.error)).toEqual(['stepUp'])
    await stepped(w, P.drVerdi)
    const signed = await ok(P.drVerdi, 'POST', `/safety/risk/versions/${v3}/sign`, { role: 'DOCTOR', signerName: 'Dr Verdi' })
    expect(signed).toMatchObject({ complete: true, sealed: true, version: { status: 'SIGNED', certainDateOn: today(), inForce: true, missing: [], sealed: { version: 1, language: 'it' } } })
    const record = await ok(P.safety, 'GET', `/safety/risk/assessments/${assessment}`)
    expect((record.versions as Json[]).map((version) => [version.label, version.status, version.inForce])).toEqual(
      expect.arrayContaining([
        ['v3', 'SIGNED', true],
        ['v1', 'SIGNED', false],
      ]),
    )
    const seal = await admin(w, `SELECT g."siteId"::text AS "siteId", f."recordType", f.status::text AS status FROM "GeneratedDocument" g JOIN "StoredFile" f ON f.id = g."fileId" WHERE g."recordId" = $1 AND g.kind = 'DVR_FROZEN'`, [v3])
    expect(seal).toEqual([{ siteId: siteA1(), recordType: 'RiskAssessmentVersion', status: 'AVAILABLE' }])
    await settle()
  })

  it('S04 a measure of the improvement plan from v3: its owner moves it, the owner may not verify it, the safety officer verifies it once DONE', async () => {
    const assessment = first('safety:dvr:A1')
    let measure = (
      await ok(P.safety, 'POST', '/safety/risk/measures', { assessmentId: assessment, title: 'Noise enclosure on the second press (made-up)', risk: 'Noise at the clicking press', roleSheetIds: [first('safety:role:A1:CUT')], ownerId: P.manager.id, dueOn: addDays(today(), 30), source: 'DVR' }, 201)
    ).measure
    expect(measure).toMatchObject({ status: 'PLANNED', sourceVersion: { id: G.dvr.id, label: 'v3' } })
    const move = async (who: Person, status: string, extra: Json = {}, code = 200) => ok(who, 'POST', `/safety/risk/measures/${measure.id}/status`, { version: measure.version, status, ...extra }, code)
    expect(pathsOf((await move(P.safety, 'VERIFIED', {}, 409)).error)).toContain('refusal/BAD_MOVE')
    measure = (await move(P.manager, 'IN_PROGRESS')).measure
    measure = (await move(P.manager, 'DONE', { evidenceNote: 'Enclosure fitted and measured (made-up).' })).measure
    expect(measure).toMatchObject({ status: 'DONE' })
    await move(P.manager, 'VERIFIED', {}, 403)
    measure = (await move(P.safety, 'VERIFIED')).measure
    expect(measure).toMatchObject({ status: 'VERIFIED', canMove: [] })
    keep(measure.id)
    await settle()
  })

  it('S05 HR takes on a new cutter and gives her the A1 Cutter role sheet (another site’s sheet refused): the courses, the kit and a first visit she needs fill three lists', async () => {
    const cutter = first('safety:role:A1:CUT')
    G.cutterEmployee = (await ok(P.hr, 'POST', '/people/employees', { siteId: siteA1(), firstName: 'Nora', lastName: 'Nuova', employeeCode: 'GOLD-S-01', startDate: today() }, 201)).employee.id
    const N = G.cutterEmployee as string
    keep(N)
    const refused = await ok(P.hr, 'POST', `/people/employees/${N}/role-sheet/preview`, { roleSheetId: id('safety:role:B1:SEW-B') }, 409)
    expect(pathsOf(refused.error)).toContain('refusal/ROLE_SHEET_OTHER_SITE')
    const preview = await ok(P.hr, 'POST', `/people/employees/${N}/role-sheet/preview`, { roleSheetId: cutter })
    expect(preview).toMatchObject({ change: 'SET', visit: { shown: true } })
    expect((preview.kit.toIssue as Json[]).length).toBe(3)
    const version = (await ok(P.hr, 'GET', `/people/employees/${N}/role-sheet`)).employee.version
    const set = await ok(P.hr, 'PUT', `/people/employees/${N}/role-sheet`, { version, roleSheetId: cutter, impactFingerprint: preview.fingerprint, reason: 'A new cutter at the clicking press (made-up).' })
    expect(set).toMatchObject({ changed: true, employee: { roleSheet: { code: 'CUT' } } })
    await settle()
    // Training: the general course and the specific high-risk one, both needed by the role.
    const due = ((await ok(P.safety, 'GET', `/safety/training/due?siteId=${siteA1()}&roleSheetId=${cutter}`)).rows as Json[]).filter((row) => row.employee.id === N)
    expect(due.map((row) => [row.courseId, row.state, row.why])).toEqual(
      expect.arrayContaining([
        [first('safety:course:GEN'), 'NEEDED', 'ROLE'],
        [id('safety:course:SPEC-HIGH'), 'NEEDED', 'ROLE'],
      ]),
    )
    expect(due).toHaveLength(2)
    // PPE: the cutter's kit, none of it held.
    const gaps = ((await ok(P.safety, 'GET', `/safety/ppe/gaps?siteId=${siteA1()}`)).people as Json[]).find((row) => row.employee.id === N)
    expect(gaps).toMatchObject({ role: { code: 'CUT' }, missing: 4 })
    // Health: a visit before the task, made by the worker's handler on the role change; HR and the doctor read it, the safety officer may not.
    const visits = await ok(P.drVerdi, 'POST', '/safety/health/visits/list', { employeeId: N })
    expect(visits.visits).toEqual([expect.objectContaining({ type: 'PREVENTIVE', status: 'DUE', role: expect.objectContaining({ code: 'CUT' }) })])
    G.cutterVisit = visits.visits[0]
    await ok(P.safety, 'POST', '/safety/health/visits/list', { employeeId: N }, 403)
  })

  it('S06 the courses recorded, the kit issued on one receipt, the visit booked and the doctor’s judgement: each list empties for her', async () => {
    const N = G.cutterEmployee as string
    const cutter = first('safety:role:A1:CUT')
    const person = { employeeId: N, result: 'PASSED', languageChecked: true }
    const course = (courseId: string, hours: string, extra: Json = {}) => ({ courseId, completedOn: today(), hours, trainerName: 'Made-up Provider', language: 'it', people: [{ ...person, ...extra }] })
    expect(pathsOf((await ok(P.hr, 'POST', '/safety/training/records', course(id('safety:course:SPEC-HIGH'), '12', { validUntil: addDays(today(), 365) }), 400)).error)).toContain('body/people/0/validUntilReason')
    for (const [courseId, hours] of [
      [first('safety:course:GEN'), '4'],
      [id('safety:course:SPEC-HIGH'), '12'],
    ] as const) {
      const recorded = await ok(P.hr, 'POST', '/safety/training/records', course(courseId, hours), 201)
      keep(...(recorded.records as Json[]).map((record) => record.id))
    }
    const due = ((await ok(P.safety, 'GET', `/safety/training/due?siteId=${siteA1()}&roleSheetId=${cutter}`)).rows as Json[]).filter((row) => row.employee.id === N)
    expect(due).toEqual([])
    const kit = [
      { ppeItemId: first('safety:ppe:GLOVES-CUT'), size: '9', quantity: 2, reason: 'NEW' },
      { ppeItemId: id('safety:ppe:EAR-DEF'), quantity: 1, reason: 'NEW' },
      { ppeItemId: id('safety:ppe:SHOES'), size: '42', quantity: 1, reason: 'NEW' },
    ]
    expect(pathsOf((await ok(P.hr, 'POST', '/safety/ppe/issues', { employeeId: N, lines: [{ ...kit[2], size: '50' }] }, 400)).error)).toContain('body/lines/0/size')
    const issued = await ok(P.hr, 'POST', '/safety/ppe/issues', { employeeId: N, lines: kit }, 201)
    expect(issued.receipt).toMatchObject({ method: 'PAPER', state: 'NOT_SIGNED', units: 4 })
    expect(((await ok(P.safety, 'GET', `/safety/ppe/gaps?siteId=${siteA1()}`)).people as Json[]).filter((row) => row.employee.id === N)).toEqual([])
    const visit = G.cutterVisit as Json
    const book = (bookedOn: string) => ({ visits: [{ id: visit.id, version: visit.version }], bookedOn, bookedPlace: 'Made-up clinic' })
    expect(pathsOf((await ok(P.drVerdi, 'POST', '/safety/health/visits/book', book(addDays(today(), -1)), 409)).error)).toContain('refusal/BOOKED_IN_PAST')
    const booked = (await ok(P.drVerdi, 'POST', '/safety/health/visits/book', book(today()))).visits[0]
    expect(booked).toMatchObject({ status: 'BOOKED' })
    const judged = await ok(P.drVerdi, 'POST', '/safety/health/judgements', { employeeId: N, visitId: visit.id, outcome: 'FIT', judgedOn: today(), expiresOn: addDays(today(), 365) }, 201)
    expect(judged.visit).toMatchObject({ status: 'DONE' })
    expect(pathsOf((await ok(P.drVerdi, 'POST', '/safety/health/judgements', { employeeId: N, visitId: visit.id, outcome: 'FIT', judgedOn: today(), expiresOn: addDays(today(), 365) }, 409)).error)).toContain('refusal/VISIT_JUDGED')
    expect((await ok(P.drVerdi, 'POST', '/safety/health/visits/list', { employeeId: N })).visits).toEqual([])
    keep(visit.id, judged.judgement?.id)
    await settle()
  })

  // ---- I: an incident with its INAIL clock ---------------------------------------------------------------------------------------

  it('I01 an operator reports on the tablet that they cut a hand two days ago; the office reads it anonymised (no person, the reporter hidden behind the gate); the safety officer is told', async () => {
    const T = G.tablets.hurt as Browser
    const reported = await ok(T, 'POST', '/safety/floor/incidents', { kind: 'INJURY', here: true, language: 'en', occurredAt: hoursAgo(50), people: [{ who: 'ME', involvement: 'INJURED', bodyParts: ['HAND'], bodySide: 'LEFT', nature: 'CUT', firstAidGiven: true }] }, 201)
    expect(reported.incident).toMatchObject({ kind: 'INJURY', status: 'OPEN', anonymous: false, number: expect.stringMatching(/^INC-\d{4}-\d{4}$/) })
    G.incident = reported.incident
    keep(G.incident.id)
    await settle()
    const record = (await ok(P.manager, 'GET', `/safety/incidents/${G.incident.id}`)).incident
    expect(record.people).toMatchObject({ count: 1, injured: 1, canOpen: false })
    expect(record.reporter).toMatchObject({ kind: 'WORKER', name: null, hidden: true })
    expect(JSON.stringify(record)).not.toContain(G.workers.hurt.name)
    const told = (await ok(P.safety, 'GET', '/notifications?tab=SYSTEM')).items as Json[]
    expect(told.some((item) => item.anchor === `incident:${G.incident.id}`)).toBe(true)
  })

  it('I02 HR opens the injured person (the view recorded; the production manager refused and nothing recorded) and starts the INAIL filing from the certificate received 45 hours ago: due 48 hours after it', async () => {
    const views = async () => (await admin<{ n: number }>(w, 'SELECT count(*)::int AS n FROM "ProtectedView" WHERE "tenantId" = $1', [w.tenant.id]))[0]!.n
    const before = await views()
    await ok(P.manager, 'POST', `/safety/incidents/${G.incident.id}/people/open`, {}, 403)
    expect(await views()).toBe(before)
    const opened = await ok(P.hr, 'POST', `/safety/incidents/${G.incident.id}/people/open`, {})
    expect(opened.recorded).toBe(true)
    const injured = (opened.people as Json[])[0]!
    expect(injured).toMatchObject({ involvement: 'INJURED', employee: { id: G.employees.hurt }, bodyParts: ['HAND'] })
    expect(await admin(w, `SELECT what::text AS what, "recordType"::text AS "recordType", "employeeId"::text AS "employeeId" FROM "ProtectedView" WHERE "viewerId" = $1 AND "recordId" = $2`, [P.hr.id, injured.id])).toEqual([{ what: 'OPEN', recordType: 'INCIDENT_PERSON', employeeId: G.employees.hurt }])
    const certificate = hoursAgo(45)
    const filing = (absence: number) => ({ incidentPersonId: injured.id, expectedAbsenceDays: absence, certificateReference: 'GOLDEN-CERT-1', certificateReceivedAt: certificate })
    expect(pathsOf((await ok(P.hr, 'POST', `/safety/incidents/${G.incident.id}/filings`, filing(0), 409)).error)).toContain('refusal/NO_FILING_NEEDED')
    const started = await ok(P.hr, 'POST', `/safety/incidents/${G.incident.id}/filings`, filing(5), 201)
    const due = (started.filings as Json[])[0]!
    expect(due).toMatchObject({ status: 'DUE', dueAt: new Date(new Date(certificate).getTime() + 48 * 3_600_000).toISOString() })
    G.filing = due
    G.certificate = certificate
    keep(due.id)
    await settle()
  })

  it('I03 the INAIL clock: the reminder four hours before the deadline fires; HR is told "INAIL report due", the incidents’ banner counts it down under 24 hours', async () => {
    const timers = await admin<{ id: string; timerKey: string }>(w, `SELECT id::text, "timerKey" FROM "DueTimer" WHERE "recordType" = 'InailFiling' AND "recordId" = $1 ORDER BY "fireAt"`, [G.filing.id])
    expect(timers.map((timer) => timer.timerKey)).toEqual(['INAIL_FILING_DUE:-4h', 'INAIL_FILING_DUE'])
    const fired = await fireTimer(callerFor(w.h.database, systemContext(w.tenant.id, `golden-inail-${G.filing.id}`)), timers[0]!.id, COMMAND_SETTINGS)
    expect(fired).toEqual({ outcome: 'FIRED' })
    await settle()
    const told = (await ok(P.hr, 'GET', '/notifications?tab=SYSTEM')).items as Json[]
    expect(told.find((item) => item.anchor === `inail:${G.filing.id}`)).toMatchObject({ category: 'ALERT', messageKey: 'notifications.safety.inailDue', record: { type: 'Incident', id: G.incident.id } })
    const counts = await ok(P.hr, 'GET', '/safety/incidents/counts')
    expect(counts.deadline).toMatchObject({ incidentId: G.incident.id, countdown: { under24h: true, late: false } })
  })

  it('I04 HR files it with the protocol number (a filing dated before the certificate refused); closing the incident waited for it', async () => {
    const base = `/safety/incidents/${G.incident.id}`
    const incident = (await ok(P.hr, 'GET', base)).incident
    expect(pathsOf((await ok(P.safety, 'POST', `${base}/close`, { version: incident.version }, 409)).error)).toContain('refusal/FILING_WAITING')
    const url = `${base}/filings/${G.filing.id}/file`
    expect(pathsOf((await ok(P.hr, 'POST', url, { version: G.filing.version, filedAt: hoursAgo(46), protocolNumber: 'GOLDEN-PROT-1' }, 409)).error)).toContain('refusal/FILED_BEFORE_CERTIFICATE')
    const filed = await ok(P.hr, 'POST', url, { version: G.filing.version, filedAt: new Date().toISOString(), protocolNumber: 'GOLDEN-PROT-1' })
    expect(filed.filing).toMatchObject({ status: 'FILED' })
    expect(await admin(w, `SELECT "timerKey", status::text AS status FROM "DueTimer" WHERE "recordType" = 'InailFiling' AND "recordId" = $1 ORDER BY "fireAt"`, [G.filing.id])).toEqual([
      { timerKey: 'INAIL_FILING_DUE:-4h', status: 'FIRED' },
      { timerKey: 'INAIL_FILING_DUE', status: 'CANCELLED' },
    ])
    await settle()
  })

  // ---- P: every health and injury read refused for a role without it; each allowed view recorded ----------------------------------

  it('P01 every role without the right is refused each protected read, and nothing is recorded', async () => {
    const before = await admin(w, 'SELECT count(*)::int AS n FROM "ProtectedView" WHERE "tenantId" = $1', [w.tenant.id])
    const judgement = id('health:judgement:E1')
    const visit = id('health:visit:E1:return')
    for (const [who, method, url, body] of [
      [P.manager, 'POST', '/safety/health/visits/list', {}],
      [P.manager, 'POST', `/safety/health/judgements/${judgement}/open`, {}],
      [P.manager, 'POST', `/safety/health/visits/${visit}/open`, {}],
      [P.manager, 'GET', '/safety/health', undefined],
      [P.safety, 'POST', '/safety/health/visits/list', {}],
      [P.safety, 'GET', '/safety/health', undefined],
      [P.drVerdi, 'GET', '/safety/health/views?companyId=' + companyA() + '&lists=true', undefined],
      [P.drVerdi, 'GET', '/safety/incidents', undefined],
      [P.drVerdi, 'POST', `/safety/incidents/${G.incident.id}/people/open`, {}],
      [P.manager, 'POST', `/safety/incidents/${G.incident.id}/people/open`, {}],
      [P.manager, 'POST', `/safety/incidents/${G.incident.id}/filings/open`, {}],
      [P.inspector, 'POST', '/safety/incidents/people', { incidentIds: [G.incident.id] }],
    ] as const) {
      const answer = await call(who.browser, method, url, body)
      expect(answer.status, `${who.key} ${method} ${url}`).toBe(403)
    }
    expect(await admin(w, 'SELECT count(*)::int AS n FROM "ProtectedView" WHERE "tenantId" = $1', [w.tenant.id])).toEqual(before)
  })

  it('P02 each allowed read writes its view (HR: the visit list, a judgement, the filing; the doctor: a visit), and HR’s "who looked" lists them', async () => {
    const mine = async (viewer: string) => admin<{ what: string; recordType: string; recordId: string | null }>(w, `SELECT what::text AS what, "recordType"::text AS "recordType", "recordId"::text AS "recordId" FROM "ProtectedView" WHERE "viewerId" = $1 ORDER BY "viewedAt", id`, [viewer])
    const hrBefore = (await mine(P.hr.id)).length
    const drBefore = (await mine(P.drVerdi.id)).length
    await ok(P.hr, 'POST', '/safety/health/visits/list', {})
    const judgement = id('health:judgement:E1')
    await ok(P.hr, 'POST', `/safety/health/judgements/${judgement}/open`, {})
    await ok(P.hr, 'POST', `/safety/incidents/${G.incident.id}/filings/open`, {})
    const visit = id('health:visit:E1:return')
    await ok(P.drVerdi, 'POST', `/safety/health/visits/${visit}/open`, {})
    const hr = (await mine(P.hr.id)).slice(hrBefore)
    expect(hr.map((row) => [row.what, row.recordType])).toEqual([
      ['LIST', 'HEALTH_VISIT_LIST'],
      ['OPEN', 'FITNESS_JUDGEMENT'],
      ['OPEN', 'INAIL_FILING'],
    ])
    expect((await mine(P.drVerdi.id)).slice(drBefore)).toEqual([{ what: 'OPEN', recordType: 'HEALTH_VISIT', recordId: visit }])
    const looked = await ok(P.hr, 'GET', `/safety/health/views?recordType=FITNESS_JUDGEMENT&recordId=${judgement}`)
    expect((looked.views as Json[]).filter((view) => view.viewer.id === P.hr.id).map((view) => view.what)).toContain('OPEN')
    const byVisit = await ok(P.hr, 'GET', `/safety/health/views?recordType=HEALTH_VISIT&recordId=${visit}`)
    expect((byVisit.views as Json[]).some((view) => view.viewer.id === P.drVerdi.id)).toBe(true)
    expect(pathsOf((await ok(P.hr, 'GET', '/safety/health/views', undefined, 400)).error)).toContain('query')
  })

  // ---- H: the new reads that name a worker, behind the PERFORMANCE gate (Statuto art. 4) -----------------------------------------

  it('H01 PERFORMANCE switched on at A1 with a fresh code: each new W2b-2 read names a worker, and says nobody is hidden', async () => {
    await stepped(w, P.owner)
    await ok(P.owner, 'POST', `/people/privacy/sites/${siteA1()}/purposes/PERFORMANCE/switch-on`, { reason: 'Piece pay rests on the made-up union agreement.' })
    await gateOpens()
    const entry = ((await ok(P.manager, 'GET', `/production/cutting/work-orders/${S().wo}/cut-log`)).entries as Json[]).find((row) => row.id === G.cutEntry.id)!
    expect(entry).toMatchObject({ overrideLead: { id: G.workers.lead.id }, overrideLeadHidden: false })
    expect((await ok(P.manager, 'GET', `/safety/incidents/${G.incident.id}`)).incident.reporter).toMatchObject({ hidden: false })
    await settle()
  })

  it('H02 PERFORMANCE off: no worker’s id or name in the raw JSON of any of them, each says a person is on it; on again, off again', async () => {
    await ok(P.owner, 'POST', `/people/privacy/sites/${siteA1()}/purposes/PERFORMANCE/switch-off`, { version: await gateVersion(), reason: 'The made-up agreement ended.' })
    await gateCloses()
    await stepped(w, P.owner)
    await ok(P.owner, 'POST', `/people/privacy/sites/${siteA1()}/purposes/PERFORMANCE/switch-on`, { reason: 'A new made-up agreement.' })
    await gateOpens()
    await ok(P.owner, 'POST', `/people/privacy/sites/${siteA1()}/purposes/PERFORMANCE/switch-off`, { version: await gateVersion(), reason: 'The new agreement was withdrawn (made up).' })
    await gateCloses()
    await settle()
  })

  // ---- Z: the end checks ----------------------------------------------------------------------------------------------------------------

  it('Z1 every record the flow made has its audit rows; the W2b-2 events fired; the worker never retried; no route answered 500; the outbox is empty', async () => {
    const ids = [...made]
    const audited = new Set((await admin<{ recordId: string }>(w, 'SELECT DISTINCT "recordId"::text AS "recordId" FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [ids])).map((row) => row.recordId))
    expect(ids.filter((recordId) => !audited.has(recordId))).toEqual([])
    const events = new Set((await admin<{ type: string }>(w, 'SELECT DISTINCT type FROM "OutboxEvent" WHERE "tenantId" = $1', [w.tenant.id])).map((row) => row.type))
    expect(EVENTS.filter((type) => !events.has(type)), `seen: ${[...events].sort().join(' ')}`).toEqual([])
    expect(w.retried).toEqual([])
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(await admin(w, `SELECT type, status::text AS status FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])).toEqual([])
  })
})
