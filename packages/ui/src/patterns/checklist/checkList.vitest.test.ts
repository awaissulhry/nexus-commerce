import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CheckList, type CheckItem } from './CheckList'
import { checkBlocks, checkListButton, checkListHeld, checkListSummary } from './checkListModel'

/** B-W2b-09 — CheckList / ReadinessChecklist: named checks that hold the action with their count and names. */
const CHECKS: CheckItem[] = [
  { id: 'lot', state: 'pass', name: 'Lot released' },
  { id: 'cert', state: 'fail', name: 'Certificate valid', detail: 'EN 17092 expired on 12 Oct', fix: { label: 'Upload the certificate', href: '/compliance/certificates/9' } },
  { id: 'label', state: 'warning', name: 'Care label', detail: 'Italian text only' },
  { id: 'qty', state: 'skipped', name: 'Quantity check' },
  { id: 'hold', state: 'unknown', name: 'Holds read' },
]
const Link = ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { href, ...rest }, children)

describe('checkListModel', () => {
  it('holds on fail, checking and unknown; a check may say otherwise', () => {
    expect(CHECKS.map(checkBlocks)).toEqual([false, true, false, false, true])
    expect(checkBlocks({ id: 'w', state: 'warning', blocks: true })).toBe(true)
    expect(checkBlocks({ id: 'u', state: 'unknown', blocks: false })).toBe(false)
  })
  it('sums up, holds with the count and names, and words the primary', () => {
    const summary = checkListSummary(CHECKS)
    expect(summary).toMatchObject({ total: 5, open: 2, ready: false, openNames: ['Certificate valid', 'Holds read'], words: '2 of 5 checks open' })
    expect(checkListHeld(CHECKS)).toBe('2 checks open: Certificate valid, Holds read')
    expect(checkListButton('Release', CHECKS)).toBe('Release · 2 checks open')
    const ready = CHECKS.map((check) => ({ ...check, state: 'pass' as const }))
    expect(checkListHeld(ready)).toBeNull()
    expect(checkListButton('Release', ready)).toBe('Release')
    expect(checkListSummary(ready).words).toBe('All 5 checks pass')
  })
  it('never claims a pass while checks run again, and says when there is nothing to check', () => {
    const running = [{ id: 'a', state: 'checking' as const, name: 'Stock' }]
    expect(checkListSummary(running).words).toBe('Checking again…')
    expect(checkListHeld(running)).toBe('Checking again…')
    expect(checkListSummary([]).words).toBe('No checks')
    expect(checkListSummary([]).ready).toBe(false)
  })
})

describe('CheckList', () => {
  it('draws each state with its word, the reason and the fix only where it does not pass', () => {
    const html = render(h(CheckList, { checks: CHECKS, label: 'Before release', linkAs: Link }))
    expect(html).toContain('aria-label="Before release"')
    for (const word of ['Done', 'Open', 'Warning', 'Not needed', 'Unknown']) expect(html).toContain(`>${word}<`)
    expect(html).toContain('EN 17092 expired on 12 Oct')
    expect(html).toContain('href="/compliance/certificates/9"')
    expect(html).toContain('role="status"')
    expect(html).toContain('2 of 5 checks open')
  })
  it('keeps the live region when the summary is not drawn, and speaks the words it is given', () => {
    const html = render(h(CheckList, { checks: CHECKS, label: 'Prima del rilascio', summary: false, linkAs: Link, labels: { states: { pass: 'Fatto', warning: 'Attenzione', fail: 'Aperto', checking: 'Verifica', skipped: 'Non serve', unknown: 'Non noto' }, open: (o, t) => `${o} su ${t} aperti` } }))
    expect(html).toContain('class="nds-vh" role="status"')
    expect(html).toContain('2 su 5 aperti')
    expect(html).toContain('>Aperto<')
    expect(html).not.toContain('>Open<')
  })
})
