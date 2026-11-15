import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { zonedToday } from '../model'
import type { CarrierDay, CloseOutcome, EndOfDay, SheetShipment } from './api'
import { startChosen, type EndOfDayModel } from './model'
import { EndOfDayDialog } from './view/EndOfDayDialog'

/**
 * SCR-651 — End of day (B-W2b-412 on B-W2b-395; design warehouse.shipments pop-up sh-eod, the band's "End of day (W2b
 * manifest)"): per carrier the parcels handed over, what is still packed at the dock, a late hand-over, the preview, the close
 * and its outcome per carrier. Made-up data only (carriers "Demo Express", "Corriere Esempio"; customers "Moto Demo", "Esempio
 * Racing"; tracking numbers DEMO…).
 */

const uid = (n: number) => `0190f0e2-7415-7000-8000-${String(n).padStart(12, '0')}`
export const DAY = zonedToday()
const yesterday = new Date(Date.parse(`${DAY}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
const PREFIX = '/w/DEMO'

export const sheetRow = (n: number, over: Partial<SheetShipment> = {}): SheetShipment => ({
  id: uid(100 + n),
  number: `SH-26-01${String(n).padStart(2, '0')}`,
  consignee: n % 2 === 0 ? 'Moto Demo S.r.l.' : 'Esempio Racing S.p.A.',
  city: n % 2 === 0 ? 'Milano' : 'Bologna',
  country: 'IT',
  parcels: 2,
  weightKg: '11.800',
  trackingNumbers: [`DEMO${n}000451`, `DEMO${n}000452`],
  ddtNumber: `${150 + n}/2026`,
  shippedAt: `${DAY}T14:${String(10 + n).padStart(2, '0')}:00.000Z`,
  earlier: false,
  ...over,
})

const carrier = (code: string, name: string, over: Partial<CarrierDay> = {}): CarrierDay => {
  const shipments = over.shipments ?? [sheetRow(1), sheetRow(2)]
  return {
    carrierCode: code,
    carrierName: name,
    sheet: null,
    shipments,
    waiting: [],
    letGo: [],
    stillPacked: [],
    totals: { shipments: shipments.length, parcels: shipments.reduce((sum, row) => sum + row.parcels, 0), weightKg: shipments.length ? `${shipments.length * 11.8}` : '0' },
    may: { close: { allowed: shipments.length > 0, refusal: shipments.length > 0 ? null : { code: 'NOTHING_TO_CLOSE' } } },
    ...over,
  }
}

export const endOfDay = (over: Partial<EndOfDay> = {}): EndOfDay => ({
  siteId: uid(1),
  companyId: uid(2),
  site: { code: 'A1', name: 'Stabilimento Demo', timeZone: 'Europe/Rome' },
  day: DAY,
  today: DAY,
  carriers: [
    carrier('demo-express', 'Demo Express', { stillPacked: [{ id: uid(301), number: 'SH-26-0109', parcels: 1 }] }),
    carrier('esempio', 'Corriere Esempio', { shipments: [sheetRow(3), sheetRow(4, { earlier: true, shippedAt: `${yesterday}T17:40:00.000Z` })] }),
  ],
  toClose: ['demo-express', 'esempio'],
  ...over,
})

const CLOSED = (by: 'PERSON' | 'SYSTEM', code: string, name: string): CarrierDay => carrier(code, name, { sheet: { id: uid(code === 'esempio' ? 402 : 401), state: 'CLOSED', closedAt: `${DAY}T16:42:00.000Z`, closedBy: by, fileId: uid(410), version: 2 }, may: { close: { allowed: false, refusal: { code: 'ALREADY_CLOSED' } } } })

const model = (read: EndOfDay | null, over: Partial<EndOfDayModel> = {}): EndOfDayModel => ({
  siteId: uid(1),
  day: null,
  read: read ? { state: 'ready', value: read } : { state: 'loading' },
  chosen: read ? startChosen(read) : [],
  print: true,
  busy: false,
  problem: null,
  outcomes: null,
  preview: null,
  can: { manage: true },
  prefix: PREFIX,
  ...over,
})

const OUTCOMES: CloseOutcome[] = [
  { carrierCode: 'demo-express', closed: true, manifestId: uid(401), shipments: 2, parcels: 4, letGo: [], printJob: { id: uid(501), status: 'QUEUED' }, printProblem: null },
  { carrierCode: 'esempio', closed: true, manifestId: uid(402), shipments: 2, parcels: 4, letGo: [], printJob: null, printProblem: 'no printer' },
]

export const PREVIEW_PDF = samplePdf(['ANTEPRIMA / PREVIEW', 'Distinta di fine giornata — Demo Express', 'SH-26-0101 · SH-26-0102 · 4 colli · 23,6 kg'])

export const designScreen = defineDesignScreen<EndOfDayModel>({
  screen: 'SCR-651',
  title: 'End of day: per carrier the parcels handed over, the preview, close the day and print manifests',
  view: EndOfDayDialog,
  cases: [
    { id: 'today', label: 'Today: two carriers to close, one shipment still packed at the dock, a late hand-over', model: model(endOfDay()), note: 'Tick a carrier, the print switch; the day picker reaches the last 7 days.' },
    { id: 'preview', label: 'A carrier\'s preview (stored nowhere)', model: model(endOfDay(), { preview: { carrierCode: 'demo-express', pdf: { state: 'ready', value: PREVIEW_PDF } } }) },
    { id: 'preview-loading', label: 'The preview being made', model: model(endOfDay(), { preview: { carrierCode: 'demo-express', pdf: { state: 'loading' } } }) },
    { id: 'closed', label: 'Closed: one printed, one not printed (no printer): open each manifest in a new tab', model: model(endOfDay(), { outcomes: OUTCOMES }) },
    { id: 'refused', label: 'A carrier refused in the close (the day changed meanwhile)', model: model(endOfDay(), { outcomes: [{ carrierCode: 'demo-express', closed: false, refusal: { code: 'DAY_CHANGED' }, printJob: null, printProblem: null }, OUTCOMES[1]!] }) },
    { id: 'all-closed', label: 'Every sheet of the day closed: by a person and by the system', model: model(endOfDay({ carriers: [CLOSED('PERSON', 'demo-express', 'Demo Express'), CLOSED('SYSTEM', 'esempio', 'Corriere Esempio')], toClose: [] })) },
    { id: 'waiting', label: 'Closed, then more left: on the next day\'s sheet; an open sheet lets one go', model: model(endOfDay({ carriers: [{ ...CLOSED('PERSON', 'demo-express', 'Demo Express'), waiting: [sheetRow(5)] }, carrier('esempio', 'Corriere Esempio', { letGo: [{ id: uid(302), number: 'SH-26-0110', status: 'PACKED' }] })], toClose: ['esempio'] })) },
    { id: 'nothing', label: 'Nothing handed over to a carrier on this day', model: model(endOfDay({ carriers: [], toClose: [] })) },
    { id: 'earlier-day', label: 'An earlier day: the system closes what is left after the site\'s day', model: model(endOfDay({ day: yesterday })) },
    { id: 'no-print', label: 'Close without printing', model: model(endOfDay(), { print: false }) },
    { id: 'no-right', label: 'Without shipping.manage: the close held with why', model: model(endOfDay(), { can: { manage: false } }) },
    { id: 'loading', label: 'Reading the day', model: model(null) },
    { id: 'error', label: 'The day could not be read: Try again', model: model(null, { read: { state: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})
