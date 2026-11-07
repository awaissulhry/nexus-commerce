import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SignOffPanel, type SignOffStep } from './SignOffPanel'
import { SIGN_OFF_PANEL_LABELS } from './SignOffPanelLabels'
import { dutyText, signOffCurrent, signOffStepHeld, signOffSummary } from './signOffPanelModel'

/** B-W2b-78 — SignOffPanel. Made-up people and records. */
const SHA = '0b00b462fe392b8669ea5dcea35fe681daf365a1920525c0b0884c39a2606312'
const STEPS: SignOffStep[] = [
  { id: 'result', label: 'Result signed', role: 'Inspector', state: 'signed', signer: 'Marta Demo', method: 'pin', methodDetail: 'at bench 2', signedAt: '10:42', fingerprint: SHA },
  {
    id: 'release',
    label: 'Release by a second person',
    state: 'waiting',
    whoMay: 'Quality lead or plant manager',
    rules: [
      { id: 'maker', kind: 'maker', state: 'met', text: 'Made by (from scans): 9 people on Line 2 — Luca Esempio is not among them' },
      { id: 'four', kind: 'fourEyes', state: 'broken' },
    ],
    action: { label: 'Release', onClick: () => {} },
  },
]
const W = SIGN_OFF_PANEL_LABELS

describe('sign-off rules', () => {
  it('the current step is the first still open; a rejection ends it', () => {
    expect(signOffCurrent(STEPS)).toBe(1)
    expect(signOffCurrent([{ state: 'signed' }, { state: 'signed' }])).toBe(-1)
    expect(signOffCurrent([{ state: 'rejected' }, { state: 'waiting' }])).toBe(-1)
    expect(signOffSummary(STEPS)).toMatchObject({ signed: 1, total: 2, complete: false })
    expect(signOffSummary([{ state: 'signed' }, { state: 'notNeeded' }])).toMatchObject({ signed: 1, total: 1, complete: true })
  })
  it('held reasons, never silent: an earlier step, the step’s own reason, a broken rule, an unknown rule', () => {
    const order = [{ label: 'Result signed', state: 'waiting' as const }, { label: 'Release', state: 'waiting' as const }]
    expect(signOffStepHeld(order, 1, W)).toBe('Waits for step 1: Result signed')
    expect(signOffStepHeld(order, 0, W)).toBeNull()
    expect(signOffStepHeld([{ label: 'A', state: 'held', heldReason: 'Signing needs the network.' }], 0, W)).toBe('Signing needs the network.')
    expect(signOffStepHeld(STEPS, 1, W)).toBe('You signed an earlier step: a second person must sign this one (four-eyes)')
    expect(signOffStepHeld([{ label: 'A', state: 'waiting', rules: [{ kind: 'maker', state: 'unknown' }] }], 0, W)).toBe('Who made these units is not known yet')
    expect(signOffStepHeld(STEPS, 0, W)).toBeNull()
    expect(dutyText({ kind: 'authorNotApprover', state: 'broken' }, W)).toBe('You wrote it: another person must approve it')
    expect(dutyText({ kind: 'other', state: 'met', text: 'Two signatures for a class A change' }, W)).toBe('Two signatures for a class A change')
  })
})

describe('SignOffPanel', () => {
  it('each step with its number, state in words, who, how, when and the fingerprint; rules in words; the action held with the reason on screen', () => {
    const html = render(h(SignOffPanel, { steps: STEPS }))
    for (const word of ['Sign-off', '1 of 2 signed', 'Result signed', 'Inspector', 'Signed by Marta Demo · PIN at bench 2 · 10:42', 'Fingerprint', '0b00b462…0c2606312'.slice(0, 9), 'Who may sign: Quality lead or plant manager', 'Made by (from scans): 9 people on Line 2', 'Not met', 'Waiting']) expect(html).toContain(word)
    expect(html).toContain('aria-current="step"')
    // The broken rule's sentence is on screen once, in the rule's line (not again as the held line).
    expect(html.match(/>You signed an earlier step/g)).toHaveLength(1)
    expect(html).toContain('aria-description="You signed an earlier step: a second person must sign this one (four-eyes)"')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain(' disabled=""')
    expect(html).toContain('role="status"')
  })
  it('a held reason that is no rule’s sentence is on screen as the held line', () => {
    const html = render(h(SignOffPanel, { steps: [{ id: 'a', label: 'Approve', state: 'held', heldReason: 'Signing needs the network.', action: { label: 'Approve', onClick: () => {} } }] }))
    expect(html).toContain('class="nds-signoff-held">Signing needs the network.')
  })
  it('draws the app’s sign block under the current step only when nothing holds it', () => {
    const free: SignOffStep[] = [STEPS[0]!, { ...STEPS[1]!, rules: [], sign: h('div', { className: 'demo-pin' }, 'PIN pad') }]
    expect(render(h(SignOffPanel, { steps: free }))).toContain('demo-pin')
    const held: SignOffStep[] = [STEPS[0]!, { ...STEPS[1]!, sign: h('div', { className: 'demo-pin' }, 'PIN pad') }]
    expect(render(h(SignOffPanel, { steps: held }))).not.toContain('demo-pin')
  })
  it('rejected and complete summaries; the host’s language', () => {
    const rejected = render(h(SignOffPanel, { steps: [{ id: 'a', label: 'Approve the plan', state: 'rejected', signer: 'Paolo Prova', rejectedReason: 'The sample size is wrong' }] }))
    expect(rejected).toContain('Rejected by Paolo Prova')
    expect(rejected).toContain('The sample size is wrong')
    expect(render(h(SignOffPanel, { steps: [STEPS[0]!] }))).toContain('Every step signed')
    expect(render(h(SignOffPanel, { steps: STEPS, labels: { summary: (s: number, t: number) => `${s} di ${t} firmati` } }))).toContain('1 di 2 firmati')
  })
})
