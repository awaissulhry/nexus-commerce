import type { FileAsk, OrderFilesRead } from '../model'
import { newAskDraft, type AskAbilities, type AsksState } from './asks'

/**
 * F-OF-201 (order FILES tab W2) — made-up asks for the design index (15-steps: "Build the band and dialog on 13-backend §2's contract + a
 * gallery case FIRST"): one ARRIVED from the office role "Pattern maker" (Line 1), one 2 days LATE to the "Sewing team" for photos of step 3
 * of WO-0041, one OPEN asked of the reader (an office person), a priced ask counted, one outside the reader's role, a customer's portal ask.
 * Fake data only (Seed Customer One, Alex Demo, Paola Disegno, Carlo Prova); never a floor worker's name.
 */

const ask = (id: string, over: Partial<FileAsk>): FileAsk => ({
  id,
  version: 1,
  status: 'OPEN',
  words: 'Pattern PDF, size 50, with seam allowances',
  priced: false,
  bodyData: false,
  fileKind: 'DOCUMENT',
  lands: { type: 'SalesOrderLine', id: 'line-1', label: 'Line 1 · SEED-JKT-02 Black', step: null },
  who: { kind: 'OFFICE_ROLE', label: 'Pattern maker' },
  forMe: false,
  dueOn: '2026-11-25',
  lateDays: 0,
  askedBy: { name: 'Alex Demo' },
  askedAt: '2026-11-18T10:40:00Z',
  rounds: 0,
  lastReason: null,
  chasedAt: null,
  answered: null,
  may: { answer: true, decide: true, change: true },
  ...over,
})

/** The order's files read with its asks: the arrived file is the read's first line file (ringed "For an ask — check it"). */
export function withAsks(read: OrderFilesRead): OrderFilesRead {
  const arrivedFile = read.groups.find((group) => group.key === 'LINES')?.files[0]?.id ?? read.groups[0]?.files[0]?.id ?? 'file-1'
  return {
    ...read,
    asks: [
      ask('ask-arrived', { status: 'ARRIVED', answered: { at: '2026-11-21T16:05:00Z', by: { kind: 'OFFICE', name: 'Paola Disegno' }, fileIds: [arrivedFile], held: 0 } }),
      ask('ask-late', { words: 'Photos of the collar seam, front and back, before pressing', fileKind: 'PHOTO', lands: { type: 'WorkOrder', id: 'wo-41', label: 'WO-0041', step: { id: 'op-3', seq: 3, name: 'Sewing' } }, who: { kind: 'FLOOR_TEAM', label: 'Sewing team' }, dueOn: '2026-11-20', lateDays: 2, askedAt: '2026-11-17T09:12:00Z', chasedAt: '2026-11-21T08:30:00Z' }),
      ask('ask-mine', { words: 'Care label artwork, Italian and English', lands: { type: 'SalesOrderLine', id: 'line-3', label: 'Line 3 · SEED-PNT-04 Navy', step: null }, who: { kind: 'PERSON', label: 'Carlo Prova' }, forMe: true, dueOn: '2026-11-28', askedAt: '2026-11-20T11:00:00Z' }),
      ask('ask-priced', { words: null, priced: true, may: { answer: false, decide: false, change: false } }),
    ],
    asksLeftOut: 1,
    customerAsks: [{ id: 'portal-1', words: { it: 'Carica un documento', en: 'Upload a document' }, dueOn: '2026-11-27', lateDays: 0, status: 'OPEN' }],
  }
}

const OWNER: AskAbilities = { ask: true, askCustomer: true, share: true, closed: false, readOnly: false }

/** The band's state for the design index (no window open, every list read). */
export function asksState(over: Partial<AsksState> = {}): AsksState {
  return {
    can: OWNER,
    window: null,
    choices: {
      people: { state: 'ready', items: [{ id: 'user-carlo', name: 'Carlo Prova' }, { id: 'user-paola', name: 'Paola Disegno' }] },
      officeRoles: { state: 'ready', items: [{ id: 'role-pattern', name: 'Pattern maker' }] },
      floorRoles: { state: 'ready', items: [{ id: 'role-cutter', name: 'Cutter' }] },
      teams: { state: 'ready', items: [{ id: 'team-sewing', name: 'Sewing team' }] },
      steps: { state: 'ready', items: [{ id: 'op-3', seq: 3, name: 'Sewing' }] },
      lines: [{ id: 'line-1', seq: 1, what: 'SEED-JKT-02 Black' }, { id: 'line-3', seq: 3, what: 'SEED-PNT-04 Navy' }],
      workOrders: [{ id: 'wo-41', number: 'WO-0041', siteId: 'site-a1' }],
    },
    busy: false,
    problem: null,
    notice: null,
    today: '2026-11-22',
    ...over,
  }
}

/** The "Ask for a file…" window open on a draft to the office role (a line, due 25 Nov). */
export const ASK_WINDOW_STATE = asksState({ window: { kind: 'ask', draft: { ...newAskDraft('2026-11-25'), words: 'Pattern PDF, size 50, with seam allowances', who: 'OFFICE_ROLE', pick: 'role-pattern', where: 'SALES_ORDER_LINE', lineId: 'line-1' } } })
