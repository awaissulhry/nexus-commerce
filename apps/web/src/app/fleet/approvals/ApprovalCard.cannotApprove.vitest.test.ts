import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApprovalCard, type CardApproval } from './ApprovalCard'

/**
 * The card never offers an Apply that can only fail, and says why a handed-back request has its full time again.
 * Rendered HTML (node SSR; precedent `_studio/NoMarketState.vitest.test.ts`).
 */
const base: CardApproval = {
  id: 'approval-1',
  toolName: 'publish-listing',
  charterKey: null,
  riskTier: 'high',
  status: 'pending',
  args: { productId: 'product-1', channel: 'AMAZON' },
  preview: { action: 'publish-listing', channel: 'AMAZON', currentlyPublished: false },
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
  reason: null,
  trackRecord: null,
}
const noop = () => {}
const html = (approval: Partial<CardApproval>) =>
  renderToStaticMarkup(createElement(ApprovalCard, {
    approval: { ...base, ...approval },
    labels: { campaigns: {}, targets: {} },
    workerName: 'Manual action',
    busy: false,
    // Preview-only here, so no acknowledgement box stands between the viewer and Apply: what disables it is the point.
    canExecute: false,
    onDecide: noop,
    onRecheck: async () => ({ stale: false, why: null }),
    onAmend: async () => ({ ok: true }),
    onSnooze: noop,
  }))
/** The primary button's opening tag (it carries the `go` class). */
const applyTag = (markup: string) => markup.match(/<button[^>]*class="acr-btn go"[^>]*>/)?.[0] ?? ''
const rejectTag = (markup: string) => markup.match(/<button[^>]*class="acr-btn"[^>]*>(?=(?:(?!<\/button>).)*Reject)/s)?.[0] ?? ''

const REFUSAL = 'publish-listing needs the listings.publish permission.'

describe('ApprovalCard — a request the viewer may not approve', () => {
  it('a viewer who may approve: Apply is offered, no reason is shown', () => {
    const markup = html({})
    expect(applyTag(markup)).not.toBe('')
    expect(applyTag(markup)).not.toContain('disabled')
    expect(markup).not.toContain('You cannot apply this')
  })

  it('a viewer who may not: Apply is disabled, the reason is written out and tied to the button; Reject stays', () => {
    const markup = html({ cannotApprove: REFUSAL })
    const apply = applyTag(markup)
    expect(apply).toContain('disabled=""')
    expect(apply).toContain(`title="${REFUSAL}"`)
    const describedBy = apply.match(/aria-describedby="([^"]+)"/)?.[1]
    expect(describedBy).toBeTruthy()
    expect(markup).toContain(`id="${describedBy}">You cannot apply this: ${REFUSAL} You can still reject it.</p>`)
    expect(rejectTag(markup)).toMatch(/^<button/)
    expect(rejectTag(markup)).not.toContain('disabled')
  })

  it('handed back after the approver lost the permission: the card says it came back, and that it is no longer theirs', () => {
    const markup = html({
      reason: 'not run — Omar Approver no longer holds listings.publish, which publish listing needs',
      cannotApprove: REFUSAL,
    })
    expect(markup).toContain('You approved this before, and it did not run.')
    expect(markup).toContain('Omar Approver no longer holds listings.publish, which publish listing needs')
    expect(applyTag(markup)).toContain('disabled=""')
  })

  it('a handed-back request says why its waiting time starts over', () => {
    const markup = html({ reason: 'not run — the facts moved since you approved it' })
    expect(markup).toMatch(/Its waiting time restarted when it\s+came back: handing it back asks the question again, so the full time to decide starts over\./)
    // A request that never came back says nothing about it.
    expect(html({})).not.toContain('Its waiting time restarted')
  })
})
