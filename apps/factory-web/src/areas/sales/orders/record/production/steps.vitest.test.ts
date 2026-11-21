import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { order } from '../../_demo/fixtures'
import type { DateMilestone, Dates, Gate } from '../overview/api'
import { GATE, PRODUCTION_READ } from '../overview/fixtures'
import { nowStepOf, offeredOf, stepActsOf, stepsChipOf, stepsOf, type StepRow } from './steps'

// F-PT-202 (order PRODUCTION tab, W2): the steps to shipping — the deposit first (B11), one late rule (B15), waiting ≠ to come
// (B16), one tone (B17), who acts; the acts by the gate's own actions (hidden without the right, held by the state — L9).

const TODAY = '2026-11-21'
const milestone = (id: string, kind: string, state: string, target: string | null, late: number | null, over: Partial<DateMilestone> = {}): DateMilestone => ({ id, kind, gateId: kind === 'GATE' ? `g-${id}` : null, gateKind: kind === 'GATE' ? 'TRIMS_IN' : null, label: null, target, actual: state === 'DONE' ? target : null, state, late, owner: { id: 'p1', name: 'Dora Campione' }, ...over })
const datesWith = (milestones: DateMilestone[], gates: Gate[] = []): Dates => ({ ...PRODUCTION_READ.dates!, milestones, gates })

describe('F-PT-202: the steps', () => {
  it('the deposit first (paid: done), then the read’s milestones; who acts in words; START and SHIP their own kinds', () => {
    const so = order('IN_PRODUCTION')
    const rows = stepsOf(so, datesWith([milestone('a', 'GATE', 'DONE', '2026-11-10', null), milestone('s', 'START', 'DONE', '2026-11-16', null), milestone('x', 'SHIP', 'TO_COME', '2026-12-15', null)]), TODAY)
    expect(rows.map((row) => row.kind)).toEqual(['DEPOSIT', 'GATE', 'START', 'SHIP'].filter((kind) => kind !== 'DEPOSIT' || so.depositRequired))
    expect(rows.find((row) => row.kind === 'START')?.who).toEqual({ kind: 'production' })
    expect(rows.find((row) => row.kind === 'SHIP')?.who).toEqual({ kind: 'shipping' })
    expect(rows.find((row) => row.kind === 'GATE')?.who).toEqual({ kind: 'planner', name: 'Dora Campione' })
    // The deposit's paidAt is an instant: the step's done is its Rome day (the view formats a day; an instant there threw).
    const deposit = rows.find((row) => row.kind === 'DEPOSIT')
    if (deposit?.done) expect(deposit.done).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const paid = stepsOf({ ...so, depositRequired: true, chain: { ...so.chain, depositRequests: [{ ...so.chain.depositRequests[0]!, status: 'PAID', paidAt: '2026-11-02T23:30:00Z' }] } }, datesWith([]), TODAY)[0]!
    expect(paid).toMatchObject({ kind: 'DEPOSIT', done: '2026-11-03', status: { kind: 'done' } })
  })

  it('one status word set: late (open past its day) · waiting soon (≤ 3 days, warning) · waiting · started before · to come · done', () => {
    const rows = stepsOf(order('IN_PRODUCTION'), datesWith([milestone('l', 'GATE', 'WAITING', '2026-11-18', 3), milestone('s', 'GATE', 'WAITING', '2026-11-23', null), milestone('w', 'GATE', 'WAITING', '2026-12-10', null), milestone('b', 'GATE', 'STARTED_BEFORE', '2026-11-12', null), milestone('t', 'GATE', 'TO_COME', '2026-12-01', null)]), TODAY).filter((row) => row.kind === 'GATE')
    expect(rows.map((row) => row.status)).toEqual([{ kind: 'late', days: 3 }, { kind: 'soon', days: 2 }, { kind: 'waiting' }, { kind: 'startedBefore' }, { kind: 'toCome' }])
  })

  it('B15: the chip counts OPEN steps past their day only; all done; on track; the Now line names the late one first', () => {
    const rows = (list: DateMilestone[]) => stepsOf({ ...order('IN_PRODUCTION'), depositRequired: false }, datesWith(list), TODAY)
    // A step done late is no longer late (its `late` stays on the row, the chip does not count it).
    expect(stepsChipOf(rows([milestone('d', 'GATE', 'DONE', '2026-11-10', 2), milestone('t', 'GATE', 'TO_COME', '2026-12-01', null)]))).toEqual({ kind: 'onTrack' })
    expect(stepsChipOf(rows([milestone('l', 'GATE', 'WAITING', '2026-11-18', 3), milestone('t', 'GATE', 'TO_COME', '2026-12-01', null)]))).toEqual({ kind: 'late', count: 1 })
    expect(stepsChipOf(rows([milestone('d', 'GATE', 'DONE', '2026-11-10', null)]))).toEqual({ kind: 'allDone' })
    // fx5 #7: ONE verdict — no "On track" chip beside an order the stored health calls At risk or Late; facts (late steps) still show.
    const open = rows([milestone('d', 'GATE', 'DONE', '2026-11-10', null), milestone('t', 'GATE', 'TO_COME', '2026-12-01', null)])
    expect(stepsChipOf(open, 'AT_RISK')).toBeNull()
    expect(stepsChipOf(open, 'LATE')).toBeNull()
    expect(stepsChipOf(open, 'ON_TRACK')).toEqual({ kind: 'onTrack' })
    expect(stepsChipOf(rows([milestone('l', 'GATE', 'WAITING', '2026-11-18', 3)]), 'AT_RISK')).toEqual({ kind: 'late', count: 1 })
    expect(nowStepOf(rows([milestone('t', 'GATE', 'TO_COME', '2026-12-01', null), milestone('l', 'GATE', 'WAITING', '2026-11-18', 3)]))?.id).toBe('l')
  })
})

describe('F-PT-202: what the reader may do with a step (L9)', () => {
  const allowed = { allowed: true, refusal: null, needs: null }
  const needs = { allowed: false, refusal: null, needs: 'planning.milestones.manage' }
  const refused = { allowed: false, refusal: { code: 'OWN_GATE' as const, message: 'x' }, needs: null }
  const row = (actions: Gate['actions'], state = 'WAITING'): StepRow => ({ id: 'm', kind: 'GATE', milestoneId: 'm', gateId: 'g', gateKind: 'TRIMS_IN', label: null, planned: '2026-11-25', done: null, status: state === 'DONE' ? { kind: 'done' } : { kind: 'waiting' }, who: { kind: 'planner', name: 'Dora Campione' }, gate: { ...GATE, actions } })

  it('a planner: Mark done… the primary; Move the date…, Remove… in ⋯; a refusal of the state stays, held in words', () => {
    const acts = stepActsOf(row({ pass: allowed, startBefore: refused, edit: allowed, remove: allowed }))
    expect(acts).toEqual({ primary: 'done', more: ['move', 'startBefore', 'remove'], askOnly: false })
    expect(offeredOf(refused)).toBe(true)
    expect(offeredOf(needs)).toBe(false)
  })

  it('without the gate rights (Sales, Finance, Warehouse): nothing offered — the planner is asked for an update instead', () => {
    expect(stepActsOf(row({ pass: needs, startBefore: needs, edit: needs, remove: needs }))).toEqual({ primary: null, more: [], askOnly: true })
    // A done step offers nothing and asks nothing.
    expect(stepActsOf(row({ pass: allowed, startBefore: allowed, edit: allowed, remove: allowed }, 'DONE'))).toEqual({ primary: null, more: [], askOnly: false })
  })

  it('W3 extra: a gate waiting on the customer’s own sample round — the primary is Decide for {customer}… (with the right only)', () => {
    const round = { id: 'r1', number: 'SR-2026-0007', kind: 'PP', decision: null }
    const sample = (decision: string | null): StepRow => ({ ...row({ pass: allowed, startBefore: needs, edit: allowed, remove: needs }), who: { kind: 'customerSample' }, gate: { ...GATE, actions: { pass: allowed, startBefore: needs, edit: allowed, remove: needs }, sampleRound: { ...round, decision } } })
    expect(stepActsOf(sample(null), { decide: true })).toEqual({ primary: 'decide', more: ['move', 'done'], askOnly: false })
    // Without production.brand.override: no Decide (hidden, L9) — Mark done… as before.
    expect(stepActsOf(sample(null))).toEqual({ primary: 'done', more: ['move'], askOnly: false })
    // The round decided already: nothing to decide.
    expect(stepActsOf(sample('APPROVED'), { decide: true }).primary).toBe('done')
    // A planner's gate never offers it.
    expect(stepActsOf(row({ pass: allowed, startBefore: needs, edit: needs, remove: needs }), { decide: true }).primary).toBe('done')
    const block = readFileSync(new URL('../view/production/StepsBlock.tsx', import.meta.url), 'utf8')
    expect(block).toContain("acts.primary === 'decide' && opens")
    expect(block).toContain('onClick={() => gateActs?.onOpen?.(opens)}')
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['orders']).orders!)('productionTab.steps.decide', { customer: 'Brand Alpha' }), locale).toContain('Brand Alpha')
  })

  it('the wiring: Planning’s dialogs mounted once for the page; each gate row its anchor (B18); the planner asked by a mention', () => {
    const block = readFileSync(new URL('../view/production/StepsBlock.tsx', import.meta.url), 'utf8')
    expect(block).toContain("id={row.gateId ? rowAnchor('OrderGate', row.gateId) : undefined}")
    expect(block).toContain('askSupervisor: false,')
    expect(block).not.toContain('<GateDialogs')
    const hook = readFileSync(new URL('../use-gate-acts.ts', import.meta.url), 'utf8')
    expect(hook).toContain('onOpen: (milestoneId) => setOpen(milestoneId),')
    expect(hook).toContain("setDialog({ kind: 'add', orderId, draft: emptyDraft(kindsLeft(planning)[0] ?? 'OTHER'), choices: null, busy: false, problem: null })")
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['productionTab.steps.title', 'productionTab.steps.deposit', 'productionTab.steps.startHint', 'productionTab.steps.shipHint', 'productionTab.steps.now', 'productionTab.steps.status.late', 'productionTab.steps.status.soon', 'productionTab.steps.status.soonToday', 'productionTab.steps.status.waiting', 'productionTab.steps.status.startedBefore', 'productionTab.steps.status.toCome', 'productionTab.steps.status.done', 'productionTab.steps.who.customerDeposit', 'productionTab.steps.who.customerSample', 'productionTab.steps.who.planner', 'productionTab.steps.who.plannerNobody', 'productionTab.steps.who.production', 'productionTab.steps.who.shipping', 'productionTab.steps.chip.late', 'productionTab.steps.chip.allDone', 'productionTab.steps.chip.onTrack', 'productionTab.steps.add', 'productionTab.steps.remove', 'productionTab.steps.ask', 'productionTab.steps.askTitle', 'productionTab.steps.askStarter', 'productionTab.steps.askStarterNoPromise', 'productionTab.steps.askSend', 'productionTab.steps.noGate', 'productionTab.steps.seesGates', 'productionTab.steps.seesNone', 'productionTab.steps.added', 'productionTab.steps.removed', 'productionTab.steps.more'])
        expect(t(key, { step: 's', count: 2, name: 'n', promise: 'p' }), `${locale} ${key}`).not.toMatch(/^productionTab\.|\{/)
    }
    // B19: ONE gate-name set (the depth's and Planning's catalogues agree).
    const depth = messagesFor('it', ['sales-orders-depth'])['sales-orders-depth']!
    const planning = messagesFor('it', ['planning-milestones'])['planning-milestones']!
    for (const kind of ['SAMPLE_APPROVED', 'LEATHER_APPROVED', 'TRIMS_IN', 'PP_SAMPLE', 'LAB_PASSED', 'SIZE_SET']) expect(depth[`gate.${kind}`], kind).toBe(planning[`kind.${kind}`])
  })
})

// ---- fx5 (the look-only walk on :3300, 30-walk.md #2, #7, #11) ----------------------------------------------------------------------
describe('fx5: the steps keep their path; the Now line never repeats; one drawing on a phone', () => {
  it('#2: deposit → gates → production start → shipping, whatever the read’s order or a missing day', () => {
    const so = order('IN_PRODUCTION')
    const out = stepsOf(so, datesWith([milestone('x', 'SHIP', 'TO_COME', '2026-12-18', null), milestone('s', 'START', 'DONE', null, null), milestone('g', 'GATE', 'DONE', '2026-11-10', null)]), TODAY)
    expect(out.map((row) => row.kind)).toEqual(['DEPOSIT', 'GATE', 'START', 'SHIP'].filter((kind) => kind !== 'DEPOSIT' || so.depositRequired))
  })

  it('#7, #11: the Now line names who acts only for a gate or the deposit; the tracker is the cards’ twin from 720 px only', () => {
    const block = readFileSync(new URL('../view/production/StepsBlock.tsx', import.meta.url), 'utf8')
    expect(block).toContain("now.kind === 'GATE' || now.kind === 'DEPOSIT' ? whoWords(now.who) : null")
    expect(block).toContain('stepsChipOf(rows, read?.headline?.health?.code ?? null)')
    expect(block).toContain('<div className="fw-pt-steps-track">')
    const css = readFileSync(new URL('../view/production/production.css', import.meta.url), 'utf8')
    expect(css).toMatch(/@container pt \(max-width: 719px\) \{\s*\.fw-pt-steps-track \{ display: none; \}/)
  })
})
