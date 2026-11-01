import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { dispatchOrder } from '../../planning/schedule/dispatch'
import { beforeRelease, blockingCodes, RELEASE_BULK_LIMIT, releaseFieldOf } from './bulk'
import { PRIORITY_LIMITS, RUSH_CHOICES, rushChoiceOf, rushOfChoice, urgencyHeld, urgencyOrder } from './priority'
import { splitPlan, splitProblems, splitRefusal, type SplitCell } from './split'
import { travellerPaper, travellerQrText, type TravellerFacts } from './traveller'

// B-W2b-51: work orders every shift. Every id, code, number and name is made up.
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`

describe('priority and the rush flag (MES-009)', () => {
  it('puts rush first, then the higher priority, then the earlier due date (none last), then the number', () => {
    const keys = [
      { rush: false, priority: 9, dueDate: '2026-11-01', number: 'WO-A' },
      { rush: true, priority: 0, dueDate: '2026-12-20', number: 'WO-B' },
      { rush: false, priority: 0, dueDate: null, number: 'WO-C' },
      { rush: false, priority: 0, dueDate: '2026-11-15', number: 'WO-D' },
      { rush: true, priority: 3, dueDate: null, number: 'WO-E' },
      { rush: false, priority: 0, dueDate: '2026-11-15', number: 'WO-F' },
    ]
    expect([...keys].sort(urgencyOrder).map((key) => key.number)).toEqual(['WO-E', 'WO-B', 'WO-A', 'WO-D', 'WO-F', 'WO-C'])
  })

  it('the dispatch list orders rush first too, then priority, due date, start and sequence (a key without rush is not rush)', () => {
    const keys = [
      { priority: 5, dueDate: '2026-11-18', startAt: 1, seq: 10, workOrderNumber: 'P' },
      { rush: true, priority: 0, dueDate: '2026-12-01', startAt: 9, seq: 10, workOrderNumber: 'R' },
      { rush: false, priority: 0, dueDate: '2026-11-18', startAt: 2, seq: 10, workOrderNumber: 'N' },
    ]
    expect([...keys].sort(dispatchOrder).map((key) => key.workOrderNumber)).toEqual(['R', 'P', 'N'])
  })

  it('writes the flag as a choice for the list frame, and keeps both once closed or cancelled', () => {
    expect(RUSH_CHOICES).toEqual(['RUSH', 'NORMAL'])
    expect([rushChoiceOf(true), rushChoiceOf(false)]).toEqual(['RUSH', 'NORMAL'])
    expect([rushOfChoice('RUSH'), rushOfChoice('NORMAL'), rushOfChoice('rush')]).toEqual([true, false, false])
    expect(PRIORITY_LIMITS).toEqual({ min: -1000, max: 1000 })
    expect(urgencyHeld('WO-1', 'IN_PROGRESS')).toBeNull()
    expect(urgencyHeld('WO-1', 'CLOSED')).toBe('Work order WO-1 is CLOSED; only its note changes.')
    expect(urgencyHeld('WO-1', 'CANCELLED')).not.toBeNull()
  })

  it('declares workorder.priority_changed for the office and the tablets, and the split in workorder.created and .changed', () => {
    const changed = EVENT_CATALOGUE.get('workorder.priority_changed', 1)
    expect(changed.live).toMatchObject({ permission: 'workorders.view', floor: 'floor.work' })
    const payload = { workOrderId: id(1), number: 'WO-1', siteId: id(2), priority: 3, rush: true, previousPriority: 0, previousRush: false }
    expect(EVENT_CATALOGUE.parse('workorder.priority_changed', 1, payload)).toEqual(payload)
    // No person and no money: an extra field is refused.
    expect(() => EVENT_CATALOGUE.parse('workorder.priority_changed', 1, { ...payload, changedBy: 'someone' })).toThrow()
    expect(() => EVENT_CATALOGUE.parse('workorder.created', 1, { workOrderId: id(3), number: 'WO-2', siteId: id(2), styleId: id(4), salesOrderIds: [id(5)], cells: 1, pieces: 4, splitFromId: id(1) })).not.toThrow()
    expect(() => EVENT_CATALOGUE.parse('workorder.changed', 1, { workOrderId: id(1), number: 'WO-1', changes: ['cells', 'split'], cells: 1, pieces: 6 })).not.toThrow()
  })
})

describe('split a work order (MES-010)', () => {
  const cells: SplitCell[] = [
    { id: id(11), label: 'BLK 50', quantity: 4 },
    { id: id(12), label: 'BLK 52', quantity: 6 },
  ]

  it('splits only a DRAFT size grid, and says why not in words', () => {
    expect(splitRefusal({ number: 'WO-1', status: 'DRAFT', kind: 'SIZE_GRID' })).toBeNull()
    expect(splitRefusal({ number: 'WO-1', status: 'RELEASED', kind: 'SIZE_GRID' })).toBe(
      'Work order WO-1 is RELEASED; its sizes were frozen at its release (MES-005), so only a DRAFT is split. Make a new work order for what is still open on the order lines instead.',
    )
    expect(splitRefusal({ number: 'WO-1', status: 'ON_HOLD', kind: 'SIZE_GRID' })).toContain('only a DRAFT is split')
    expect(splitRefusal({ number: 'WO-1', status: 'DRAFT', kind: 'REPAIR' })).toBe('Work order WO-1 repairs one garment of its repair order: there is nothing to split.')
    expect(splitRefusal({ number: 'WO-1', status: 'DRAFT', kind: 'MADE_TO_MEASURE' })).toBe('Work order WO-1 makes one made-to-measure unit: there is nothing to split.')
  })

  it('moves whole cells and parts of cells, and keeps the rest', () => {
    const asked = [
      { cellId: id(11), quantity: 4 },
      { cellId: id(12), quantity: 2 },
    ]
    expect(splitProblems(cells, asked)).toEqual([])
    expect(splitPlan(cells, asked)).toEqual({
      keep: [{ cellId: id(12), quantity: 4 }],
      remove: [id(11)],
      move: [
        { fromCellId: id(11), quantity: 4 },
        { fromCellId: id(12), quantity: 2 },
      ],
      moved: 6,
      kept: 4,
    })
  })

  it('refuses an unknown or repeated cell, more pieces than the cell has, nothing asked and moving everything', () => {
    expect(splitProblems(cells, [])).toEqual([{ path: 'body/cells', message: 'Choose at least one size to move.' }])
    expect(splitProblems(cells, [{ cellId: id(99), quantity: 1 }])).toEqual([{ path: 'body/cells/0/cellId', message: 'Not a cell of this work order.' }])
    expect(
      splitProblems(cells, [
        { cellId: id(12), quantity: 1 },
        { cellId: id(12), quantity: 1 },
      ]),
    ).toEqual([{ path: 'body/cells/1/cellId', message: 'BLK 52 is named twice.' }])
    expect(splitProblems(cells, [{ cellId: id(11), quantity: 5 }])).toEqual([{ path: 'body/cells/0/quantity', message: 'BLK 50 has 4 piece(s): move at most 4.' }])
    expect(splitProblems(cells, [{ cellId: id(11), quantity: 0 }])).toEqual([{ path: 'body/cells/0/quantity', message: 'Move at least one piece.' }])
    expect(
      splitProblems(cells, [
        { cellId: id(11), quantity: 4 },
        { cellId: id(12), quantity: 6 },
      ]),
    ).toEqual([{ path: 'body/cells', message: 'Keep at least one piece on this work order: moving everything is not a split (change the due date, priority or rush flag instead).' }])
  })
})

describe('the traveller (MES-014)', () => {
  const facts: TravellerFacts = {
    number: 'WO-00042',
    batchNumber: 'BA-00007',
    status: 'RELEASED',
    kind: 'SIZE_GRID',
    rush: true,
    priority: 5,
    dueDate: '2026-11-20',
    site: { code: 'A1', name: 'Made-up plant' },
    style: { code: 'JKT-DEMO', name: 'Demo jacket' },
    revision: 3,
    orders: ['SO-DEMO-1', 'SO-DEMO-2'],
    splitFrom: 'WO-00041',
    note: 'Pack in pairs',
    holdReason: null,
    releasedAt: new Date('2026-11-02T09:30:00.000Z'),
    sizes: ['50', '52', '54'],
    cells: [
      { colourway: 'BLK · Black', size: '52', quantity: 3 },
      { colourway: 'BLK · Black', size: '50', quantity: 2 },
      { colourway: 'RED · Red', size: '52', quantity: 1 },
    ],
    frozen: true,
    operations: [
      { seq: 10, code: 'CUT', name: 'Cut leather', workCentre: 'CUT', standardMinutes: '14', scanRequired: true },
      { seq: 20, code: 'SEW', name: 'Sew', workCentre: 'SEW', standardMinutes: '96.5', scanRequired: true },
    ],
    materials: [{ code: 'LEA', name: 'Leather', colour: 'BLK', planned: '247.52', uom: 'FT2' }],
    printedAt: new Date('2026-11-03T08:15:00.000Z'),
    timeZone: 'Europe/Rome',
  }

  it('puts the number in the QR code, the batch, the rush flag, the facts and the three tables in the language asked', () => {
    const paper = travellerPaper(facts, 'it')
    expect(paper).toMatchObject({ title: 'Foglio di lavorazione', number: 'WO-00042', qr: 'WO-00042', batch: 'Lotto BA-00007', rush: 'URGENTE', banner: null })
    expect(travellerQrText(' WO-00042 ')).toBe('WO-00042')
    expect(paper.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ['Stato', 'Rilasciato'],
      ['Modello', 'JKT-DEMO · Demo jacket'],
      ['Revisione', '3'],
      ['Stabilimento', 'A1 · Made-up plant'],
      ['Consegna', '20/11/2026'],
      ['Priorità', '5'],
      ['Capi', '6'],
      ['Varianti colore', 'BLK · Black, RED · Red'],
      ['Ordini', 'SO-DEMO-1, SO-DEMO-2'],
      ['Diviso da', 'WO-00041'],
      ['Rilasciato il', '02/11/2026 10:30'],
    ])
    const [sizes, operations, materials] = paper.tables
    expect(sizes!.columns.map((column) => column.label)).toEqual(['Colore', '50', '52', 'Totale'])
    expect(sizes!.rows).toEqual([
      ['BLK · Black', '2', '3', '5'],
      ['RED · Red', '', '1', '1'],
    ])
    expect(sizes!.total).toEqual(['Totale', '2', '4', '6'])
    // Written by hand per operation and station: never a person's column.
    expect(operations!.columns.map((column) => column.label)).toEqual(['Fase', 'Codice', 'Lavorazione', 'Centro', 'Min. std', 'Scans.', 'Capi fatti', 'Scarti', 'Data', 'Postazione'])
    expect(operations!.rows[1]).toEqual(['20', 'SEW', 'Sew', 'SEW', '96,5', 'sì', '', '', '', ''])
    expect(materials!.rows).toEqual([['LEA', 'Leather', 'BLK', '247,52', 'FT2']])
    expect(paper.notes[0]).toBe('Nota: Pack in pairs')
    expect(paper.footer.printed).toBe('Stampato il 03/11/2026 09:15')
    for (const table of paper.tables) for (const column of table.columns) expect(column.label.toLowerCase()).not.toMatch(/operat(or|ore)|worker|addett/)
    // The widths of every table add up to the page.
    for (const table of paper.tables) expect(table.columns.reduce((sum, column) => sum + column.width, 0)).toBeLessThanOrEqual(1000)
  })

  it('warns the floor off a draft or a held work order, and speaks English', () => {
    const draft = travellerPaper({ ...facts, status: 'DRAFT', batchNumber: null, rush: false, releasedAt: null, frozen: false, splitFrom: null }, 'en')
    expect(draft).toMatchObject({ title: 'Work order traveller', batch: null, rush: null, banner: 'DRAFT - not released yet: work starts only after the office releases it.' })
    expect(draft.notes).toContain('The specification is not frozen yet: operations and materials may change until the release.')
    expect(draft.facts.find((fact) => fact.label === 'Due date')!.value).toBe('20 Nov 2026')
    expect(travellerPaper({ ...facts, status: 'ON_HOLD', holdReason: 'Leather test pending' }, 'en').banner).toBe('ON HOLD: Leather test pending. Do not start work.')
    expect(travellerPaper({ ...facts, status: 'CANCELLED' }, 'it').banner).toBe('ANNULLATO: non lavorare questo ordine.')
    expect(travellerPaper({ ...facts, status: 'IN_PROGRESS' }, 'it').banner).toBeNull()
  })
})

describe('bulk actions (MES-017)', () => {
  it('keeps the codes of the checks that block a release, and reads a released work order as released', () => {
    expect(
      blockingCodes([
        { code: 'REVISION', state: 'OK' },
        { code: 'CERTIFICATE', state: 'BLOCKED' },
        { code: 'MATERIAL', state: 'OVERRIDDEN' },
        { code: 'DEPOSIT', state: 'BLOCKED' },
        { code: 'BOM', state: 'NOT_REQUIRED' },
      ]),
    ).toEqual(['CERTIFICATE', 'DEPOSIT'])
    expect(beforeRelease({ status: 'DRAFT' })).toBe(true)
    expect(beforeRelease({ status: 'ON_HOLD', heldFromStatus: 'DRAFT' })).toBe(true)
    expect(beforeRelease({ status: 'ON_HOLD', heldFromStatus: 'RELEASED' })).toBe(false)
    expect(['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED'].map((status) => releaseFieldOf({ status: status as never }))).toEqual(['DRAFT', 'RELEASED', 'RELEASED', 'RELEASED', 'RELEASED', 'CANCELLED'])
    expect(releaseFieldOf({ status: 'ON_HOLD', heldFromStatus: 'DRAFT' })).toBe('ON_HOLD')
    expect(RELEASE_BULK_LIMIT).toBe(50)
  })
})
