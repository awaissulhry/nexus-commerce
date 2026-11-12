import type { FinalViewModel, OrderModel } from '../view/FinalView'
import type { FinalDefect, Sheet, SheetCheck } from './api'
import type { BenchModel } from './view/PlanBench'

/**
 * SCR-097's W2b cases (B-W2b-109): the bench on its plan at tablet width, made-up data of a made-up "Demo" plant — the plan, the
 * sample of the lot as the API gives it, the AQL counter with its defects, the checks, one point of measure per step (the plan's,
 * a made-up rider's profile, the size chart), the serial or batch check, the photo set, a write kept offline, the signature, a
 * code that leads to several inspections and the refused scans. No money anywhere, never another person's name.
 */

const NOW = '2026-11-08T09:30:00.000Z'

const result = (id: string, outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE', extra: Partial<SheetCheck['results'][number]> = {}): SheetCheck['results'][number] => ({ id, sampleIndex: 1, outcome, value: null, note: null, photos: [], recordedBy: 'FLOOR', recordedAt: NOW, ...extra })

const check = (code: string, label: string, extra: Partial<SheetCheck> = {}): SheetCheck => ({
  id: `chk-${code.toLowerCase()}`,
  code,
  label,
  missingWords: false,
  labelIt: label,
  labelEn: label,
  type: 'PASS_FAIL',
  checkClass: 'MAJOR',
  mandatory: true,
  photoRequired: false,
  takesResult: true,
  onChart: false,
  choices: [],
  results: [],
  ...extra,
})

const CHECKS: SheetCheck[] = [
  check('CE_MARK', 'Marcatura CE leggibile', { checkClass: 'CRITICAL' }),
  check('ARMOUR', 'Protezioni EN 1621 al loro posto', { checkClass: 'CRITICAL', photoRequired: true }),
  check('CARE', 'Etichetta di manutenzione', { checkClass: 'MAJOR' }),
  check('ZIPS', 'Cerniere scorrevoli', { checkClass: 'MAJOR' }),
  check('LOOSE', 'Fili sciolti', { checkClass: 'MINOR', mandatory: false }),
  check('PIECES', 'Pezzi nella busta', { type: 'COUNT', checkClass: 'MINOR' }),
  check('SHADE', 'Tono del colore', { type: 'CHOICE', checkClass: 'MAJOR', choices: ['A', 'B', 'C'] }),
  check('NOTES', 'Note per il cliente', { type: 'FREE_TEXT', checkClass: null, mandatory: false }),
  check('READ', 'Controlla con la luce del banco, non al sole.', { type: 'INSTRUCTION', checkClass: null, mandatory: false, takesResult: false }),
  check('CHEST', 'Petto ½', { type: 'MEASUREMENT', onChart: true }),
  check('FRONT', 'Davanti', { type: 'PHOTO', checkClass: null }),
  check('BACK', 'Dietro', { type: 'PHOTO', checkClass: null }),
  check('LABEL', 'Etichetta', { type: 'PHOTO', checkClass: null, mandatory: false }),
]

export const sheet = (extra: Partial<Sheet> = {}): Sheet => ({
  inspection: { id: 'ins-demo-0011', number: 'INS-D-2026-0011', workOrderId: 'wo-demo-0042', status: 'OPEN', version: 4, lotSize: 48, sampleSize: 8, inspectionLevel: 'II', codeLetter: 'E', aqlMajor: '2,5', aqlMinor: '4', acceptMajor: 0, acceptMinor: 1, decidedAt: null },
  plan: { planId: 'plan-demo', code: 'FIN-DEMO', name: 'Giacca finale Demo', versionId: 'ver-demo-2', number: 2, samplingMethod: 'AQL_PROFILE' },
  language: 'it',
  checks: CHECKS,
  checksNow: { answered: 0, outOf: 9, failed: [], failedCritical: [], mandatoryMissing: [], words: '' },
  chart: {
    points: [{ pointCode: 'CHEST', checkCode: 'CHEST', label: 'Petto ½', size: null, source: 'PLAN', nominal: '58', tolerance: '1', uom: 'CM', spec: '', values: [] }],
    values: 0,
    outOfTolerance: 0,
    words: '',
    madeToMeasure: null,
  },
  identity: { mode: 'SERIAL', target: 8, matched: 0, missing: [], missingCount: 0, unknown: [], noNumber: 0, done: false, ok: null, words: '', scans: 0, batchNumber: null },
  photos: {
    slots: [
      { code: 'FRONT', labelIt: 'Davanti', labelEn: 'Front', mandatory: true, photos: 0, state: 'MISSING' },
      { code: 'BACK', labelIt: 'Dietro', labelEn: 'Back', mandatory: true, photos: 0, state: 'MISSING' },
      { code: 'LABEL', labelIt: 'Etichetta', labelEn: 'Label', mandatory: false, photos: 0, state: 'OPEN' },
    ],
    waiting: [],
    mandatoryMissing: ['Front', 'Back'],
    words: '',
  },
  counter: {
    sampleSize: 8,
    inspected: 0,
    remaining: 8,
    classes: [
      { defectClass: 'CRITICAL', aql: '0', accept: 0, reject: 1, found: 0, state: 'ok', spare: 0, words: '' },
      { defectClass: 'MAJOR', aql: '2,5', accept: 0, reject: 1, found: 0, state: 'ok', spare: 0, words: '' },
      { defectClass: 'MINOR', aql: '4', accept: 1, reject: 2, found: 0, state: 'ok', spare: 1, words: '' },
    ],
    verdict: 'open',
    stop: { stop: true, source: 'COMPANY', words: '' },
    words: '',
  },
  result: { resultNow: 'PASS', reasons: [], byCountsOnly: false, overrideWords: '', words: '' },
  sign: { pass: { held: true, reasons: ['x'] }, fail: { held: true, reasons: ['x'] } },
  may: { record: true },
  ...extra,
})

const DEFECTS: FinalDefect[] = [
  { id: 'd1', code: 'ARMOUR-POCKET-MISSING', label: 'Tasca protezione mancante', severity: 'CRITICAL', needsDetail: false },
  { id: 'd2', code: 'LABEL-WRONG', label: 'Etichetta sbagliata', severity: 'CRITICAL', needsDetail: false },
  { id: 'd3', code: 'STITCHING', label: 'Cucitura aperta', severity: 'MAJOR', needsDetail: false },
  { id: 'd4', code: 'ZIP-FAULT', label: 'Cerniera difettosa', severity: 'MAJOR', needsDetail: false },
  { id: 'd5', code: 'LOOSE-THREAD', label: 'Filo sciolto', severity: 'MINOR', needsDetail: false },
  { id: 'd6', code: 'MARK', label: 'Segno sulla pelle', severity: 'MINOR', needsDetail: false },
]

export const bench = (extra: Partial<BenchModel> = {}): BenchModel => ({
  sheet: sheet(),
  section: 'aql',
  lines: [],
  defects: { list: DEFECTS, state: 'ready' },
  pick: null,
  value: null,
  measure: null,
  photo: null,
  sizes: ['50', '52'],
  kept: null,
  photoAdded: null,
  busy: false,
  asOf: null,
  waiting: 0,
  ...extra,
})

const answered = (outcome: 'PASS' | 'FAIL', codes: readonly string[], note?: string) => (checks: readonly SheetCheck[]) => checks.map((entry) => (codes.includes(entry.code) ? { ...entry, results: [result(`r-${entry.code}`, outcome, note ? { note } : {})] } : entry))

const counted = (inspected: number, found: { MAJOR?: number; MINOR?: number; CRITICAL?: number } = {}) => {
  const base = sheet().counter
  const classes = base.classes.map((entry) => {
    const count = found[entry.defectClass] ?? 0
    return { ...entry, found: count, state: count >= entry.reject ? ('reject' as const) : count > 0 && count === entry.reject - 1 ? ('limit' as const) : ('ok' as const) }
  })
  return { ...base, inspected, remaining: base.sampleSize - inspected, classes, verdict: classes.some((entry) => entry.state === 'reject') ? ('reject' as const) : inspected >= base.sampleSize ? ('accept' as const) : ('open' as const) }
}

/** Everything answered and clean: the PASS may be signed. */
const ready = (): Sheet => {
  const all = sheet()
  return sheet({
    checks: all.checks.map((entry) => (entry.takesResult && !entry.onChart && entry.type !== 'FREE_TEXT' ? { ...entry, results: [result(`r-${entry.code}`, 'PASS', entry.type === 'COUNT' ? { value: '2' } : entry.type === 'CHOICE' ? { value: 'A' } : entry.photoRequired || entry.type === 'PHOTO' ? { photos: [{ id: `f-${entry.code}`, status: 'AVAILABLE' }] } : {})] } : entry)),
    chart: { ...all.chart, points: [{ ...all.chart.points[0]!, values: Array.from({ length: 8 }, (_, index) => ({ id: `v${index}`, size: index < 4 ? '50' : '52', sampleIndex: index + 1, measured: String(57.6 + index * 0.1), nominal: '58', tolerance: '1', pass: true, words: '' })) }], values: 8 },
    identity: { ...all.identity, matched: 8, done: true, ok: true, scans: 8 },
    photos: { slots: all.photos.slots.map((slot) => ({ ...slot, photos: slot.mandatory ? 1 : 0, state: slot.mandatory ? 'TAKEN' : 'OPEN' })), waiting: [], mandatoryMissing: [], words: '' },
    counter: counted(8, { MINOR: 1 }),
    sign: { pass: { held: false, reasons: [] }, fail: { held: true, reasons: ['x'] } },
  })
}

type Base = (step: FinalViewModel['step'], extra?: Partial<FinalViewModel>) => FinalViewModel
type FrameOf = (extra?: Partial<FinalViewModel['frame']>) => FinalViewModel['frame']

/** The W2b cases, on the work order of the W1 cases (its strip, its holds). */
export function planCases(base: Base, order: OrderModel, frame: FrameOf) {
  const onBench = (b: BenchModel, extra: Partial<FinalViewModel> = {}) => base({ kind: 'bench', order, bench: b }, extra)
  const offline = { online: false, frame: frame({ online: false }) }
  const fails = sheet({ checks: answered('FAIL', ['CE_MARK'], 'Marcatura illeggibile (LABEL-WRONG)')(answered('PASS', ['CARE', 'ZIPS'])(CHECKS)), checksNow: { ...sheet().checksNow, failedCritical: ['CE marking'], failed: ['CE marking'] }, counter: { ...counted(3), verdict: 'reject' }, result: { resultNow: 'FAIL', reasons: [], byCountsOnly: false, overrideWords: '', words: '' } })
  const point = sheet().chart.points[0]!
  return [
    {
      id: 'w2b-plan-open',
      label: 'W2b — Start: the plan that applies, the sample of the lot',
      model: base({ kind: 'planOpen', order, open: { plan: { code: 'FIN-DEMO', number: 2, name: 'Giacca finale Demo' }, lotSize: 48, maxLot: 48, sample: { size: 8, letter: 'E', level: 'II', classes: [{ defectClass: 'CRITICAL', aql: '0', accept: 0, reject: 1 }, { defectClass: 'MAJOR', aql: '2,5', accept: 0, reject: 1 }, { defectClass: 'MINOR', aql: '4', accept: 1, reject: 2 }] }, editing: false } }),
      note: 'B-W2b-97: the plan the API suggests and the sample from B-W2b-93\'s AQL chain (code letter, accept and reject numbers): the screen never computes AQL. No plan applies: W1\'s typed plan, unchanged.',
    },
    { id: 'w2b-plan-open-lot', label: 'W2b — Start: fewer garments in the lot', model: base({ kind: 'planOpen', order, open: { plan: { code: 'FIN-DEMO', number: 2, name: 'Giacca finale Demo' }, lotSize: 20, maxLot: 48, sample: null, editing: true } }), note: 'The lot changed: its sample is read again from the office; Open waits for it.' },
    { id: 'w2b-aql', label: 'W2b — AQL sample: nothing counted yet', model: onBench(bench()), note: 'DS AqlCounter: "+ one piece" is the main tap (or the + key); a + on a class asks which defect; each class says accept up to · reject at, from the sheet.' },
    {
      id: 'w2b-aql-under-way',
      label: 'W2b — AQL sample under way, a minor defect found',
      model: onBench(bench({ sheet: sheet({ counter: counted(5, { MINOR: 1 }) }), lines: [{ defectClass: 'MINOR', code: 'LOOSE-THREAD', quantity: 1 }] })),
      note: 'QHS-067: a minus and a plus per defect found, big, one hand; the class at its limit says "one more rejects".',
    },
    { id: 'w2b-aql-pick', label: 'W2b — Which major defect?', model: onBench(bench({ sheet: sheet({ counter: counted(4) }), pick: { kind: 'add', defectClass: 'MAJOR' } })), note: 'The FINAL vocabulary of that class in the worker\'s language (B-W2b-90); a critical one is never recorded milder (the API refuses it).' },
    { id: 'w2b-aql-pick-offline', label: 'W2b — Which defect, list not on this tablet', model: onBench(bench({ pick: { kind: 'add', defectClass: 'MINOR' }, defects: { list: [], state: 'offline' } }), offline) },
    {
      id: 'w2b-aql-reject',
      label: 'W2b — The sample rejects: stop at the reject number',
      model: onBench(bench({ sheet: sheet({ counter: counted(3, { MAJOR: 1 }), result: { resultNow: 'FAIL', reasons: [], byCountsOnly: true, overrideWords: '', words: '' } }), lines: [{ defectClass: 'MAJOR', code: 'ZIP-FAULT', quantity: 1 }] })),
      note: 'The company\'s stop rule: a FAIL may be signed before the whole sample once a class rejects.',
    },
    { id: 'w2b-checks', label: 'W2b — The plan\'s checks, two answered', model: onBench(bench({ section: 'checks', sheet: sheet({ checks: answered('PASS', ['CE_MARK', 'CARE'])(CHECKS) }) })), note: 'DS FloorChecklist, one group per class, critical first; a fail asks what is wrong (the FINAL defects) and, where the plan asks, a photo with markup.' },
    { id: 'w2b-checks-failed', label: 'W2b — A critical check failed', model: onBench(bench({ section: 'checks', sheet: fails })), note: 'A failed critical check rejects the lot: the result says why, in words.' },
    { id: 'w2b-value', label: 'W2b — A count check', model: onBench(bench({ section: 'checks', value: { code: 'PIECES', value: 2, choice: null } })) },
    { id: 'w2b-measure', label: 'W2b — Measurements', model: onBench(bench({ section: 'measure', sheet: sheet({ chart: { ...sheet().chart, points: [{ ...point, values: [{ id: 'v1', size: '50', sampleIndex: 1, measured: '58.4', nominal: '58', tolerance: '1', pass: true, words: '' }] }], values: 1 } }) })) },
    {
      id: 'w2b-measure-point',
      label: 'W2b — One point per step: within tolerance',
      model: onBench(bench({ section: 'measure', measure: { pointCode: 'CHEST', unit: 2, size: '50', value: 58.4, nominal: null, tolerance: null, field: 'value' } })),
      note: 'Target ± tolerance, the pad with decimals, DS LimitMeter: in or out in words and tone. Save goes on to the next garment.',
    },
    { id: 'w2b-measure-out', label: 'W2b — Out of tolerance', model: onBench(bench({ section: 'measure', measure: { pointCode: 'CHEST', unit: 3, size: '52', value: 59.8, nominal: null, tolerance: null, field: 'value' } })) },
    // B-W2b-283 (FU1:05): a point of the approved measurement spec whose band is 64 −0.5/+1.5 cm: nothing typed but the value.
    {
      id: 'w2b-283-measure-spec',
      label: 'W2b-283 — A spec point with a band: 63.4 is out (made up)',
      model: onBench(
        bench({
          section: 'measure',
          sheet: sheet({
            chart: {
              ...sheet().chart,
              points: [
                {
                  pointCode: 'SLEEVE_LEN',
                  checkCode: null,
                  label: 'Manica',
                  size: null,
                  source: 'SPEC',
                  nominal: null,
                  tolerance: null,
                  uom: 'CM',
                  spec: 'Dalla specifica di misura approvata, revisione 2: 52 64 −0,5/+1,5 cm',
                  bySize: [{ size: '52', nominal: '64.000', tolerance: '1.500', toleranceMinus: '0.500', tolerancePlus: '1.500', words: '64 −0.5/+1.5 cm' }],
                  values: [{ id: 'v283', size: '52', sampleIndex: 1, measured: '65.4', nominal: '64.000', tolerance: '1.500', toleranceMinus: '0.500', tolerancePlus: '1.500', pass: true, words: '' }],
                },
              ],
              values: 1,
            },
          }),
          measure: { pointCode: 'SLEEVE_LEN', unit: 2, size: '52', value: 63.4, nominal: null, tolerance: null, field: 'value' },
        }),
      ),
      note: 'The spec gives nominal and band per size; the meter shows the same band (63.5 … 65.5), so 63.4 is out though within 64 ± 1.5.',
    },
    {
      id: 'w2b-measure-mtm',
      label: 'W2b — Made to measure: against the rider\'s profile',
      model: onBench(
        bench({
          section: 'measure',
          sheet: sheet({ chart: { ...sheet().chart, points: [{ pointCode: 'SLEEVE', checkCode: null, label: 'Manica', size: 'MTM-1', source: 'PROFILE', nominal: '64', tolerance: null, uom: 'CM', spec: '', values: [] }], madeToMeasure: { garmentType: 'JACKET', revision: 3, size: 'MTM-1', points: [{ code: 'SLEEVE', name: 'Manica', nominal: '64', uom: 'CM' }], pointsWithout: ['WAIST'] } } }),
          measure: { pointCode: 'SLEEVE', unit: 1, size: 'MTM-1', value: null, nominal: null, tolerance: 0.5, field: 'value' },
        }),
      ),
      note: 'QHS-053: the nominal is the made-up rider\'s profile value; the tolerance is typed (no column keeps it yet). Never the rider\'s name.',
    },
    {
      id: 'w2b-measure-chart',
      label: 'W2b — From the size chart: which size',
      model: onBench(bench({ section: 'measure', sheet: sheet({ chart: { ...sheet().chart, points: [{ pointCode: 'HEM', checkCode: 'HEM', label: 'Orlo', size: null, source: 'SIZE_CHART', nominal: null, tolerance: null, uom: 'CM', spec: '', values: [] }] } }), measure: { pointCode: 'HEM', unit: 1, size: null, value: null, nominal: null, tolerance: null, field: 'nominal' } })),
      note: 'No graded spec is kept: the nominal and tolerance come from the paper chart; Save waits for the size first.',
    },
    { id: 'w2b-serial', label: 'W2b — Serial check: a tick per garment', model: onBench(bench({ section: 'serial', sheet: sheet({ identity: { ...sheet().identity, matched: 3, scans: 3, missing: ['SN-D-000104', 'SN-D-000105', 'SN-D-000106', 'SN-D-000107', 'SN-D-000108'], missingCount: 5 } }) })) },
    {
      id: 'w2b-serial-wrong',
      label: 'W2b — A number not this work order\'s, a garment without one',
      model: onBench(bench({ section: 'serial', sheet: sheet({ identity: { ...sheet().identity, matched: 6, scans: 8, unknown: ['SN-D-009911'], noNumber: 1, ok: false, done: true } }) })),
      note: 'QHS-052: a missing or wrong number fails the lot; Take back corrects a misread.',
    },
    { id: 'w2b-batch', label: 'W2b — Batch check done', model: onBench(bench({ section: 'serial', sheet: sheet({ identity: { ...sheet().identity, mode: 'BATCH', target: 1, matched: 1, scans: 1, done: true, ok: true, batchNumber: 'B-DEMO-26-041' } }) })) },
    {
      id: 'w2b-photos',
      label: 'W2b — The photo set',
      model: onBench(bench({ section: 'photos', sheet: sheet({ result: { resultNow: 'FAIL', reasons: [], byCountsOnly: false, overrideWords: '', words: '' }, checks: answered('FAIL', ['ARMOUR'], 'Tasca protezione mancante (ARMOUR-POCKET-MISSING)')(CHECKS), photos: { ...sheet().photos, slots: sheet().photos.slots.map((slot) => (slot.code === 'FRONT' ? { ...slot, photos: 1, state: 'TAKEN' } : slot)), waiting: ['Photo with Armour'], mandatoryMissing: ['Back'] } }) })),
      note: 'QHS-054: front, back, label (each a slot) and the photo a failed "photo required" check waits for. Online only: a photo is sent at once.',
    },
    { id: 'w2b-photo-step', label: 'W2b — Taking the front photo', model: onBench(bench({ section: 'photos', photo: 'slot:FRONT' })), note: 'DS PhotoCapture in the slot\'s outline, faces kept out of the picture.' },
    { id: 'w2b-photos-offline', label: 'W2b — Photos offline: held with the reason', model: onBench(bench({ section: 'photos' }), offline) },
    {
      id: 'w2b-kept',
      label: 'W2b — Offline: the count kept on this tablet',
      model: onBench(bench({ sheet: sheet({ counter: counted(6) }), kept: { ticks: 'saved' }, asOf: '2026-11-08T09:12:00.000Z', waiting: 2 }), offline),
      note: 'B-W2b-106: every bench write online first, the same payload kept on the tablet when the network fails; the sheet moves at once; signing waits.',
    },
    { id: 'w2b-ready', label: 'W2b — Everything done: sign the PASS', model: onBench(bench({ sheet: ready(), lines: [{ defectClass: 'MINOR', code: 'MARK', quantity: 1 }] })) },
    { id: 'w2b-sign-pass', label: 'W2b — Sign PASS with the PIN', model: base({ kind: 'benchSign', order, sheet: ready(), decision: 'PASS', statementNeeded: false, statement: false, signer: 'Ada Demo' }) },
    { id: 'w2b-sign-fail', label: 'W2b — Sign FAIL: wrong PIN', model: base({ kind: 'benchSign', order, sheet: fails, decision: 'FAIL', statementNeeded: false, statement: false, signer: 'Ada Demo' }, { pin: 'wrong' }) },
    { id: 'w2b-sign-statement', label: 'W2b — A site that records stations: the statement first', model: base({ kind: 'benchSign', order, sheet: ready(), decision: 'PASS', statementNeeded: true, statement: false, signer: 'Ada Demo' }) },
    { id: 'w2b-not-yours', label: 'W2b — Another inspector\'s inspection: read only', model: onBench(bench({ sheet: sheet({ may: { record: false }, counter: counted(2) }) })), note: 'A team leader or another inspector reads the sheet; every write and the signature are held with the reason.' },
    {
      id: 'w2b-choose',
      label: 'W2b — A code that leads to two inspections',
      model: base({ kind: 'choose', code: 'B-DEMO-26-041', choices: [{ id: 'ins-1', number: 'INS-D-2026-0011', words: 'Collaudo finale aperto · WO-DEMO-0042' }, { id: 'ins-2', number: 'INS-D-2026-0012', words: 'Collaudo finale aperto · WO-DEMO-0044' }] }),
    },
    { id: 'w2b-scan-other-bench', label: 'W2b — A hide\'s lot at the final bench', model: base({ kind: 'problem', problem: { kind: 'refused', code: 'OTHER_BENCH', message: '', fix: null }, code: 'LOT-DEMO-HIDE-7' }) },
    { id: 'w2b-scan-nothing', label: 'W2b — Nothing to inspect', model: base({ kind: 'problem', problem: { kind: 'refused', code: 'NOTHING_TO_INSPECT', message: '', fix: null }, code: 'SN-D-000101' }) },
    { id: 'w2b-scan-offline', label: 'W2b — A scan offline, not on this tablet', model: base({ kind: 'problem', problem: { kind: 'offline' }, code: 'INS-D-2026-0013' }, offline) },
  ]
}
