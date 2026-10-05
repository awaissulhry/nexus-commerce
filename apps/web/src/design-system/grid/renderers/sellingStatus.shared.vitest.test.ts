import { describe, expect, it } from 'vitest'
import {
  ALREADY_DELETED, deletedOn, EBAY_NEW_INACTIVE_CHECK, NEW_LISTING_SENTENCE, NOT_LISTED_MAIN_WARNING, RELIST_SENTENCE, SELLING_STATE_LABEL, STATUS_TARGET_LABEL,
  STATUS_TARGET_STATE, statusOptionsFor, ALREADY_UNLINKED, deletedStatusReason, newListingSentence, UNLINKED_NOT_LISTED,
} from '@nexus/shared/listing-actions'
import { NEW_LISTING_SENT_WHOLE, NOTHING_TO_DELETE_YET, SEND_MODE_LABEL, sendModeOptions } from '@nexus/shared/publish-actions'
import { NEW_ROW_FULL_NOTE, NEW_ROW_SENT_WHOLE, SEND_MODE_WORD, sendModeEditorOptions } from './publishAction'
import { NEW_CHOICE_DELETED, NEW_CHOICE_UNLINKED, newListingAside, SELLING_STATE_WORD, STATUS_TARGET_SELLING_STATE, STATUS_TARGET_WORD, newListingEditorOptions, statusEditorOptions } from './sellingStatus'

/**
 * WEB ONLY (no Factory copy): the design system spells the Status and Action words itself because it is also compiled in
 * apps/factory, which has no runtime dependency on @nexus/shared. This file holds them equal to the shared tables the
 * API and the Publish review read, and runs the editor options on the shared rules' real output.
 */
describe('one vocabulary with @nexus/shared', () => {
  it('the words are the shared words', () => {
    expect(SELLING_STATE_WORD).toEqual(SELLING_STATE_LABEL)
    expect(STATUS_TARGET_WORD).toEqual(STATUS_TARGET_LABEL)
    expect(STATUS_TARGET_SELLING_STATE).toEqual(STATUS_TARGET_STATE)
    expect(SEND_MODE_WORD).toEqual(SEND_MODE_LABEL)
  })

  it('one set of selling words: Active · Inactive · Not listed · Ended, Mixed (a draft reads Not listed)', () => {
    expect(SELLING_STATE_WORD).toMatchObject({ active: 'Active', paused: 'Inactive', not_listed: 'Not listed', draft: 'Not listed', ended: 'Ended', mixed: 'Mixed' })
  })

  it('an Amazon FBA row: Amazon never shows Ended; Inactive carries the FBA warning', () => {
    const options = statusEditorOptions(statusOptionsFor('active', 'amazon', { isFba: true }), 'active')
    expect(options.map(o => o.value)).toEqual(['active', 'inactive'])
    expect(options.find(o => o.value === 'inactive')?.note).toMatch(/^Amazon runs this offer \(FBA\)\./)
    expect(options.find(o => o.value === 'active')?.heldReason).toBeUndefined()
  })

  it('an eBay variation: Full update and Delete are held, Partial update stays the default', () => {
    const options = sendModeEditorOptions(sendModeOptions('ebay-trading', 'active', { isParent: false, isVariation: true }))
    expect(options.map(o => [o.value, Boolean(o.heldReason)])).toEqual([['partial', false], ['full', true], ['delete', true]])
    expect(options[2].heldReason).toMatch(/Choose Delete on the main row\./)
  })

  it('a row Nexus deleted is a row not on the channel: Full update (sent whole), Partial update and Delete held; its Status chooses as a new row', () => {
    const deleted = { at: '2026-10-04T08:00:00.000Z', where: 'Amazon · IT', oldReference: 'B0OLD12345', relistChosenAt: null }
    const options = sendModeEditorOptions(sendModeOptions('amazon', 'not_listed', { isParent: false, isVariation: false, deleted }), null, Date.now(), true)
    expect(options.map(o => [o.value, o.label, o.heldReason ?? null])).toEqual([['partial', 'Partial update', NEW_LISTING_SENT_WHOLE], ['full', 'Full update', null], ['delete', 'Delete', ALREADY_DELETED('Amazon · IT')]])
    expect(options[1].note).toBe(NEW_ROW_FULL_NOTE)
    const status = newListingEditorOptions(statusOptionsFor('not_listed', 'amazon', { deleted }), { target: 'not_listed', source: 'default', deleted: { on: deletedOn(deleted.at) } })
    expect(status.map(o => [o.value, o.note])).toEqual([['active', RELIST_SENTENCE.active], ['inactive', RELIST_SENTENCE.inactive], ['not_listed', `${RELIST_SENTENCE.not_listed} ${NEW_CHOICE_DELETED}`]])
  })

  it('a row Nexus UNLINKED: Delete held with the unlink\'s words; its Status offers only Not listed — never Active → Publish as a new item', () => {
    const unlinked = { at: '2026-10-05T08:00:00.000Z', where: 'eBay · IT', oldReference: '520000000001', relistChosenAt: null, sku: null, unlinked: true as const }
    const send = sendModeEditorOptions(sendModeOptions('ebay-trading', 'not_listed', { isParent: true, isVariation: false, deleted: unlinked }), null, Date.now(), true)
    expect(send[2].value).toBe('delete')
    const status = newListingEditorOptions(statusOptionsFor('not_listed', 'ebay-trading', { deleted: unlinked }),
      { target: 'not_listed', source: 'default', deleted: { on: deletedOn(unlinked.at), unlinked: true } })
    expect(status.map(o => [o.value, o.heldReason ?? null])).toEqual([['active', deletedStatusReason(unlinked)], ['inactive', deletedStatusReason(unlinked)], ['not_listed', null]])
    expect(status[2].note).toBe(`${UNLINKED_NOT_LISTED} ${NEW_CHOICE_UNLINKED}`)
    expect(newListingAside({ target: 'not_listed', source: 'default', deleted: { on: deletedOn(unlinked.at), unlinked: true } })).toBe(`unlinked ${deletedOn(unlinked.at)}`)
    expect(newListingSentence({ target: 'not_listed', source: 'default' }, { deleted: unlinked })).toBe(deletedStatusReason(unlinked))
    expect(ALREADY_UNLINKED('eBay · IT')).toMatch(/^Unlinked from eBay · IT: Nexus no longer holds its Item ID/)
  })

  it('a new row: Full update with the shared words; the editors run on the shared new-listing options', () => {
    expect(NEW_ROW_SENT_WHOLE).toBe(NEW_LISTING_SENT_WHOLE)
    const send = sendModeEditorOptions(sendModeOptions('amazon', 'not_listed', { isParent: true, isVariation: false, noRecord: true }), null, Date.now(), true)
    expect(send.map(o => [o.value, o.heldReason ?? null])).toEqual([['partial', NEW_LISTING_SENT_WHOLE], ['full', null], ['delete', NOTHING_TO_DELETE_YET]])
    const status = newListingEditorOptions(statusOptionsFor('draft', 'ebay-trading', { isMain: true }), { target: 'active', source: 'default' })
    expect(status.map(o => o.value)).toEqual(['active', 'inactive', 'not_listed'])
    expect(status[1].note).toBe(`${NEW_LISTING_SENTENCE.inactive} ${EBAY_NEW_INACTIVE_CHECK}`)
    expect(status[2].note).toBe(`${NEW_LISTING_SENTENCE.not_listed} ${NOT_LISTED_MAIN_WARNING}`)
  })
})
