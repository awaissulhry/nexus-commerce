import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { refusalOf as boardRefusalOf } from '../board/model'
import { FIXTURES } from './fixtures'
import { bodyOf, canOf, controlsOf, draftHeld, emptyDraft, heldOf, kindsLeft, milestoneName, queryOf, reasonHeld, refusalOf, rowsOf, selectableHeld, stateTone, trackerSteps, visibleOrders, visibleRows } from './model'
// F-PR-19
import { GATE_KINDS, isSampleGate, shapeRefusal } from '@nexus/factory-domain/planning/milestones/rules'
import { SAMPLE_KINDS } from '@nexus/factory-domain/sales/samples/rules'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { designScreen } from './fixtures'
import { GATE_PICKER_KINDS, roundFitsGate, roundsForGate } from './model'
// F-PR-09
import { readFileSync } from 'node:fs'
import { LOCALES } from '../../../lib/i18n/locales'

/** Time & action's screen rules (B-W2b-263, SCR-253): made-up data from the design cases. */

const t = (key: string, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key)
const conflict = (paths: string[]) => new ApiError('conflict', 409, 'conflict', 'English for logs', null, paths.map((path) => ({ path, message: 'x' })))

describe('the address', () => {
  it('keeps the view, the tile, the search, the open milestone and Add gate; the calendar is the default', () => {
    const controls = controlsOf(new URLSearchParams('view=orders&tile=SAMPLE&q=SO-1&open=gate:1&add=1'))
    expect(controls).toEqual({ view: 'orders', tile: 'SAMPLE', q: 'SO-1', open: 'gate:1', add: '1' })
    expect(queryOf(controls)).toBe('view=orders&tile=SAMPLE&q=SO-1&open=gate%3A1&add=1')
    expect(controlsOf(new URLSearchParams('view=week&tile=NOPE'))).toMatchObject({ view: 'calendar', tile: null })
    expect(queryOf(controlsOf(new URLSearchParams('')))).toBe('')
  })
})

describe('rows and filters', () => {
  const rows = rowsOf(FIXTURES.WORLD)
  it('flattens every order’s milestones with its gate', () => {
    expect(rows.filter((row) => row.kind === 'GATE').every((row) => row.gate !== null)).toBe(true)
    expect(rows.filter((row) => row.kind !== 'GATE').every((row) => row.gate === null)).toBe(true)
  })
  it('a tile keeps the waiting gates of its group; the search the orders that match', () => {
    const sample = visibleRows(rows, { view: 'list', tile: 'SAMPLE', q: '', open: null, add: null })
    expect(sample.map((row) => row.gateKind)).toEqual(['PP_SAMPLE'])
    expect(visibleRows(rows, { view: 'list', tile: 'LEATHER_NOT_PASSED', q: '', open: null, add: null }).map((row) => row.gate?.leather)).toEqual(['NOT_PASSED'])
    expect(visibleOrders(FIXTURES.WORLD, { view: 'orders', tile: 'LEATHER_NOT_RECEIVED', q: '', open: null, add: null })).toHaveLength(1)
    expect(visibleOrders(FIXTURES.WORLD, { view: 'orders', tile: null, q: 'po-demo-77', open: null, add: null }).map((order) => order.number)).toEqual(['SO-DEMO-2041'])
  })
  it('names a milestone: a gate by its kind (Other by its words), start and ship by theirs', () => {
    expect(milestoneName({ kind: 'GATE', gateKind: 'OTHER', label: 'Hang tag' }, t)).toBe('Hang tag')
    expect(milestoneName({ kind: 'GATE', gateKind: 'PP_SAMPLE', label: null }, t)).toBe('kind.PP_SAMPLE')
    expect(milestoneName({ kind: 'SHIP', gateKind: null, label: null }, t)).toBe('milestone.SHIP')
    expect(stateTone({ state: 'WAITING', late: 3 })).toBe('danger')
    expect(stateTone({ state: 'STARTED_BEFORE', late: null })).toBe('info')
  })
  it('the dots of an order: done, started before (skipped), the next one current', () => {
    const order = FIXTURES.ORDERS[0]!
    const steps = trackerSteps(order, t, (iso) => iso)
    expect(steps.find((step) => step.id === `gate:${FIXTURES.TRIMS_STARTED.id}`)?.state).toBe('skipped')
    expect(steps.find((step) => step.id === `gate:${FIXTURES.LEATHER_PASSED.id}`)?.state).toBe('done')
    expect(steps.filter((step) => step.current)).toHaveLength(1)
  })
})

describe('held in our words', () => {
  it('says the permission missing first, then the refusal code', () => {
    expect(heldOf({ allowed: false, refusal: null, needs: 'planning.milestones.override' }, t)).toBe('needs.planning.milestones.override')
    expect(heldOf({ allowed: false, refusal: { code: 'OWN_GATE', message: 'English' }, needs: null }, t)).toBe('refusal.OWN_GATE')
    expect(heldOf({ allowed: true, refusal: null, needs: null }, t)).toBeNull()
  })
  it('only a gate that may be marked done now can be ticked', () => {
    const rows = rowsOf(FIXTURES.WORLD)
    expect(selectableHeld(rows.find((row) => row.gateId === FIXTURES.ARTWORK.id)!, t)).toBeNull()
    expect(selectableHeld(rows.find((row) => row.gateId === FIXTURES.PP_WAITING.id)!, t)).toBe('refusal.ROUND_NOT_APPROVED')
    expect(selectableHeld(rows.find((row) => row.kind === 'SHIP')!, t)).toBe('held.notAGate')
  })
  it('a reason says enough; Other says what it is; a round only on a sample gate', () => {
    expect(reasonHeld('ok', t)).toMatch(/^held.reasonShort/)
    expect(reasonHeld('The brand said go.', t)).toBeNull()
    expect(draftHeld(emptyDraft('OTHER'), t)).toBe('refusal.LABEL_NEEDED')
    expect(draftHeld({ ...emptyDraft('LAB_PASSED'), sampleRoundId: 'x' }, t)).toBe('refusal.ROUND_ONLY_SAMPLE')
    expect(bodyOf({ ...emptyDraft('LAB_PASSED'), sampleRoundId: 'x', label: '  ' })).toEqual({ kind: 'LAB_PASSED', label: null, targetDate: null, sampleRoundId: null, ownerId: null })
    // B-PR-23 (#1590, production lane): GateKind SIZE_SET joined GATE_KINDS; it is a sample gate. F-PR-19: the picker reads Other last.
    expect(kindsLeft(FIXTURES.ORDERS[1]!)).toEqual(['SAMPLE_APPROVED', 'TRIMS_IN', 'PP_SAMPLE', 'SIZE_SET', 'OTHER'])
    expect(draftHeld({ ...emptyDraft('SIZE_SET'), sampleRoundId: 'x' }, t)).toBeNull()
    // end B-PR-23
  })
  it('a refused write becomes a key of our catalogue; the board knows a held drop by its code', () => {
    expect(refusalOf(conflict(['refusal/GATE_EXISTS']))).toBe('refusal.GATE_EXISTS')
    expect(refusalOf(conflict(['version']))).toBe('refusal.changed')
    expect(refusalOf(new Error('x'))).toBe('refusal.failed')
    expect(boardRefusalOf(conflict(['gate/g1', 'gate/g2', 'refusal/GATE_NOT_PASSED']))).toEqual({ code: 'GATE_NOT_PASSED', gates: ['g1', 'g2'] })
    expect(canOf(['planning.view', 'planning.milestones.manage'])).toEqual({ view: true, manage: true, override: false })
  })
})

// ---- F-PR-19 -------------------------------------------------------------------------------------------------------------------
/**
 * F-PR-19 (production plan §5 "Samples, Milestones, Promises: new kinds"; threads lead 11-17 (a) and (b)): the gate-kind picker
 * reads Other last; a sample gate offers only the rounds its kind accepts — a size set gate its size set rounds, a pre-production
 * sample gate its pre-production rounds, "sample approved" any round but a top-of-production one (a TOP round gates nothing) — so
 * the dialog never offers what the API refuses. Made-up data.
 */
describe('F-PR-19: the size set gate and the rounds each gate accepts', () => {
  it('the picker: every kind once, in the domain’s order, Other last', () => {
    expect([...GATE_PICKER_KINDS].sort()).toEqual([...GATE_KINDS].sort())
    expect(GATE_PICKER_KINDS.at(-1)).toBe('OTHER')
    expect(GATE_PICKER_KINDS.indexOf('SIZE_SET')).toBeLessThan(GATE_PICKER_KINDS.indexOf('OTHER'))
    // An order with every kind but Other: Other is still offered (as many as needed), last.
    const full = { ...FIXTURES.ORDERS[1]!, gates: GATE_KINDS.filter((kind) => kind !== 'OTHER').map((kind) => ({ ...FIXTURES.ORDERS[1]!.gates[0]!, kind })) }
    expect(kindsLeft(full)).toEqual(['OTHER'])
  })

  it('roundFitsGate says what the API’s own rule says, for every gate kind and every round kind', () => {
    for (const kind of GATE_KINDS) {
      for (const roundKind of SAMPLE_KINDS) {
        const api = shapeRefusal(kind, kind === 'OTHER' ? 'Hang tag' : null, { number: 'SR-DEMO-0001', decision: null, kind: roundKind })
        expect(roundFitsGate(kind, roundKind), `${kind} × ${roundKind}`).toBe(api === null)
      }
    }
    expect(roundFitsGate('SIZE_SET', 'SIZE_SET')).toBe(true)
    expect(roundFitsGate('SIZE_SET', 'TOP_OF_PRODUCTION')).toBe(false)
    expect(roundFitsGate('SAMPLE_APPROVED', 'TOP_OF_PRODUCTION')).toBe(false)
    expect(roundFitsGate('PP_SAMPLE', 'SIZE_SET')).toBe(false)
  })

  it('each sample gate is offered only its own rounds; a gate that is not a sample gate none', () => {
    const rounds = FIXTURES.CHOICES_ALL_KINDS.rounds
    const ids = (kind: (typeof GATE_KINDS)[number]) => roundsForGate(kind, rounds).map((round) => round.number)
    expect(ids('SIZE_SET')).toEqual([FIXTURES.ROUND_SIZE_SET.number])
    expect(ids('PP_SAMPLE')).toEqual(['SR-DEMO-0031'])
    expect(ids('SAMPLE_APPROVED')).not.toContain(FIXTURES.ROUND_TOP.number)
    expect(ids('SAMPLE_APPROVED')).toContain(FIXTURES.ROUND_SIZE_SET.number)
    for (const kind of GATE_KINDS.filter((entry) => !isSampleGate(entry))) expect(ids(kind), kind).toEqual([])
    // A TOP round gates nothing: no gate kind offers it.
    for (const kind of GATE_KINDS) expect(ids(kind), kind).not.toContain(FIXTURES.ROUND_TOP.number)
  })

  it('a named round the kind does not accept (a gate kept from before) holds Save with the rule’s words', () => {
    const rounds = FIXTURES.CHOICES_ALL_KINDS.rounds
    const pp = rounds.find((round) => round.kind === 'PRE_PRODUCTION')!
    expect(draftHeld({ ...emptyDraft('SIZE_SET'), sampleRoundId: pp.id }, t, rounds)).toBe('refusal.ROUND_KIND')
    expect(draftHeld({ ...emptyDraft('SIZE_SET'), sampleRoundId: FIXTURES.ROUND_SIZE_SET.id }, t, rounds)).toBeNull()
    expect(draftHeld({ ...emptyDraft('SAMPLE_APPROVED'), sampleRoundId: FIXTURES.ROUND_TOP.id }, t, rounds)).toBe('refusal.ROUND_KIND')
    // Without the order's rounds (not read yet) nothing is guessed: the API decides.
    expect(draftHeld({ ...emptyDraft('SIZE_SET'), sampleRoundId: pp.id }, t)).toBeNull()
  })

  it('the size set design case exists and the words of the dialog exist in both languages', () => {
    expect(designScreen.cases.some((item) => item.id === 'add-size-set')).toBe(true)
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['planning-milestones']!
      for (const key of ['form.roundHint', 'form.roundHintPp', 'form.roundHintSizeSet', 'kind.SIZE_SET', 'kindHint.SIZE_SET', 'roundKind.SIZE_SET', 'roundKind.TOP_OF_PRODUCTION', 'refusal.ROUND_KIND']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })

  it('PW-06 (dialog): the rounds drawn are only the order’s own choices the API sent, filtered — the web adds none', () => {
    const choices = FIXTURES.CHOICES_ALL_KINDS
    for (const kind of GATE_KINDS) {
      const drawn = roundsForGate(kind, choices.rounds)
      expect(drawn.every((round) => choices.rounds.includes(round)), kind).toBe(true)
    }
  })
})

// ---- F-PR-09 -------------------------------------------------------------------------------------------------------------------
/**
 * F-PR-09 (production plan §3 "No silent decisions"; B-PR-38's hand pass, B-PR-30a/30b on the round): a gate waiting for a customer's
 * own round says why Mark done is held and offers, in its dialog, Decide for <customer> and Reverse on that round's answer, with the
 * round one click away. The customer is the order's own (PW-04, PW-09: nothing of another customer is named).
 */
describe('F-PR-09: a gate waiting for the customer’s own round — why it is held, and Decide for the customer on the round', () => {
  it('Mark done (one or N) and a refused write say the customer’s rule in our words, in both languages', () => {
    const held = { allowed: false, refusal: { code: 'CUSTOMER_DECIDES' as const, message: 'English for logs' }, needs: null }
    expect(heldOf(held, t)).toBe('refusal.CUSTOMER_DECIDES')
    expect(refusalOf(conflict(['refusal/CUSTOMER_DECIDES']))).toBe('refusal.CUSTOMER_DECIDES')
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['planning-milestones'] as Record<string, string>
      for (const key of ['refusal.CUSTOMER_DECIDES', 'dialog.customerAnswer', 'dialog.openRound']) expect(words[key], `${locale} ${key}`).toBeTruthy()
      expect(words['dialog.customerAnswer']).toContain('{round}')
    }
  })

  it('the gate’s dialog mounts the part on the round the gate names, for the order’s own customer, and links the round’s Approval tab', () => {
    const dialog = readFileSync(new URL('./view/MilestoneDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain("source={{ record: { type: 'SampleRound', id: gate.sampleRound.id } }} customer={row.order.customer.name}")
    expect(dialog).toContain('/products/samples/${encodeURIComponent(gate.sampleRound.id)}?tab=approval')
    expect(readFileSync(new URL('./MilestonesPage.tsx', import.meta.url), 'utf8')).toContain('<CustomerOverrideProvider onDone={() => void load()}>')
  })
})
// ---- end F-PR-09
