import type { OrderLinks } from './api'
import { readyLinks, type LinksModel } from './model'

/**
 * B-TH-256 — design only: what points at SO-2026-0088 (Moto Demo S.r.l., made up), for SCR-039's cases and the tests. No
 * `designScreen` here: the order's screen draws these. Every number, name and note is invented.
 */

const id = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

export const LINKS_ORDER = { id: id('5151', 88), number: 'SO-2026-0088' }

/** Two complaints and one return of the order (the reader holds both rights); one re-promise waiting; one gate refusal. */
export const LINKS_FULL: OrderLinks = {
  order: LINKS_ORDER,
  complaints: [
    { id: id('6501', 1), number: 'RCL-2026-0012', status: 'INVESTIGATING', receivedAt: '2026-11-03T09:40:00.000Z', category: 'STITCHING', severity: 'MAJOR', answerDueOn: '2026-11-20' },
    { id: id('6501', 2), number: 'RCL-2026-0009', status: 'CLOSED', receivedAt: '2026-10-21T15:05:00.000Z', category: 'SIZE', severity: 'MINOR', answerDueOn: null },
  ],
  returns: [{ id: id('6502', 1), number: 'RMA-2026-0031', status: 'AUTHORISED', requestedAt: '2026-11-05T10:12:00.000Z', closedAt: null, outcomeWanted: 'REPLACE' }],
  rePromises: [
    {
      id: id('6503', 1),
      state: 'WAITING',
      line: { id: id('6504', 20), seq: 20, styleCode: 'AX-100' },
      sizes: [
        { size: '50', from: '2026-12-22', to: '2027-01-12' },
        { size: '52', from: '2026-12-22', to: '2027-01-12' },
      ],
      reasonCode: 'MATERIAL_LATE',
      reason: 'The red leather arrives two weeks late (made-up note).',
      words: 'Line 20: sizes 50 and 52 on 12 January.',
      proposedAt: '2026-11-16T08:30:00.000Z',
      proposedBy: { id: id('6505', 1), name: 'Paola Esempio' },
      may: { accept: true, decline: true, tell: true },
    },
  ],
  gates: [
    {
      eventId: id('6506', 1),
      gate: 'WORK_ORDER_RELEASE',
      place: 'work-order release',
      at: '2026-11-15T14:20:00.000Z',
      subject: { type: 'WorkOrder', id: id('6507', 1), number: 'WO-2026-0140' },
      styleCode: 'AX-100',
      reason: 'No valid EU type-examination certificate covers AX-100 in size 54: the compliance office adds it or overrides with a reason.',
    },
  ],
  asOf: '2026-11-17T08:00:00.000Z',
}

/** Nothing points at the order (both lists empty, nothing waits, nothing blocks). */
export const LINKS_NONE: OrderLinks = { ...LINKS_FULL, complaints: [], returns: [], rePromises: [], gates: [] }

/** The production manager: reads the proposal, may not decide it (orders.manage), no complaint or return right, no compliance view. */
export const LINKS_MANAGER: OrderLinks = {
  ...LINKS_FULL,
  complaints: null,
  returns: null,
  rePromises: LINKS_FULL.rePromises.map((proposal) => ({ ...proposal, may: { accept: false, decline: false, tell: false } })),
  gates: LINKS_FULL.gates.map((gate) => ({ ...gate, eventId: null })),
}

export const linksModel = (links: OrderLinks, over: Partial<Extract<LinksModel, { state: 'ready' }>> = {}): LinksModel => ({ ...(readyLinks(links) as Extract<LinksModel, { state: 'ready' }>), ...over })
