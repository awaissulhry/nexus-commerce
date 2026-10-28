import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ActionConfirm, canConfirmAction } from './ActionConfirm'
import type { ActionImpact } from '../grid/actions/registry'
const impact: ActionImpact = { level: 'type-to-confirm', title: 'Remove SKU-1?', reach: 'local-destructive', reversal: { verb: 'None', fidelity: 'none' }, subject: { kind: 'sku', value: 'SKU-1' }, confirmPhrase: 'SKU-1' }
it('requires exact typing and every supplied acknowledgement, with visible instructions', () => {
 expect(canConfirmAction(impact, 'SKU-1', false)).toBe(true)
 for (const input of ['', 'sku-1', ' SKU-1', 'SKU-1 ']) expect(canConfirmAction(impact, input, true)).toBe(false)
 expect(canConfirmAction({ ...impact, acknowledge: 'I accept this loss.' }, 'SKU-1', false)).toBe(false)
 expect(canConfirmAction({ ...impact, acknowledge: 'I accept this loss.' }, 'SKU-1', true)).toBe(true)
 const html = render(createElement(ActionConfirm, { impact, mode: 'inline', onConfirm: vi.fn(), onCancel: vi.fn() }))
 expect(html).toContain('exactly to confirm'); expect(html).toContain('data-autofocus="true"')
 expect(html).not.toContain('autoFocus='); expect(html).not.toContain('nds-cell-strong')
 expect(html).toContain('This cannot be undone.')
})
it('never arms an unavailable or malformed direct-use impact and renders the refusal reason', () => {
 const refused = { ...impact, unavailable: 'Orders could not be checked.' }
 expect(canConfirmAction(refused, 'SKU-1', true)).toBe(false)
 expect(canConfirmAction({ ...impact, level: 'confirm' }, 'SKU-1', true)).toBe(false)
 const html = render(createElement(ActionConfirm, { impact: refused, mode: 'inline', onConfirm: vi.fn(), onCancel: vi.fn() }))
 expect(html).toContain('role="alert"'); expect(html).toContain('Orders could not be checked.')
})
it('renders advisory unknown checks and a read-only before/after table', () => {
 const html = render(createElement(ActionConfirm, { impact: { ...impact, findings: [{ label: 'Ads history', severity: 'unknown', blocking: false, asOf: null }], review: { title: 'Saved plan', rows: [{ label: 'Stock', before: '2', after: '0' }] } }, mode: 'inline', onConfirm: vi.fn(), onCancel: vi.fn() }))
 expect(html).toContain('Not checked: Ads history'); expect(html).toContain('not checked')
 expect(html).toContain('<table'); expect(html).toContain('Before'); expect(html).toContain('After')
})
