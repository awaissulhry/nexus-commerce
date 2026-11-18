import { describe, expect, it } from 'vitest'
import {
  FLOOR_CHANGE_KINDS,
  FLOOR_NOTE_MAX,
  clockOf,
  closingLineOf,
  floorNoteKindOf,
  floorNoteOf,
  noPriceIn,
  systemLineOf,
  workOrderList,
  WORKSHOP_CHANGES,
  type SystemLine,
} from './change-notes'
import { changeWhatOf } from '../../notifications/rules'
import { EVENT_CATALOGUE } from '../../events/catalogue'

/**
 * B-SA-052 / B-SA-053 / B-SA-054 — the words of one change of a sales order (sales page plan P8', R2, R7, R9; 14-change-flow §4.1,
 * §5.3), pure: the system line (office), the floor note (floor words, the customer's code, no person, no price), the kinds. Every
 * name and number is made up (Brand Alpha, Bea Esempio).
 */

const AT = new Date('2026-11-18T09:42:00.000Z') // 10:42 in Rome
const ASKED = new Date('2026-11-18T09:05:00.000Z') // 10:05 in Rome
const ROME = 'Europe/Rome'

const accepted: SystemLine = {
  head: { kind: 'ACCEPTED', by: 'Bea Esempio' },
  at: AT,
  asked: { customer: 'Brand Alpha', at: ASKED, what: { kind: 'SIZES', lines: [{ seq: 2, cells: [{ size: 'M', from: 40, to: 36 }, { size: 'L', from: 20, to: 24 }] }] } },
  done: [{ kind: 'AMENDED', revision: 3 }],
  next: [{ kind: 'WORK_ORDER', workOrder: { number: 'WO-0142' } }, { kind: 'NEW_WORK_ORDER' }],
  told: { people: 6, floor: [{ number: 'WO-0142' }, { number: 'WO-0143' }], workshops: [{ number: 'WO-0143' }] },
}

describe('B-SA-052: the system line, in the company language', () => {
  it('reads as 14-change-flow §4.1 shows it, in Italian and English, the headline first (what the bell quotes)', () => {
    expect(systemLineOf(accepted, 'it', ROME).split('\n')).toEqual([
      'Modifica accettata · Bea Esempio · 10:42',
      'Brand Alpha ha chiesto (portale, 10:05): riga 2 · M 40 → 36 · L 20 → 24.',
      'Fatto: ordine modificato (revisione 3).',
      'Prossimi: WO-0142 (inviato alla pianificazione) · un nuovo ordine di lavoro (inviato alla pianificazione).',
      'Avvisati: 6 persone in ufficio · il reparto di WO-0142, WO-0143 · il terzista di WO-0143',
    ])
    expect(systemLineOf(accepted, 'en', ROME).split('\n')).toEqual([
      'Change accepted · Bea Esempio · 10:42',
      'Brand Alpha asked (portal, 10:05): line 2 · M 40 → 36 · L 20 → 24.',
      'Done: order amended (revision 3).',
      'Next: WO-0142 (sent to planning) · a new work order (sent to planning).',
      'Told: 6 people in the office · the floor of WO-0142, WO-0143 · the workshop of WO-0143',
    ])
    expect(changeWhatOf(systemLineOf(accepted, 'en', ROME))).toBe('Change accepted · Bea Esempio · 10:42')
  })

  it('never prints a mixed work order\'s number (R7): "a work order" for every reader, counted when several', () => {
    const mixed = systemLineOf({ ...accepted, next: [{ kind: 'WORK_ORDER', workOrder: { number: null } }], told: { people: 1, floor: [{ number: 'WO-0142' }, { number: null }, { number: null }], workshops: [] } }, 'en', ROME)
    expect(mixed).toContain('Next: a work order (sent to planning).')
    expect(mixed).toContain('Told: 1 person in the office · the floor of WO-0142, 2 work orders')
    expect(workOrderList([{ number: null }], 'it')).toBe('un ordine di lavoro')
    expect(workOrderList([{ number: 'WO-2' }, { number: 'WO-1' }, { number: 'WO-1' }], 'en')).toBe('WO-1, WO-2')
  })

  it('a refusal and a withdrawal are short lines; the refusal words only without a price', () => {
    const refused = systemLineOf({ head: { kind: 'REFUSED', by: 'Bea Esempio' }, at: AT, asked: null, answer: 'We cannot change sizes after cutting.', done: [], next: [], told: { people: 2, floor: [], workshops: [] } }, 'en', ROME)
    expect(refused.split('\n')).toEqual(['Refused · Bea Esempio · 10:42', '“We cannot change sizes after cutting.”', 'Told: 2 people in the office'])
    const priced = systemLineOf({ head: { kind: 'REFUSED', by: 'Bea Esempio' }, at: AT, asked: null, answer: 'Only for € 40 more.', done: [], next: [], told: null }, 'en', ROME)
    expect(priced).toBe('Refused · Bea Esempio · 10:42')
    expect(systemLineOf({ head: { kind: 'WITHDRAWN', customer: 'Brand Alpha' }, at: AT, done: [], next: [], told: null }, 'it', ROME)).toBe('Ritirata da Brand Alpha · 10:42')
  })

  it('an office change, a production step, and the closing line when the last step of a change closes', () => {
    const office = systemLineOf({ head: { kind: 'CHANGED', by: null }, at: AT, done: [{ kind: 'LINES_CLOSED', seqs: [10, 20] }, { kind: 'PROMISE', from: '2026-12-01', to: '2026-12-08' }, { kind: 'PAUSED', workOrders: [{ number: 'WO-0142' }] }], next: [], told: null }, 'en', ROME)
    expect(office.split('\n')).toEqual(["Order changed · someone in the office · 10:42", 'Done: lines 10, 20 closed · promise date 01/12/2026 → 08/12/2026 · WO-0142 paused.'])
    const step = systemLineOf({ head: { kind: 'WORK_ORDER', by: 'Carla Prova' }, at: AT, done: [{ kind: 'WORK_ORDER_CHANGED', workOrder: { number: 'WO-0142' }, cells: [{ size: 'M', from: 40, to: 36 }] }], next: [], told: null, closing: { at: ASKED } }, 'it', ROME)
    expect(step.split('\n')).toEqual(['Ordine di lavoro cambiato · Carla Prova · 10:42', 'Fatto: WO-0142 cambiato: M 40 → 36.', 'Modifica del 18/11 10:05 eseguita: non resta nulla da fare.'])
    expect(closingLineOf(ASKED, 'en', ROME)).toBe('Change of 18/11 10:05 carried out: nothing left to do.')
    const left = systemLineOf({ head: { kind: 'WORK_ORDER', by: 'Carla Prova' }, at: AT, done: [{ kind: 'LEFT_AS_IS', workOrder: { number: null }, why: 'The customer takes them after all' }], next: [], told: null }, 'it', ROME)
    expect(left).toContain('Fatto: un ordine di lavoro lasciato così (The customer takes them after all).')
  })

  // ---- B-SA-053b: the work order's NEW cells after the apply (Lower to the order keeps what is cut), never the ask's figure; the
  // extra pieces it keeps, with their outcome, in the office line only — the floor reads the cells to cut and nothing more.
  it('a work-order change applied: the work order\'s new cells, then the extra pieces it keeps and their outcome (office only)', () => {
    const kept = systemLineOf({ head: { kind: 'WORK_ORDER', by: 'Carla Prova' }, at: AT, done: [{ kind: 'WORK_ORDER_CHANGED', workOrder: { number: 'WO-0142' }, cells: [{ size: '52', from: 4, to: 3 }], extra: { count: 2, outcome: 'LEFTOVER' } }], next: [], told: null }, 'it', ROME)
    expect(kept.split('\n')[1]).toBe('Fatto: WO-0142 cambiato: 52 4 → 3 · 2 pezzi in più tenuti come rimanenza del cliente.')
    const charged = systemLineOf({ head: { kind: 'WORK_ORDER', by: 'Carla Prova' }, at: AT, done: [{ kind: 'WORK_ORDER_CHANGED', workOrder: { number: 'WO-0142' }, cells: [{ size: '52', from: 4, to: 3 }], extra: { count: 1, outcome: 'CHARGE' } }], next: [], told: null }, 'en', ROME)
    expect(charged.split('\n')[1]).toBe('Done: WO-0142 changed: 52 4 → 3 · 1 extra piece kept and charged to the customer.')
    expect(noPriceIn(charged)).toBe(true)
    const scrap = systemLineOf({ head: { kind: 'WORK_ORDER', by: null }, at: AT, done: [{ kind: 'WORK_ORDER_CHANGED', workOrder: { number: 'WO-0142' }, cells: [{ size: '52', from: 4, to: 3 }], extra: { count: 2, outcome: 'SCRAP' } }], next: [], told: null }, 'en', ROME)
    expect(scrap).toContain('52 4 → 3 · 2 extra pieces to scrap, with their approval')
    const none = systemLineOf({ head: { kind: 'WORK_ORDER', by: null }, at: AT, done: [{ kind: 'WORK_ORDER_CHANGED', workOrder: { number: 'WO-0142' }, cells: [{ size: '52', from: 4, to: 1 }], extra: null }], next: [], told: null }, 'en', ROME)
    expect(none).toContain('WO-0142 changed: 52 4 → 1.')
    // The floor reads the work order's own figure to cut: no extra pieces, no outcome, no customer's name.
    const floor = floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'APPLIED', cells: [{ size: '52', quantity: 3 }] }] }, 'it')
    expect(floor).toBe('WO-0142 cambiato: taglia 52 3.')
    expect(floor).not.toMatch(/in più|rimanenza|addebit|scart/)
  })
  // ---- end B-SA-053b

  it('holds no price, whatever it says (a text scan)', () => {
    for (const locale of ['it', 'en'] as const) expect(noPriceIn(systemLineOf(accepted, locale, ROME))).toBe(true)
    expect(noPriceIn('Only for € 40 more.')).toBe(false)
    expect(noPriceIn('Il prezzo cambia.')).toBe(false)
    expect(clockOf(new Date('2026-07-01T06:05:00.000Z'), ROME)).toBe('08:05')
  })
})

describe('B-SA-053: the floor note — floor words, the customer code, no person, no price, the kind read now', () => {
  it('names the sizes now and before, and asks to wait before cutting what is not cut yet', () => {
    const note = floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'SIZES', cells: [{ size: 'M', from: 40, to: 36 }], waitSizes: ['M'] }] }, 'en')
    expect(note).toBe('Order change on WO-0142 (P1): size M now 36 (was 40). Wait for the new work-order numbers before cutting M.')
    expect(floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'SIZES', cells: [{ size: 'M', from: 40, to: 36 }], waitSizes: ['M'] }] }, 'it')).toBe(
      "Modifica d'ordine su WO-0142 (P1): taglia M ora 36 (erano 40). Aspetta i nuovi numeri dell'ordine di lavoro prima di tagliare M.",
    )
  })

  it('a work order of several customers names no customer at all; the other changes in floor words', () => {
    expect(floorNoteOf({ workOrder: 'WO-0007', customerCode: null, changes: [{ kind: 'SIZES', cells: [{ size: '52', from: 4, to: 3 }], waitSizes: [] }] }, 'en')).toBe('Order change on WO-0007: size 52 now 3 (was 4).')
    expect(floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'APPLIED', cells: [{ size: 'M', quantity: 36 }, { size: 'L', quantity: 24 }] }] }, 'en')).toBe('WO-0142 changed: cut M 36, L 24.')
    expect(floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'PAUSED' }] }, 'it')).toBe("Fermato dall'ufficio. Non iniziare nuovi fasci. Chiedi al tuo capoturno.")
    expect(floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'RESUMED' }] }, 'en')).toBe('Work goes on: the pause is lifted.')
    expect(floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'RUSH' }] }, 'it')).toBe('Urgente: WO-0142 va per primo.')
    expect(floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'DESIGN', changeRequest: 'CR-0031', revision: 2 }] }, 'en')).toBe('Design change coming (CR-0031): keep to revision 2 until the office decides.')
    expect(floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'LINES_CLOSED', seqs: [10] }] }, 'en')).toContain('line 10 is closed')
    expect(floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: [{ kind: 'LEFT_AS_IS' }] }, 'en')).toBe('WO-0142: no change after all, cut as planned.')
  })

  it('stays within what a tablet shows, and holds no price', () => {
    const long = floorNoteOf({ workOrder: 'WO-0142', customerCode: 'P1', changes: Array.from({ length: 80 }, (_, index) => ({ kind: 'SIZES' as const, cells: [{ size: `S${index}`, from: 40, to: 36 }], waitSizes: [`S${index}`] })) }, 'en')
    expect(long.length).toBeLessThanOrEqual(FLOOR_NOTE_MAX)
    expect(long.endsWith('…')).toBe(true)
    expect(noPriceIn(long)).toBe(true)
  })

  it('reads STOP while the work order is held, else CHECK; the workshop hears only of quantity changes', () => {
    expect(floorNoteKindOf('ON_HOLD')).toBe('STOP')
    for (const status of ['RELEASED', 'IN_PROGRESS']) expect(floorNoteKindOf(status)).toBe('CHECK')
    expect([...WORKSHOP_CHANGES]).toEqual(['SIZES', 'LINES_CLOSED', 'APPLIED'])
    for (const kind of WORKSHOP_CHANGES) expect(FLOOR_CHANGE_KINDS).toContain(kind)
  })
})

describe('B-SA-053: production.floor_note_posted — the tablets of its site re-read My work; nothing about who saw it (R2)', () => {
  it('reaches the floor (floor.work) and the office (workorders.view) with ids and a number only', () => {
    const posted = EVENT_CATALOGUE.get('production.floor_note_posted', 1)
    expect(posted.live).toMatchObject({ permission: 'workorders.view', floor: 'floor.work' })
    for (const key of ['partyId', 'salesOrderId', 'changes']) expect(posted.live!.fields).not.toContain(key)
    const ok = { workOrderId: '00000000-0000-7000-8000-000000000001', number: 'WO-0142', siteId: '00000000-0000-7000-8000-000000000002', partyId: null, messageId: '00000000-0000-7000-8000-000000000003', salesOrderId: '00000000-0000-7000-8000-000000000004', changes: ['SIZES'] }
    expect(posted.payload.safeParse(ok).success).toBe(true)
    expect(posted.payload.safeParse({ ...ok, changes: [] }).success).toBe(false)
    expect(posted.payload.safeParse({ ...ok, seenBy: 'SEW-01' }).success).toBe(false)
    expect([...EVENT_CATALOGUE.types()].filter((type) => /seen/.test(type))).toEqual([])
  })
})
