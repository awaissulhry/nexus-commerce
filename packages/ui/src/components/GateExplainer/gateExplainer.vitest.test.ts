import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GateExplainer, type GateCheck } from './GateExplainer'
import { GATE_EXPLAINER_LABELS } from './GateExplainerLabels'
import { gateBlockers, gateHeldReason, gateLine, gateSummary, gateVerdict } from './gateExplainerModel'

/** B-W2b-78 — GateExplainer. Made-up records. */
const CHECKS: GateCheck[] = [
  { id: 'cert', label: 'The certificate covers every size', state: 'fail', stateLabel: 'Not covered', reason: 'Size 58 is outside the covered range 46–56', who: 'Compliance lead', how: 'Ask the notified body to extend the certificate', fix: { label: 'Open the certificate', href: '/certificates/demo' } },
  { id: 'crvi', label: 'Cr VI result PASS', state: 'unknown', now: 'PENDING', who: 'Quality' },
  { id: 'label', label: 'Label template active', state: 'pass', reason: 'LBL-DEMO r2' },
  { id: 'four', label: 'Second person', state: 'notNeeded' },
]
const W = GATE_EXPLAINER_LABELS

describe('gate rules', () => {
  it('not met holds, unknown holds too, nothing listed holds; not needed never counts', () => {
    expect(gateVerdict(CHECKS)).toBe('held')
    expect(gateVerdict(CHECKS.slice(1))).toBe('unknown')
    expect(gateVerdict(CHECKS.slice(2))).toBe('open')
    expect(gateVerdict([])).toBe('held')
    expect(gateVerdict([CHECKS[3]!])).toBe('open')
    expect(gateSummary(CHECKS)).toMatchObject({ total: 3, passed: 1 })
  })
  it('the held reason names every blocking check with its value now', () => {
    expect(gateHeldReason(CHECKS, W)).toBe('1 check not met: The certificate covers every size')
    expect(gateHeldReason(CHECKS.slice(1), W)).toBe('1 check not known yet: Cr VI result PASS (now: PENDING)')
    expect(gateHeldReason(CHECKS.slice(2), W)).toBeNull()
    expect(gateHeldReason([], W)).toBe('No checks are listed for this gate')
  })
  it('the one line: the first blocker’s reason (+ more), or the one check’s reason, or all met', () => {
    expect(gateLine(CHECKS, W)).toBe('Size 58 is outside the covered range 46–56')
    expect(gateLine([{ ...CHECKS[1]!, state: 'fail' }, CHECKS[0]!], W)).toBe('Cr VI result PASS (now: PENDING) · +1 more')
    expect(gateLine([CHECKS[2]!], W)).toBe('LBL-DEMO r2')
    expect(gateLine([CHECKS[2]!, { ...CHECKS[0]!, state: 'pass' }], W)).toBe('All 2 checks met')
    expect(gateBlockers(CHECKS).map((c) => c.id)).toEqual(['cert', 'crvi'])
  })
})

describe('GateExplainer', () => {
  it('full: each check with its icon and word, the reason, who and how when not met, the fix; the verdict in a live region', () => {
    const html = render(h(GateExplainer, { title: 'Certificate gate', rule: 'A garment ships only when a valid certificate covers it.', checks: CHECKS }))
    for (const word of ['Certificate gate', 'Not covered', 'Not known', 'Met', 'Not needed', 'Size 58 is outside the covered range 46–56', 'Who can clear it: Compliance lead', 'How: Ask the notified body', 'Open the certificate', '(now: PENDING)', '1 of 3 checks met', 'Blocked']) expect(html).toContain(word)
    expect(html).toContain('role="status"')
    // A met check says no "who can clear it".
    expect(html.match(/Who can clear it/g)).toHaveLength(2)
  })
  it('override: shown while it holds, with who may; none says why; a frozen answer says when and shows no override', () => {
    const over = render(h(GateExplainer, { checks: CHECKS, override: { label: 'Release under a concession, this work order only', who: 'Plant manager', action: { label: 'Override', onClick: () => {}, heldReason: 'Only the plant manager may override' } } }))
    expect(over).toContain('Who may override: Plant manager')
    expect(over).toContain('aria-disabled="true"')
    expect(over).not.toContain(' disabled=""')
    expect(render(h(GateExplainer, { checks: CHECKS, override: { none: 'The law allows no override for a PPE label' } }))).toContain('The law allows no override for a PPE label')
    const frozen = render(h(GateExplainer, { checks: CHECKS.slice(2), asOf: '3 Nov 2026, 10:42', override: { none: 'x' } }))
    expect(frozen).toContain('As it stood on 3 Nov 2026, 10:42')
    expect(frozen).toContain('data-frozen="true"')
    expect(frozen).not.toContain('nds-gate-override')
  })
  it('compact and popover: one line; the popover is a real button naming the whole answer', () => {
    const compact = render(h(GateExplainer, { checks: CHECKS, form: 'compact' }))
    expect(compact).toContain('data-form="compact"')
    expect(compact).toContain('Blocked')
    expect(compact).toContain('Size 58 is outside')
    expect(compact).toContain('role="status"')
    const pop = render(h(GateExplainer, { checks: CHECKS, form: 'popover', title: 'Certificate gate' }))
    expect(pop).toContain('<button')
    expect(pop).toContain('aria-label="Blocked: Size 58 is outside the covered range 46–56 — show why"')
  })
  it('list: only what blocks, each with who and its fix; empty says nothing blocks', () => {
    const list = render(h(GateExplainer, { checks: CHECKS, form: 'list' }))
    expect(list).toContain('Size 58 is outside')
    expect(list).not.toContain('Label template active')
    expect(render(h(GateExplainer, { checks: [CHECKS[2]!], form: 'list' }))).toContain('Nothing is blocking')
  })
  it('speaks the host’s language', () => {
    const html = render(h(GateExplainer, { checks: CHECKS, form: 'compact', labels: { verdicts: { open: 'Via libera', held: 'Bloccato', unknown: 'Non ancora noto' } } }))
    expect(html).toContain('Bloccato')
  })
})
