import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import { createClaim, makeLetter, removeClaimPhoto } from './api'
import { canFor, claim, CLAIM_PHOTOS, FOUND_LOTS, LEATHER_STOCK, LOT_HIDES, PAD_STOCK, REASON_LIST } from './demo/fixtures'
import { claimsAddress, evidenceRefusal, fileOpenHeld, letterKeepHeld, newClaimBody, newClaimHeld, NO_RETURN, photoAddHeld, photoRemoveHeld, ready, returnHeld, type ReturnDraft } from './model'

/**
 * Purchasing › Returns & claims, W2b (B-W2b-14; SCM-135): New claim (the Return dialog's claim mode), the claim's photos
 * and letter — the pure rules and the calls (made-up data).
 */

const draft = (over: Partial<ReturnDraft> = {}): ReturnDraft => ({ ...NO_RETURN, reasons: ready(REASON_LIST), ...over })
const leather = (over: Partial<ReturnDraft> = {}) => draft({ lot: FOUND_LOTS[0]!, stock: ready(LEATHER_STOCK), hides: ready(LOT_HIDES), hideIds: LOT_HIDES.map((hide) => hide.id), ...over })

describe('New claim (design page.h#1, W2b)', () => {
  it('needs claims.manage and the stock read, a lot, its goods and the reason — never a DDT or the return permission', () => {
    expect(newClaimHeld(draft(), canFor('readOnly'))).toEqual({ key: 'held.permission', params: { permission: 'purchasing.claims.manage' } })
    expect(newClaimHeld(draft(), canFor('buyer'))).toEqual({ key: 'ret.held.lot' })
    expect(newClaimHeld(leather(), canFor('buyer'))).toEqual({ key: 'ret.held.reason' })
    expect(newClaimHeld(leather({ reasonCode: 'QUALITY' }), canFor('buyer'))).toBeNull()
    // The buyer may not send goods back, but may claim.
    expect(returnHeld(leather({ reasonCode: 'QUALITY' }), canFor('buyer'))).not.toBeNull()
  })

  it('the body: a CLAIM from the hides named, the whole lot, or one line of the quantity typed; where it was found when chosen', () => {
    expect(newClaimBody(leather({ reasonCode: 'QUALITY', reasonNote: ' Buchi ', foundAt: 'CUTTING' }))).toEqual({ kind: 'CLAIM', reasonCode: 'QUALITY', reasonNote: 'Buchi', remedy: 'CREDIT', foundAt: 'CUTTING', from: { lotId: FOUND_LOTS[0]!.id, hideIds: LOT_HIDES.map((hide) => hide.id) } })
    const pads = draft({ lot: FOUND_LOTS[1]!, stock: ready(PAD_STOCK), hides: ready([]), reasonCode: 'WRONG_ITEM' })
    const all = Object.fromEntries(PAD_STOCK.filter((row) => Number(row.onHand) > 0).map((row) => [row.location.id, row.onHand]))
    expect(newClaimBody({ ...pads, quantities: all })).toMatchObject({ kind: 'CLAIM', from: { lotId: FOUND_LOTS[1]!.id } })
    expect(newClaimBody({ ...pads, quantities: { [PAD_STOCK[0]!.location.id]: '6', [PAD_STOCK[1]!.location.id]: '1,5' } })).toMatchObject({ kind: 'CLAIM', lines: [{ lotId: FOUND_LOTS[1]!.id, quantity: '7.5', uom: FOUND_LOTS[1]!.item.baseUom }] })
  })

  it('opens from the address (?new=1)', () => {
    expect(claimsAddress('/w/DEMO/purchasing/claims', 'open', { q: '', kind: null, receipt: null, lot: null }, { newOpen: true })).toBe('/w/DEMO/purchasing/claims?new=1')
  })
})

describe("the claim's photos and letter (Z1:08)", () => {
  const draftClaim = { ...claim('CLAIM', 'DRAFT'), photos: CLAIM_PHOTOS }
  const sent = { ...claim('CLAIM', 'SENT'), photos: CLAIM_PHOTOS }

  it('photos are added until the claim is settled, with files.upload; removed from a draft with files.delete', () => {
    expect(photoAddHeld(draftClaim, canFor('buyer'))).toBeNull()
    expect(photoAddHeld(sent, canFor('buyer'))).toBeNull()
    expect(photoAddHeld({ ...sent, status: 'CLOSED' }, canFor('buyer'))).toEqual({ key: 'photos.held.settled', params: { status: '@statusIn.CLOSED' } })
    expect(photoAddHeld({ ...draftClaim, photos: Array.from({ length: 20 }, () => CLAIM_PHOTOS[0]!) }, canFor('buyer'))).toEqual({ key: 'photos.held.full', params: { max: 20 } })
    expect(photoAddHeld(draftClaim, canFor('readOnly'))).toEqual({ key: 'held.permission', params: { permission: 'purchasing.claims.manage' } })
    expect(photoRemoveHeld(draftClaim, canFor('buyer'))).toEqual({ key: 'held.permission', params: { permission: 'files.delete' } })
    expect(photoRemoveHeld(draftClaim, canFor('owner'))).toBeNull()
    expect(photoRemoveHeld(sent, canFor('owner'))).toEqual({ key: 'photos.held.sent' })
    expect(letterKeepHeld(canFor('readOnly'))).not.toBeNull()
    expect(fileOpenHeld(canFor('buyer'))).toBeNull()
  })

  it('refusals in our words', () => {
    const refusal = (message: string, kind: 'invalid_state' | 'conflict' | 'forbidden' = 'invalid_state') => (kind === 'forbidden' ? new ApiError('forbidden', 403, 'forbidden', message, 'req') : new ApiError('conflict', 409, kind, message, 'req'))
    expect(evidenceRefusal(refusal('Claim CLM-1 is sent; its photos are removed only while it is a draft.'))).toEqual({ key: 'photos.held.sent' })
    expect(evidenceRefusal(refusal('The legal name and VAT number of the company are missing.', 'conflict'))).toEqual({ key: 'letter.refused.letterhead' })
    expect(evidenceRefusal(refusal('No.', 'forbidden'))).toEqual({ key: 'photos.refused.forbidden' })
  })

  it('the calls: a new claim, a letter version, a photo removed with its version — one key each', async () => {
    const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
    const value = claim('CLAIM', 'DRAFT')
    const api: ApiClient = createApiClient({
      baseUrl: 'http://api.test',
      csrfToken: () => 'csrf',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, key: headers.get('idempotency-key') })
        const url = String(input)
        const body = url.includes('/letter') ? { letter: { id: 'g1', version: 1, language: 'it', number: value.number, fileId: 'f1', createdAt: value.createdAt }, made: true } : url.includes('/photos/') ? { file: { id: 'p1' } } : { claim: value }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    await createClaim(api, { kind: 'CLAIM', reasonCode: 'QUALITY', remedy: 'CREDIT', from: { lotId: 'l1' } }, 'k1')
    expect(await makeLetter(api, 'c1', 'k2')).toMatchObject({ made: true, letter: { version: 1 } })
    await removeClaimPhoto(api, 'c1', 'p1', 3, 'k3')
    expect(calls.map((call) => [call.method, call.url, call.key])).toEqual([
      ['POST', 'http://api.test/purchasing/claims', 'k1'],
      ['POST', 'http://api.test/purchasing/claims/c1/letter', 'k2'],
      ['DELETE', 'http://api.test/purchasing/claims/c1/photos/p1?version=3', 'k3'],
    ])
  })
})
