import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BLANK_RETURN } from './model'
import { newReturnDraftOf, returnableQueryOf } from './use-new-return'

/**
 * F-OS-303 (order SHIPMENTS tab; 13-backend §7, B-OS-005; 18-lead-settles L8) — New return, extracted from ReturnsPage so the order's
 * Shipments tab opens the SAME window in place: blank on Returns' page; from the tab, this customer and order and, from a shipment's
 * row, that shipment's lines only (the return itself records no shipment). Made-up data only.
 */

const party = { id: 'party-a', code: 'SEED-C1', legalName: 'Seed Customer One', tradeName: null }

describe('the window\'s first draft and what it offers', () => {
  it('blank on Returns\' page; the seed\'s customer and order from the tab', () => {
    expect(newReturnDraftOf()).toBe(BLANK_RETURN)
    expect(newReturnDraftOf({ party, salesOrderId: 'so-2', shipmentId: 'sh-12' })).toEqual({ ...BLANK_RETURN, partyId: 'party-a', salesOrderId: 'so-2' })
    expect(newReturnDraftOf({ party })).toEqual({ ...BLANK_RETURN, partyId: 'party-a', salesOrderId: '' })
  })

  it('L8: from a shipment\'s row the returnable read asks that shipment\'s lines (B-OS-005); else the customer\'s', () => {
    expect(returnableQueryOf('co-1', 'party-a', 'sh-12')).toEqual({ companyId: 'co-1', partyId: 'party-a', shipmentId: 'sh-12' })
    expect(returnableQueryOf('co-1', 'party-a', null)).toEqual({ companyId: 'co-1', partyId: 'party-a' })
  })
})

describe('one window, one state: ReturnsPage and the tab both use the hook (extracted, never copied)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('ReturnsPage keeps no New return state of its own; the door draws the same NewReturnModal', () => {
    const page = source('./ReturnsPage.tsx')
    expect(page).toContain('useNewReturn({ api, companyId, today,')
    expect(page).not.toMatch(/setNewReturn|createReturn\(|listReturnable\(/)
    const door = source('./NewReturnDoor.tsx')
    expect(door).toContain('<NewReturnModal model={door.model} actions={{ ...door.actions, onNewReturnClose: onClose }} />')
    expect(source('./use-new-return.ts')).toContain('listReturnable(api, returnableQueryOf(companyId, partyId, shipmentId))')
    expect(source('../orders/record/use-shipments-acts.ts')).toContain('createElement(NewReturnDoor, {')
  })
})
