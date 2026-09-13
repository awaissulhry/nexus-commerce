import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import messages from '@/lib/i18n/messages/en.json'
import { hardDeleteConfirmation, parseHardDeletePreflight, type PreflightWarnings } from './hardDelete'

const preflight: PreflightWarnings = { channelListings: [], openOrders: [], activeBundles: [], fbaInventory: [] }
const input = {
  productIds: ['p1'], products: [{ id: 'p1', sku: 'GALE-JACKET' }], preflight,
  loading: false, error: null, busy: false, typed: 'GALE-JACKET',
}

describe('D19 permanent deletion acknowledgement', () => {
  it('a failed or pending preflight blocks even an exact phrase', () => {
    expect(hardDeleteConfirmation(input).armed).toBe(true)
    expect(hardDeleteConfirmation({ ...input, error: 'HTTP 500' }).armed).toBe(false)
    expect(hardDeleteConfirmation({ ...input, error: '' }).armed).toBe(false)
    expect(hardDeleteConfirmation({ ...input, loading: true }).armed).toBe(false)
    expect(hardDeleteConfirmation({ ...input, preflight: null }).armed).toBe(false)
  })
  it.each(['gale-jacket', 'Gale-Jacket', ' GALE-JACKET', 'GALE-JACKET ', 'DELETE', 'delete'])('refuses the inexact phrase %j', typed => {
    expect(hardDeleteConfirmation({ ...input, typed }).armed).toBe(false)
  })
  it('takes the SKU from the actual selected product; a different row is not an acknowledgement', () => {
    expect(hardDeleteConfirmation(input).phrase).toBe('GALE-JACKET')
    expect(hardDeleteConfirmation({ ...input, products: [{ id: 'another', sku: 'GALE-JACKET' }] }).armed).toBe(false)
    expect(hardDeleteConfirmation({ ...input, products: [{ id: 'p1', sku: '' }] }).armed).toBe(false)
    expect(hardDeleteConfirmation({ ...input, productIds: ['p1', 'p2'] }).armed).toBe(false)
  })
  it('does not expose the phrase as a placeholder, and the click guard shares the button gate', () => {
    const source = readFileSync(new URL('./BulkActionBar.tsx', import.meta.url), 'utf8')
    const modal = source.slice(source.indexOf('function HardDeleteConfirmModal('), source.indexOf('// ── MA.1 Bulk Availability Modal'))
    expect(modal).toContain('hardDeleteConfirmation({')
    expect(modal).toContain('if (armed) onConfirm(channelAction)')
    expect(modal).toContain('disabled={!armed}')
    expect(modal).not.toContain('placeholder=')
    expect(modal).toContain("setChannelAction(data.channelListings.length === 0 ? 'none' : 'unpublish')")
  })
})

describe('W0 deletion copy describes PR.2 no-escalation adapters', () => {
  it("products.hardDelete.body", () => {
    expect(messages["products.hardDelete.body"]).toBe("The local product record and its dependent records are permanently deleted. There is no undo for the local deletion.")
  })
  it("products.hardDelete.preflightError", () => {
    expect(messages["products.hardDelete.preflightError"]).toBe("The check failed: {error}. Permanent deletion is blocked.")
  })
  it("products.hardDelete.channelAction.unpublish.label", () => {
    expect(messages["products.hardDelete.channelAction.unpublish.label"]).toBe("End the listing on each channel")
  })
  it("products.hardDelete.channelAction.unpublish.body", () => {
    expect(messages["products.hardDelete.channelAction.unpublish.body"]).toBe("Nexus asks each channel to stop selling, then deletes the local record either way. Amazon and eBay: the request is refused; the listing is not ended. Shopify: the request returns a visible failure; the store keeps selling it. WooCommerce and Etsy: nothing is sent. There is no relist from here.")
  })
  it("products.hardDelete.channelAction.delete.label", () => {
    expect(messages["products.hardDelete.channelAction.delete.label"]).toBe("Remove the listing from each channel")
  })
  it("products.hardDelete.channelAction.delete.body", () => {
    expect(messages["products.hardDelete.channelAction.delete.body"]).toBe("Nexus asks each channel to remove the listing, then deletes the local record either way. Amazon: the seller offer is deleted; the ASIN survives. eBay: the listing is ended; a relist gets a new item number. Shopify: the request returns a visible failure; the product is not deleted. WooCommerce and Etsy: nothing is sent.")
  })
  it("products.hardDelete.channelAction.none.body", () => {
    expect(messages["products.hardDelete.channelAction.none.body"]).toBe("The local product record and its dependent records are permanently deleted. Nothing is sent to any channel. Channel listings may keep selling. There is no undo for the local deletion.")
  })
  it("products.hardDelete.channelAction.note", () => {
    expect(messages["products.hardDelete.channelAction.note"]).toBe("Amazon and eBay refuse the first option; the second asks them to delete the seller offer or end the listing. Shopify returns a visible failure for either option. WooCommerce and Etsy receive nothing. The local record is deleted either way.")
  })
  it("products.hardDelete.submit.unpublish", () => {
    expect(messages["products.hardDelete.submit.unpublish"]).toBe("Delete locally and end on channel")
  })
  it("products.hardDelete.submit.delete", () => {
    expect(messages["products.hardDelete.submit.delete"]).toBe("Delete locally and remove from channel")
  })
})


describe('preflight boundary and server acknowledgement', () => {
  it('rejects missing checks while accepting four explicit empty checks', () => {
    expect(parseHardDeletePreflight(preflight)).toEqual(preflight)
    for (const key of Object.keys(preflight)) {
      const raw = { ...preflight } as Record<string, unknown>; delete raw[key]
      expect(() => parseHardDeletePreflight(raw), key).toThrow('incomplete')
    }
  })
  it('honours server refusal and refuses a missing or mismatched target', () => {
    expect(hardDeleteConfirmation({ ...input, preflight: { ...preflight, confirmPhrase: 'GALE-JACKET' } }).armed).toBe(true)
    expect(hardDeleteConfirmation({ ...input, preflight: { ...preflight, confirmPhrase: null } }).armed).toBe(false)
    expect(hardDeleteConfirmation({ ...input, preflight: { ...preflight, confirmPhrase: 'DELETE' }, typed: 'DELETE' }).armed).toBe(false)
    expect(hardDeleteConfirmation({ ...input, preflight: { ...preflight, refusal: 'Refused by the server.' } }).reason).toBe('Refused by the server.')
  })
})
