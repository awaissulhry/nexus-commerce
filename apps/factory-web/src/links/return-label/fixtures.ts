import { defineDesignScreen } from '../../lib/design/design-screen'
import type { ReturnLabelPage } from './api'
import { initialLinkModel, type ReturnLabelLinkModel } from './model'
import { ReturnLabelLinkView } from './view/ReturnLabelLinkView'

/**
 * SCR-436 — Your return label (B-W2b-398; LOG-112 "a link that books the carrier only when used"; the RETURN_LABEL link's
 * page). Made-up data only: return RMA-26-0007 of "Demo Moto Shop", our made-up return address.
 */

const page = (over: Partial<ReturnLabelPage> = {}): ReturnLabelPage => ({
  return: { number: 'RMA-26-0007', customerRef: 'RESO-118', status: 'AUTHORISED', goodsDueBy: '2026-11-26' },
  companyName: 'Demo Factory S.r.l.',
  lines: [
    { seq: 1, description: 'GP-REPLICA jacket · black', size: '52', quantity: 1 },
    { seq: 2, description: 'GP-REPLICA trousers · black', size: '50', quantity: 1 },
  ],
  label: { status: 'OFFERED', carrierCode: 'brt', bookingReference: null, hasPdf: false, usedAt: null },
  bookHeld: null,
  from: { city: 'Bologna', postalCode: '40121', country: 'IT' },
  to: { name: 'Demo Factory S.r.l.', companyName: 'Demo Factory S.r.l.', line1: 'Via dei Campioni 1', line2: null, postalCode: '61100', city: 'Pesaro', province: 'PU', country: 'IT' },
  link: { expiresAt: '2026-12-12T09:30:00.000Z' },
  ...over,
})

const model = (over: Partial<ReturnLabelLinkModel> = {}, data: Partial<ReturnLabelPage> = {}): ReturnLabelLinkModel => ({ ...initialLinkModel, page: page(data), ...over })
const booked = { status: 'BOOKED' as const, carrierCode: 'brt', bookingReference: 'FK1A2B3C4D5E6F', hasPdf: true, usedAt: null }

export const designScreen = defineDesignScreen<ReturnLabelLinkModel>({
  screen: 'SCR-436',
  title: 'Your return label (a RETURN_LABEL link: book the carrier when the goods go, print the label)',
  view: ReturnLabelLinkView,
  cases: [
    { id: 'offered', label: 'Not booked yet: Book the carrier', model: model() },
    { id: 'booking', label: 'Booking the carrier', model: model({ busy: 'book' }) },
    { id: 'booked', label: 'Booked: Download the label', model: model({}, { label: booked }) },
    { id: 'downloading', label: 'Downloading the label', model: model({ busy: 'download' }, { label: booked }) },
    { id: 'used', label: 'The parcel reached us', model: model({}, { return: { ...page().return, status: 'RECEIVED' }, label: { ...booked, status: 'USED', usedAt: '2026-11-15T10:20:00.000Z' } }) },
    { id: 'held', label: 'Cannot be booked from here now: held with why', model: model({}, { bookHeld: 'NO_CARRIER_ACCOUNT' }) },
    { id: 'refused', label: 'The carrier did not book it: in words', model: model({ problem: 'link.held.CARRIER' }) },
    { id: 'offline', label: 'Offline: Book held with the reason', model: model({ offline: true }) },
    { id: 'gone', label: 'The label was withdrawn: the link opens nothing', model: { ...initialLinkModel, link: 'unavailable' } },
    { id: 'expired', label: 'The link expired', model: { ...initialLinkModel, link: 'expired' } },
    { id: 'read-failed', label: 'Could not be opened: Try again', model: { ...initialLinkModel, problem: 'link.problem.read' } },
    { id: 'loading', label: 'Loading', model: initialLinkModel },
  ],
})
