/**
 * Approvals grid, Owner decision 1 = A (2026-10-05) — which kinds of change may be approved together, asked of the live
 * tool registry: never a plan, never a kind that cannot be undone, never one that reaches a buyer or a supplier, spends
 * money or removes something (NEVER_IN_BULK, each with its why). Everything else may, one kind at a time.
 */
import { describe, expect, it } from 'vitest'
import { listTools, getTool } from '../agents/tool-registry.js'
import { PLAN_TOOL } from '../agents/tool-types.js'
import { BULK_MAX_IDS, NEVER_IN_BULK, bulkApproveRefusal } from './bulk-approve-policy.js'

const changeTools = () => listTools().filter((tool) => !tool.readOnly && !tool.control)

describe('bulkApproveRefusal — what may be approved together', () => {
  it('every name on the never-in-bulk list is a registered change tool, with one plain sentence why', () => {
    for (const [name, why] of Object.entries(NEVER_IN_BULK)) {
      const tool = getTool(name)
      expect(tool, name).toBeDefined()
      expect(tool!.readOnly, name).toBe(false)
      expect(typeof tool!.execute, name).toBe('function')
      expect(bulkApproveRefusal(name)).toBe(why)
      expect(why).toMatch(/^[A-Z].*\.$/)
    }
  })

  it('the never-in-bulk list: refunds, buyer and supplier messages, reviews, cancels, closes and removals, merges, disposals, labels', () => {
    expect(Object.keys(NEVER_IN_BULK).sort()).toEqual([
      'buy-shipping-label',
      'cancel-order',
      'cancel-purchase-order',
      'close-listing',
      'discard-new-products',
      'dispose-return-items',
      'email-supplier',
      'issue-refund',
      'merge-duplicate-products',
      'remove-draft-listings',
      'remove-unused-photo',
      'reply-to-review',
      'request-review',
      'send-customer-message',
      'unlink-channel-id',
      'void-shipping-label',
    ])
  })

  it('a kind the registry says cannot be undone is never approved together, whether or not it is on the list', () => {
    const none = changeTools().filter((tool) => (tool.reversibility ?? 'none') === 'none')
    expect(none.length).toBeGreaterThan(10)
    for (const tool of none) expect(bulkApproveRefusal(tool.name), tool.name).not.toBeNull()
    // Off the list, it says the tool's own title.
    expect(bulkApproveRefusal('sync-orders-now')).toBe('Sync orders now cannot be undone once it runs, so each one is approved on its own.')
  })

  it('a change plan, a control tool, a read and an unknown kind are never approved together', () => {
    expect(bulkApproveRefusal(PLAN_TOOL)).toBe('A change plan is approved on its own: open it to see its steps, then approve it there.')
    expect(bulkApproveRefusal('undo-change')).toBe('This is not a change request, so it cannot be approved together with others.')
    expect(bulkApproveRefusal('approval-status')).toBe('This is not a change request, so it cannot be approved together with others.')
    expect(bulkApproveRefusal('no-such-tool')).toBe('Nexus does not know this kind of change, so it cannot be approved together with others.')
  })

  it('kinds that can be put back, fully or partly, may be approved together (one kind at a time)', () => {
    for (const name of ['set-price', 'bulk-price-change', 'set-target-bid', 'create-negative-keyword', 'apply-content', 'set-stock', 'publish-listing', 'set-listing-price']) {
      expect(bulkApproveRefusal(name), name).toBeNull()
    }
    // Every allowed kind can be put back at least in part.
    for (const tool of changeTools()) {
      if (bulkApproveRefusal(tool.name) === null) expect(['full', 'partial'], tool.name).toContain(tool.reversibility)
    }
  })

  it('a bulk call holds at most 200 requests', () => {
    expect(BULK_MAX_IDS).toBe(200)
  })
})
