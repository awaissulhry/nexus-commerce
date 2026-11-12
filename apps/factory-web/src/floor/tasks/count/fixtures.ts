import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_SITE, onFloor, signedInFrame } from '../../frame/fixtures'
import type { BinDone, BinLine, BinRead, CountLast, CountRef, Difference, Finished, KeptUnit, ToCount } from './model'
import { CountView, type CountViewModel } from './view/CountView'

/**
 * SCR-178's cases (B-W2b-310; design floor.count: What to count, Scan every unit, Differences; SCM-228): a warehouse tablet (no
 * station) of a made-up "Demo" plant. The site's running counts' bins (a recount first, one the person counted shown but not
 * offered), a bin with two counts, the bin blind with its big numeral, hides counted by their tag, a lot's label and a material
 * without a label on the pad, a unit found that was not expected, "Already counted" in amber, a recount, a bin counted already,
 * the differences after Bin done (missing, extra, short; none; a move since the start), Finish bin (recounts asked, kept on the
 * tablet), refusals in words, offline (as of, units kept, a bin known only from What to count), loading, error, notice, no
 * permission. Made-up bins, hides and lots; no money, no person.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const hide = (ref: number) => formatScanId({ type: 'HIDE', tenantTag: TAG, ref })
const roll = (ref: number) => formatScanId({ type: 'ROLL', tenantTag: TAG, ref })
const AS_OF = '2026-11-12T09:12:00.000Z'
const SINCE = '2026-11-12T07:40:00.000Z'

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.count', { station: { name: null, site: DEMO_SITE }, ...extra })

const count = (extra: Partial<CountRef> = {}): CountRef => ({ id: 'cnt-12', number: 'CNT-DEMO-0012', kind: 'CYCLE', status: 'COUNTING', freezeMoves: true, ...extra })
const CNT = count()
const YEAR = count({ id: 'cnt-14', number: 'CNT-DEMO-0014', kind: 'YEAR_END', freezeMoves: false })

const place = (code: string, name: string) => ({ id: `loc-${code.toLowerCase()}`, code, name, labelCode: `BIN-${code}` })
const STORE = place('A1-STORE-01', 'Cella pelli 1 (demo)')
const BULK = place('A1-BULK-01', 'Scaffale scorta 1 (demo)')
const PICK = place('A1-PF-01', 'Fronte di prelievo 1 (demo)')
const RACK = place('A2-ROLL-03', 'Rastrelliera rotoli 3 (demo)')

const toCount: ToCount = {
  asOf: AS_OF,
  bins: [
    { count: CNT, location: PICK, kind: 'RECOUNT', lines: 1, since: '2026-11-12T08:55:00.000Z', yours: false },
    { count: CNT, location: STORE, kind: 'COUNT', lines: 4, since: SINCE, yours: false },
    { count: CNT, location: BULK, kind: 'COUNT', lines: 2, since: SINCE, yours: false },
    { count: YEAR, location: RACK, kind: 'COUNT', lines: 3, since: '2026-11-12T06:30:00.000Z', yours: false },
    { count: CNT, location: place('A1-STORE-02', 'Cella pelli 2 (demo)'), kind: 'RECOUNT', lines: 1, since: '2026-11-12T09:01:00.000Z', yours: true },
  ],
}

const leather = { id: 'item-lea', code: 'PEL-BOV-12', name: 'Pelle bovina pieno fiore 1,2 mm (demo)', uom: 'FT2', tracking: 'HIDE' }
const lining = { id: 'item-lin', code: 'FOD-MESH', name: 'Fodera rete traspirante (demo)', uom: 'M', tracking: 'LOT' }
const buckle = { id: 'item-fib', code: 'FIB-ACC-20', name: 'Fibbia acciaio 20 mm (demo)', uom: 'PCS', tracking: 'NONE' }

const line = (seq: number, extra: Partial<BinLine>): BinLine => ({ lineId: `ln-${seq}`, seq, origin: 'SNAPSHOT', item: leather, lot: { id: 'lot-7', code: 'LOT-DEMO-0007' }, hide: null, pass: 'COUNT', scans: 0, scanned: '0.0000', ...extra })
const H1 = hide(4211)
const H2 = hide(4212)
const H3 = hide(4213)
const LINES: BinLine[] = [
  line(10, { hide: { id: 'h-1', code: H1 } }),
  line(20, { hide: { id: 'h-2', code: H2 } }),
  line(30, { hide: { id: 'h-3', code: H3 } }),
  line(40, { item: buckle, lot: null }),
]
const binOf = (lines: BinLine[] = LINES, extra: Partial<BinRead> = {}): BinRead => ({ location: STORE, counts: [CNT], count: CNT, lines, ...extra })
const scannedLines: BinLine[] = [line(10, { hide: { id: 'h-1', code: H1 }, scans: 1, scanned: '52.4000' }), line(20, { hide: { id: 'h-2', code: H2 }, scans: 1, scanned: '49.8000' }), line(30, { hide: { id: 'h-3', code: H3 } }), line(40, { item: buckle, lot: null })]
const withExtra: BinLine[] = [...scannedLines, line(50, { origin: 'ADDED', hide: { id: 'h-9', code: hide(4290) }, scans: 1, scanned: '47.1000' })]

const bulkLines: BinLine[] = [line(10, { item: lining, lot: { id: 'lot-31', code: 'LOT-DEMO-0031' } }), line(20, { item: lining, lot: { id: 'lot-33', code: 'LOT-DEMO-0033' }, scans: 1, scanned: '18.0000' })]

const diff = (seq: number, extra: Partial<Difference>): Difference => ({ lineId: `ln-${seq}`, seq, item: { id: leather.id, code: leather.code, name: leather.name, uom: 'FT2' }, lot: { id: 'lot-7', code: 'LOT-DEMO-0007' }, hide: null, pass: 'COUNT', expected: '0.0000', scanned: '0.0000', scans: 0, difference: '0.0000', kind: 'MATCH', ...extra })
const DIFFERENCES: Difference[] = [
  diff(10, { hide: { id: 'h-1', code: H1 }, expected: '52.4000', scanned: '52.4000', scans: 1 }),
  diff(20, { hide: { id: 'h-2', code: H2 }, expected: '49.8000', scanned: '49.8000', scans: 1 }),
  diff(30, { hide: { id: 'h-3', code: H3 }, expected: '51.0000', difference: '-51.0000', kind: 'MISSING' }),
  diff(40, { item: { id: buckle.id, code: buckle.code, name: buckle.name, uom: 'PCS' }, lot: null, expected: '40.0000', scanned: '36.0000', scans: 1, difference: '-4.0000', kind: 'SHORT' }),
  diff(50, { hide: { id: 'h-9', code: hide(4290) }, expected: '0.0000', scanned: '47.1000', scans: 1, difference: '47.1000', kind: 'EXTRA' }),
]
const done = (extra: Partial<BinDone> = {}): BinDone => ({ count: CNT, location: STORE, differences: DIFFERENCES, none: false, movedSinceStart: 0, note: null, ...extra })
const finished = (extra: Partial<Finished> = {}): Finished => ({ count: CNT, location: STORE, differences: DIFFERENCES, recountsAsked: [], lines: 14, counted: 9, ...extra })

const kept: KeptUnit[] = [
  { clientEventId: 'c-1', code: H3, lineId: 'ln-30', quantity: null },
  { clientEventId: 'c-2', code: hide(4291), lineId: null, quantity: null },
]

const counted = (extra: Partial<Extract<CountLast, { kind: 'counted' }>> = {}): CountLast => ({ kind: 'counted', code: H2, item: H2, quantity: '49.8000', uom: 'FT2', added: false, ticks: 'recorded', clientEventId: null, ...extra })

const base = (extra: Partial<CountViewModel> = {}): CountViewModel => ({ frame: frame(), online: true, step: { kind: 'what' }, toCount, ...extra })
const inBin = (bin: BinRead, extra: Partial<CountViewModel> = {}): CountViewModel => base({ step: { kind: 'bin' }, bin, placeCode: bin.location.labelCode, ...extra })
const offline = { frame: frame({ online: false, pending: 2 }), online: false }
const refused = (code: string, scanned: string | null, model: Partial<CountViewModel> = {}): CountViewModel => inBin(binOf(scannedLines), { problem: { problem: { kind: 'refused', code, message: 'The API said no (made up).', fix: null }, code: scanned }, ...model })

export const designScreen = defineDesignScreen<CountViewModel>({
  screen: 'SCR-178',
  title: 'Floor Count',
  view: onFloor(CountView),
  cases: [
    { id: 'what', label: 'What to count', model: base(), note: 'The site\'s running counts\' bins: a recount first, then the bins to count; a recount of a bin the person counted is shown and held (another person recounts it). Blind: no expected number anywhere.' },
    { id: 'what-empty', label: 'No count planned', model: base({ toCount: { asOf: AS_OF, bins: [] } }), note: 'Design empty state: "No count planned. Scan a bin to count it." Any bin of a running count can be scanned.' },
    { id: 'what-loading', label: 'Reading what to count', model: base({ toCount: null }) },
    { id: 'what-error', label: 'What to count not read', model: base({ toCount: null, toCountProblem: 'error' }) },
    { id: 'what-offline', label: 'Offline: what to count, from this tablet', model: base({ ...offline, toCountAsOf: AS_OF }) },
    { id: 'what-offline-none', label: 'Offline: never read on this tablet', model: base({ ...offline, toCount: null, toCountProblem: 'offline' }) },
    { id: 'reading', label: 'Reading the bin', model: base({ step: { kind: 'reading', code: 'BIN-A1-STORE-01' } }) },
    { id: 'choose', label: 'Two counts count this bin', model: base({ step: { kind: 'choose' }, bin: { location: RACK, counts: [CNT, YEAR], count: null, lines: [] } }), note: 'A tap picks the count; the bin then opens for it.' },
    { id: 'bin', label: 'Scan every unit: the bin, blind', model: inBin(binOf()), note: 'The bin\'s lines without the expected quantities; the big numeral counts the units scanned. A hide is counted by its tag (0 taps); the buckles have no label: tap their line and type.' },
    { id: 'bin-scanned', label: 'Two hides scanned, recorded', model: inBin(binOf(scannedLines), { last: counted() }), note: 'Each scan answers at once (colour, vibration, sound) and the strip says what it counted with its two ticks.' },
    { id: 'bin-added', label: 'A hide found that was not expected', model: inBin(binOf(withExtra), { last: counted({ code: hide(4290), item: hide(4290), quantity: '47.1000', added: true }) }), note: 'Counted as its own line ("found here, not expected"); Bin done lists it as extra.' },
    { id: 'bin-already', label: 'Already counted (amber)', model: inBin(binOf(scannedLines), { last: { kind: 'already', code: H2 } }), note: 'A tag scanned twice: the amber line says so and the next scan goes on (no full-screen stop).' },
    { id: 'bin-pad-line', label: 'A material without a label: the pad', model: inBin(binOf(scannedLines), { pad: { target: { kind: 'line', lineId: 'ln-40', uom: 'PCS' }, value: 36 } }), note: 'The number pad for the line tapped; the expected number is not shown (blind).' },
    { id: 'bin-pad-lot', label: 'A lot\'s label: how much it holds', model: inBin(binOf(bulkLines, { location: BULK }), { pad: { target: { kind: 'code', code: 'LOT-DEMO-0031', lineId: 'ln-10', uom: 'M' }, value: 20.5 } }) },
    { id: 'bin-recount', label: 'A recount by another person', model: inBin(binOf([line(10, { item: lining, lot: { id: 'lot-31', code: 'LOT-DEMO-0031' }, pass: 'RECOUNT' })], { location: PICK })), note: 'The office (or the recount rule) asked it; the person who counted it first is refused in words.' },
    { id: 'bin-counted', label: 'Every line counted already', model: inBin(binOf(LINES.map((entry) => ({ ...entry, pass: null, scans: 1, scanned: '50.0000' })))), note: 'Nothing left to count here: the office asks a recount to count it again.' },
    { id: 'bin-empty', label: 'Nothing expected: scan what you find', model: inBin(binOf([], { location: PICK })) },
    { id: 'bin-kept-waiting', label: 'Units still on this tablet: Bin done waits', model: inBin(binOf(scannedLines), { kept: kept.slice(0, 1), last: { kind: 'kept', code: H3, item: H3, quantity: null, uom: null, ticks: 'sending', clientEventId: 'c-1' } }), note: 'Bin done waits until the office has every unit (the differences count them).' },
    { id: 'bin-offline', label: 'Offline: units kept on this tablet', model: inBin(binOf(scannedLines), { ...offline, binAsOf: AS_OF, kept, last: { kind: 'kept', code: hide(4291), item: null, quantity: null, uom: null, ticks: 'saved', clientEventId: 'c-2' } }), note: 'One tick each: they count on this tablet\'s copy of the bin and go when the network is back. A tag the copy does not know is matched by the office.' },
    { id: 'bin-offline-blind', label: 'Offline: a bin known only from What to count', model: inBin(binOf([], { location: RACK, counts: [YEAR], count: YEAR }), { ...offline, binAsOf: AS_OF, kept: [{ clientEventId: 'c-3', code: roll(812), lineId: null, quantity: null }], last: { kind: 'kept', code: roll(812), item: null, quantity: null, uom: null, ticks: 'saved', clientEventId: 'c-3' } }) },
    { id: 'done-reading', label: 'Reading the differences', model: inBin(binOf(withExtra), { step: { kind: 'doneReading' } }) },
    { id: 'differences', label: 'Differences: missing, extra, short', model: inBin(binOf(withExtra), { step: { kind: 'done' }, done: done() }), note: 'After Bin done the expected numbers show: a hide missing, a hide extra, buckles short. Look again goes back to scanning; Finish bin sends the bin as it is for approval.' },
    { id: 'differences-none', label: 'No difference.', model: inBin(binOf(scannedLines), { step: { kind: 'done' }, done: done({ none: true, differences: DIFFERENCES.filter((row) => row.kind === 'MATCH') }) }) },
    { id: 'differences-moved', label: 'A move into the bin since the count started', model: inBin(binOf(withExtra), { step: { kind: 'done' }, done: done({ movedSinceStart: 1, note: { en: '1 move into or out of A1-STORE-01 since the count started (made up).', it: '1 movimento in entrata o in uscita da A1-STORE-01 da quando è iniziata la conta (inventato).' } }) }), note: 'Design live: "A move into the bin during the count → a note on the differences step."' },
    { id: 'finished', label: 'Bin finished', model: base({ step: { kind: 'finished' }, finish: { answer: finished(), ticks: 'recorded', place: STORE.code, count: CNT.number } }) },
    { id: 'finished-recounts', label: 'Bin finished: another person recounts', model: base({ step: { kind: 'finished' }, finish: { answer: finished({ recountsAsked: [{ lineId: 'ln-30', seq: 30 }, { lineId: 'ln-50', seq: 50 }] }), ticks: 'recorded', place: STORE.code, count: CNT.number } }), note: 'A hide that differs is over the recount rule: the system asks its recount at once.' },
    { id: 'finished-kept', label: 'Offline: bin finished on this tablet', model: base({ ...offline, step: { kind: 'finished' }, finish: { answer: null, ticks: 'saved', place: STORE.code, count: CNT.number, clientEventId: 'c-9' } }) },
    { id: 'refused-unknown', label: 'Refused: a label nothing carries', model: refused('UNKNOWN_LABEL', 'XYZ-123') },
    { id: 'refused-own-recount', label: 'Refused: the counter recounts', model: refused('OWN_RECOUNT', 'LOT-DEMO-0031', { bin: binOf([line(10, { item: lining, lot: { id: 'lot-31', code: 'LOT-DEMO-0031' }, pass: 'RECOUNT' })], { location: PICK }) }) },
    { id: 'refused-outside', label: 'Refused: not part of this count', model: refused('OUTSIDE_COUNT', 'LOT-DEMO-0040') },
    { id: 'refused-not-a-place', label: 'Refused: no place carries the label', model: base({ problem: { problem: { kind: 'refused', code: 'NOT_A_PLACE', message: '', fix: null }, code: 'BIN-B2-BULK-04' } }) },
    { id: 'refused-no-count', label: 'Refused: no count counts the bin', model: base({ problem: { problem: { kind: 'refused', code: 'NO_COUNT_HERE', message: '', fix: null }, code: 'A1-FG-01' } }) },
    { id: 'error', label: 'The office not answering', model: base({ problem: { problem: { kind: 'unavailable' }, code: 'BIN-A1-STORE-01' } }) },
    { id: 'notice-held', label: 'Scans held by the worker notice', model: base({ held: true }) },
    { id: 'no-permission', label: 'No permission', model: base({ step: { kind: 'noPermission' } }), note: 'A person without inventory.counts.scan (the tile is not shown to them either): fail closed.' },
  ],
})
