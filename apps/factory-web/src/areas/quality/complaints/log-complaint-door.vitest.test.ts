import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { blankLogDraft } from './model'
import { logDraftOf } from './use-log-complaint'

/**
 * F-OS-303 (order SHIPMENTS tab; 13-backend §7 "Log a complaint…") — Log complaint, extracted from ComplaintsPage so the order's
 * Shipments tab opens the SAME window in place: blank on the Complaints page (`?new=1`); from the tab, this customer and order and,
 * from a shipment's row, that shipment (the create takes `shipmentId`). Made-up data only.
 */

const party = { id: 'party-a', code: 'SEED-C1', legalName: 'Seed Customer One', tradeName: null }

describe('the window\'s first draft', () => {
  it('blank on the page; the seed\'s customer, order and shipment from the tab', () => {
    expect(logDraftOf('2026-11-22')).toEqual(blankLogDraft('2026-11-22'))
    expect(logDraftOf('2026-11-22', { party, salesOrderId: 'so-2', shipmentId: 'sh-11' })).toEqual({ ...blankLogDraft('2026-11-22'), partyId: 'party-a', salesOrderId: 'so-2', shipmentId: 'sh-11' })
    expect(logDraftOf('2026-11-22', { party, salesOrderId: 'so-2' })).toMatchObject({ partyId: 'party-a', salesOrderId: 'so-2', shipmentId: '' })
  })
})

describe('one window, one state: ComplaintsPage and the tab both use the hook (extracted, never copied)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('ComplaintsPage keeps no Log complaint state of its own; the door draws the same LogComplaintModal', () => {
    const page = source('./ComplaintsPage.tsx')
    expect(page).toContain('useLogComplaint({')
    expect(page).not.toMatch(/setLog\(|logComplaint\(|previewComplaint\(/)
    expect(source('./LogComplaintDoor.tsx')).toContain('<LogComplaintModal model={door.model} prefix={prefix} actions={{ ...door.actions, onLogClose: onClose }} />')
    expect(source('../../sales/orders/record/use-shipments-acts.ts')).toContain('createElement(LogComplaintDoor, {')
  })
})
