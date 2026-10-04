import { describe, expect, it } from 'vitest'
import {
  AMAZON_RELIST_NO_MATCH, amazonIssuesInText, amazonRelistAnswer, contentGoesOut, countWaiting, explainAmazonRelist, fbaNewAsinWarning,
  fillResultSentence, isRelistChoice, isStaleWaiting, needsTypedConfirm, parseSendMode, parseStatusTarget, publishPlanSummary,
  relistSentence, SEND_ORDER, sendModeOf, sendModeOptions, statusTargetOf, storedSendMode, storedStatusTarget,
  waitingMark, NEW_LISTING_SENT_WHOLE, SEND_MODE_LABEL, SEND_MODES, newRowId, parseNewRowId, isNewRowId, startedSentence, leftOutSentence,
  SHARED_NO_LISTING,
} from './publish-actions.js'
import { AMAZON_FBA_DELETE_WARNING, type ListingDeletion } from './listing-actions.js'

/** Build shape v2 (Owner 2026-10-04) — the Action column's options, paste parsing, waiting values and the send order. */
const row = { isParent: false, isVariation: false }
const offered = (options: ReturnType<typeof sendModeOptions>) => options.filter(o => o.offered).map(o => o.mode)

describe('Action column options', () => {
  it('Partial update is always offered; Amazon offers Full update and Delete on a listed row', () => {
    expect(offered(sendModeOptions('amazon', 'active', row))).toEqual(['partial', 'full', 'delete'])
    expect(sendModeOptions('amazon', 'active', row).find(o => o.mode === 'full')!.warning).toMatch(/removed/)
  })
  it('a row not on the channel reads Full update (sent whole); Partial update and Delete are held with the reason', () => {
    for (const state of ['draft', 'not_listed'] as const) {
      const options = sendModeOptions('amazon', state, row)
      expect(offered(options)).toEqual(['full'])
      expect(options.find(o => o.mode === 'full')!.warning).toBe('A new listing is always sent whole.')
      expect(options.find(o => o.mode === 'partial')!.reason).toBe(NEW_LISTING_SENT_WHOLE)
      expect(options.find(o => o.mode === 'delete')!.reason).toBe('Nothing to delete yet. To leave it out, set Status to Not listed.')
    }
    // Partial update, Full update and Delete are the only Action values (no Create, Deleted or Keep deleted).
    expect(SEND_MODE_LABEL).toEqual({ partial: 'Partial update', full: 'Full update', delete: 'Delete' })
    expect(SEND_MODES).toEqual(['partial', 'full', 'delete'])
  })
  it('FBA may be deleted, with its warning', () => {
    expect(sendModeOptions('amazon', 'active', { ...row, isFba: true }).find(o => o.mode === 'delete')).toMatchObject({ offered: true, reason: null, warning: AMAZON_FBA_DELETE_WARNING })
    expect(sendModeOptions('amazon', 'active', row).find(o => o.mode === 'delete')!.warning).toBeNull()
  })
  it('eBay changes whole listings: Full and Delete only on the main row', () => {
    expect(offered(sendModeOptions('ebay-trading', 'active', { isParent: true, isVariation: false }))).toEqual(['partial', 'full', 'delete'])
    expect(offered(sendModeOptions('ebay-trading', 'active', { isParent: false, isVariation: true }))).toEqual(['partial'])
    expect(offered(sendModeOptions('ebay-inventory', 'active', { isParent: true, isVariation: false }))).toEqual(['partial', 'delete'])
  })
  it('an ended listing must be relisted before a Full update', () => {
    expect(sendModeOptions('ebay-trading', 'ended', { isParent: true, isVariation: false }).find(o => o.mode === 'full')!.reason).toMatch(/relist/)
  })
  it('Shopify: no content update of an existing product yet; Delete on the main row', () => {
    expect(offered(sendModeOptions('shopify', 'active', { isParent: true, isVariation: false }))).toEqual(['partial', 'delete'])
    expect(offered(sendModeOptions('shopify', 'active', { isParent: false, isVariation: true }))).toEqual(['partial'])
  })
})

describe('stored values and paste', () => {
  it('round-trips the stored values (null = Partial update / no status change)', () => {
    expect(storedSendMode('partial')).toBeNull()
    expect(sendModeOf(storedSendMode('full'))).toBe('full')
    expect(sendModeOf(null)).toBe('partial')
    expect(storedStatusTarget('inactive')).toBe('INACTIVE')
    expect(statusTargetOf('ENDED')).toBe('ended')
    expect(statusTargetOf(null)).toBeNull()
  })
  it('reads pasted words in any case and spelling', () => {
    expect(parseSendMode('Partial update')).toBe('partial')
    expect(parseSendMode('partial_update')).toBe('partial')
    expect(parseSendMode('FULL')).toBe('full')
    expect(parseSendMode('Delete')).toBe('delete')
    expect(parseSendMode('pause')).toBeNull()
    expect(parseStatusTarget('Inactive')).toBe('inactive')
    expect(parseStatusTarget('pause')).toBe('inactive')
    expect(parseStatusTarget('Relist')).toBe('active')
    expect(parseStatusTarget('end listing')).toBe('ended')
    expect(parseStatusTarget('draft')).toBeNull()
  })
})

describe('waiting values', () => {
  const now = Date.parse('2026-10-04T12:00:00Z')
  it('a value set by someone else, or more than a day ago, is stale', () => {
    expect(isStaleWaiting({ setAt: '2026-10-04T11:00:00Z', setById: 'me' }, 'me', now)).toBe(false)
    expect(isStaleWaiting({ setAt: '2026-10-04T11:00:00Z', setById: 'maria' }, 'me', now)).toBe(true)
    expect(isStaleWaiting({ setAt: '2026-10-03T11:00:00Z', setById: 'me' }, 'me', now)).toBe(true)
  })
  it('Ended and Delete need a typed confirmation', () => {
    expect(needsTypedConfirm({ kind: 'send', value: 'delete' })).toBe(true)
    expect(needsTypedConfirm({ kind: 'status', value: 'ended' })).toBe(true)
    expect(needsTypedConfirm({ kind: 'status', value: 'inactive' })).toBe(false)
    expect(needsTypedConfirm({ kind: 'send', value: 'full' })).toBe(false)
  })
  it('the toolbar mark counts every waiting value; danger when an End or a Delete waits', () => {
    const counts = countWaiting([{ kind: 'status', value: 'inactive' }, { kind: 'status', value: 'inactive' }, { kind: 'status', value: 'ended' }, { kind: 'send', value: 'full' }])
    expect(waitingMark(counts)).toEqual({ label: '4 waiting for Publish', detail: '2 inactive · 1 ended · 1 full update', danger: true })
    expect(waitingMark(countWaiting([{ kind: 'send', value: 'full' }]))).toMatchObject({ danger: false })
    expect(waitingMark(countWaiting([]))).toBeNull()
  })
  it('the fill toast names the rows that were not allowed', () => {
    expect(fillResultSentence('Inactive', { applied: ['a', 'b'], refused: [{ listingId: 'c', sku: 'GALE-S', reason: 'Etsy has no End here.' }], conflicts: [] }))
      .toBe('Inactive set on 2 rows. 1 not allowed: GALE-S (Etsy has no End here.).')
  })
})

describe('one Publish', () => {
  it('resumes and relists first, sends content, then pauses, ends and deletes', () => {
    expect(SEND_ORDER).toEqual(['resume', 'relist', 'content', 'pause', 'end', 'delete'])
  })
  it('a row being ended or deleted sends no content', () => {
    expect(contentGoesOut('partial', null)).toBe(true)
    expect(contentGoesOut('full', 'pause')).toBe(true)
    expect(contentGoesOut('partial', 'end')).toBe(false)
    expect(contentGoesOut('delete', null)).toBe(false)
  })
  it('says the whole plan in one line', () => {
    expect(publishPlanSummary({ partial: 18, fields: 41, full: 2, delete: 1, active: 0, inactive: 3, ended: 1 }))
      .toBe('18 partial updates (41 fields) · 2 full updates · 3 inactive · 1 ended · 1 delete')
  })
})

/** Delete and relist (Owner 2026-10-04) — the Action column on a deleted row, the relist rule, and Amazon's answers. */
describe('delete and relist', () => {
  const deletion: ListingDeletion = { at: '2026-10-04T12:00:00.000Z', where: 'Amazon · IT', oldReference: 'B0OLD00001', relistChosenAt: null }

  it('a deleted row is a row not on the channel: its Action reads Full update; Partial update and Delete are held', () => {
    const options = sendModeOptions('amazon', 'not_listed', { ...row, deleted: deletion })
    expect(options).toEqual([
      { mode: 'partial', offered: false, reason: NEW_LISTING_SENT_WHOLE, warning: null },
      { mode: 'full', offered: true, reason: null, warning: NEW_LISTING_SENT_WHOLE },
      { mode: 'delete', offered: false, reason: 'Already deleted on Amazon · IT. To keep it off, leave its Status Not listed.', warning: null },
    ])
    expect(offered(sendModeOptions('ebay-trading', 'not_listed', { isParent: false, isVariation: true, deleted: deletion }))).toEqual(['full'])
  })

  it('an OLDER relist choice (read as Status Active) is a Partial (no value, with a time) or Full update made AFTER the delete', () => {
    expect(isRelistChoice({ value: null, at: '2026-10-04T12:30:00Z' }, deletion.at)).toBe(true)
    expect(isRelistChoice({ value: 'FULL_UPDATE', at: new Date('2026-10-04T12:30:00Z') }, deletion.at)).toBe(true)
    expect(isRelistChoice({ value: 'FULL_UPDATE', at: '2026-10-04T11:00:00Z' }, deletion.at)).toBe(false)
    expect(isRelistChoice({ value: 'DELETE', at: '2026-10-04T12:30:00Z' }, deletion.at)).toBe(false)
    expect(isRelistChoice({ value: null, at: null }, deletion.at)).toBe(false)
  })

  it('the Publish window says which ASIN a relist lists on; FBA units of the old ASIN are a warning', () => {
    expect(relistSentence('GALE-M', 'B0NEW00001', 'B0OLD00001', 'AMAZON')).toBe('Lists GALE-M on ASIN B0NEW00001 (was B0OLD00001).')
    expect(relistSentence('GALE-M', 'B0OLD00001', 'B0OLD00001', 'AMAZON')).toBe('Lists GALE-M again on ASIN B0OLD00001.')
    expect(relistSentence('GALE-M', null, 'B0OLD00001', 'AMAZON')).toMatch(/^Lists GALE-M again \(it was ASIN B0OLD00001/)
    expect(relistSentence('GALE-M', null, '111', 'EBAY')).toBe('Lists GALE-M again.')
    expect(fbaNewAsinWarning({ sellable: 12, inbound: 2, reserved: 0, other: 0, readAt: null }, 'B0OLD00001'))
      .toBe('Amazon holds 14 units labelled for B0OLD00001. They cannot sell on the new ASIN; ask Amazon for a removal order.')
    expect(fbaNewAsinWarning({ sellable: 0, inbound: 0, reserved: 0, other: 0, readAt: null }, 'B0OLD00001')).toBeNull()
  })

  it('Amazon\'s refusal of a relist in plain words (13013 too early, 8005/8541/8542 linked elsewhere, 8560 no match)', () => {
    const now = Date.parse('2026-10-04T12:12:00Z')
    const ctx = { deletedAt: '2026-10-04T12:00:00Z', oldAsin: 'B0OLD00001', asin: 'B0OLD00001' }
    expect(amazonRelistAnswer([{ code: '13013', message: 'SKU recently deleted' }], ctx, now))
      .toBe('Amazon is still removing this SKU (deleted 12 minutes ago). Try again later; Amazon can take up to 24 hours.')
    expect(amazonRelistAnswer([{ code: '8005', message: 'The SKU is associated with ASIN B0ELSEWHR1.' }], ctx, now))
      .toBe('Amazon still links this SKU to ASIN B0ELSEWHR1 in another market. Delete it there first.')
    expect(amazonRelistAnswer([{ code: '8005', message: 'no asin named' }], ctx, now)).toBe('Amazon still links this SKU to ASIN B0OLD00001 in another market. Delete it there first.')
    // 8541 on the SAME ASIN is a catalogue data conflict, not the delete: Amazon's words speak alone.
    expect(amazonRelistAnswer([{ code: '8541', message: 'conflicts with ASIN B0OLD00001' }], ctx, now)).toBeNull()
    expect(amazonRelistAnswer([{ code: '8542', message: 'data conflict' }], { ...ctx, asin: 'B0NEW00001' }, now))
      .toBe('Amazon still links this SKU to ASIN B0OLD00001 in another market. Delete it there first.')
    expect(amazonRelistAnswer([{ code: '8560', message: 'missing data' }], ctx, now)).toBe(AMAZON_RELIST_NO_MATCH)
    expect(amazonRelistAnswer([{ code: '90220', message: 'other' }], ctx, now)).toBeNull()
  })

  it('reads the codes out of the validation text and keeps Amazon\'s words beside the sentence', () => {
    expect(amazonIssuesInText('GALE-1234: 8005: The SKU is associated with ASIN B0ELSEWHR1. | 13013: wait')).toEqual([
      { code: '8005', message: 'The SKU is associated with ASIN B0ELSEWHR1.' }, { code: '13013', message: 'wait' }])
    const publication = { scope: { channel: 'AMAZON' }, relist: [{ productId: 'p', sku: 'GALE-1234', deletedAt: '2026-10-04T12:00:00Z', oldReference: 'B0OLD00001', asin: null }] }
    const now = Date.parse('2026-10-04T14:00:00Z')
    expect(explainAmazonRelist(publication, null, [], 'GALE-1234: 13013: SKU recently deleted', now))
      .toBe('Amazon is still removing this SKU (deleted 2 hours ago). Try again later; Amazon can take up to 24 hours. Amazon said: GALE-1234: 13013: SKU recently deleted')
    expect(explainAmazonRelist(publication, 'GALE-1234', [{ code: '8005', message: 'tied' }], 'tied', now)).toBe('Amazon still links this SKU to ASIN B0OLD00001 in another market. Delete it there first. Amazon said: tied')
    // Not a relist, another channel, or a code that is not about the delete: Amazon's words alone.
    expect(explainAmazonRelist(publication, 'OTHER', [{ code: '13013' }], 'words', now)).toBe('words')
    expect(explainAmazonRelist({ ...publication, scope: { channel: 'EBAY' } }, null, [], 'GALE-1234: 13013: x', now)).toBe('GALE-1234: 13013: x')
    expect(explainAmazonRelist(publication, 'GALE-1234', [{ code: '90220' }], 'words', now)).toBe('words')
  })
})

/** New listings (Owner 2026-10-04) — rows with no listing yet, the stored Not listed, the start and left-out words. */
describe('New listings', () => {
  it('a row with no listing has a new: id the write can send back', () => {
    const ref = { productId: 'p1', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc1', aliasKey: '' }
    expect(newRowId(ref)).toBe('new:p1:AMAZON:IT:acc1:')
    expect(parseNewRowId(newRowId(ref))).toEqual(ref)
    expect(isNewRowId('cl_123')).toBe(false)
    expect(parseNewRowId('new:p1:AMAZON:IT')).toBeNull()
  })
  it('Not listed is stored as NOT_LISTED and pasted from its words', () => {
    expect(storedStatusTarget('not_listed')).toBe('NOT_LISTED')
    expect(statusTargetOf('NOT_LISTED')).toBe('not_listed')
    expect(parseStatusTarget('Not listed')).toBe('not_listed')
    expect(parseStatusTarget('not_listed')).toBe('not_listed')
  })
  it('says what a write started, and what the Shared scope left out', () => {
    expect(startedSentence('Amazon · IT', { mainSku: 'GALE', variationSkus: ['GALE-S', 'GALE-M', 'GALE-L', 'GALE-XL', 'GALE-XXL', 'GALE-XS'] }))
      .toBe('Started Amazon · IT for GALE and 6 variations.')
    expect(startedSentence('eBay · DE', { mainSku: null, variationSkus: ['GALE-M'] })).toBe('Started eBay · DE for GALE-M.')
    expect(leftOutSentence(2)).toBe('2 markets without a listing were left out: set them in their own sheet.')
    expect(leftOutSentence(1)).toBe('1 market without a listing was left out: set it in its own sheet.')
    const sentence = fillResultSentence('Active', { applied: ['a'], refused: [{ listingId: 'b', sku: 'GALE-S', reason: SHARED_NO_LISTING }], conflicts: [],
      started: { sentence: 'Started Amazon · IT for GALE.', listingIds: ['x'], rows: [] }, leftOut: { count: 1, sentence: leftOutSentence(1) } })
    expect(sentence).toBe('Active set on 1 row. Started Amazon · IT for GALE. 1 market without a listing was left out: set it in its own sheet.')
  })
})
