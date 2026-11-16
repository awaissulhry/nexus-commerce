import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apiErrorFrom } from '../../../lib/api/errors'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { outsideRefusalOf, sendHeld, type DocumentSendModel } from './model'

/**
 * B-TH-202 (the brand wall, B-TH-004): a document send (quote, purchase order …) refused because an address belongs to another
 * customer or supplier shows the office whose each address is and the recorded tick "Send outside this customer"; Send waits for
 * the tick. The part's words in it and en never name a customer.
 */

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../../messages/${locale}/send.json`, import.meta.url), 'utf8')) as Record<string, any>
const words = { loading: 'loading', busy: 'busy', noRight: 'noRight', noEmail: 'noEmail', cc: (list: string) => `cc ${list}`, sent: 'sent', outside: 'tick first' }
const ready: Pick<DocumentSendModel, 'checks' | 'sending' | 'canSend' | 'recipient' | 'result' | 'outside'> = {
  checks: { status: 'ready', items: [] },
  sending: false,
  canSend: true,
  recipient: { name: BRAND_ALPHA.contact.name, email: BRAND_ALPHA.contact.email },
  result: null,
}

describe('the recipient rule on a document send (B-TH-202)', () => {
  it('reads the refusal: whose each address is, for the office; a blind copy outside is not a tick’s to let through', () => {
    const refused = apiErrorFrom(409, {
      error: {
        code: 'conflict',
        message: 'english',
        issues: [
          { path: 'refusal/OTHER_PARTY', message: 'english' },
          { path: 'body/cc/0', message: `${BRAND_BETA.contact.email} belongs to ${BRAND_BETA.tradeName}.` },
        ],
      },
    })
    expect(outsideRefusalOf(refused)).toEqual({ lines: [`${BRAND_BETA.contact.email} belongs to ${BRAND_BETA.tradeName}.`], hidden: false })
    const hidden = apiErrorFrom(409, { error: { code: 'conflict', message: 'english', issues: [{ path: 'refusal/HIDDEN_OUTSIDE', message: 'english' }] } })
    expect(outsideRefusalOf(hidden)).toEqual({ lines: [], hidden: true })
    expect(outsideRefusalOf(apiErrorFrom(409, { error: { code: 'invalid_state', message: 'x', issues: [] } }))).toBeNull()
    expect(outsideRefusalOf(new Error('boom'))).toBeNull()
  })

  it('holds Send until "Send outside this customer" is ticked, then lets it go', () => {
    expect(sendHeld(ready, [], words)).toBeNull()
    expect(sendHeld({ ...ready, outside: { lines: ['x'], checked: false } }, [], words)).toBe('tick first')
    expect(sendHeld({ ...ready, outside: { lines: ['x'], checked: true } }, [], words)).toBeNull()
    // A copy address that is not one still says so first.
    expect(sendHeld({ ...ready, outside: { lines: ['x'], checked: false } }, ['nope'], words)).toBe('cc nope')
  })

  it('has its words in it and en, and they name no customer', () => {
    for (const locale of ['it', 'en'] as const) {
      const outside = catalogue(locale).outside as Record<string, string>
      expect(Object.keys(outside).sort()).toEqual(['held', 'hidden', 'tick', 'title'])
      for (const text of Object.values(outside)) {
        expect(scanText(text, BRAND_ALPHA)).toEqual([])
        expect(scanText(text, BRAND_BETA)).toEqual([])
      }
    }
    expect(catalogue('en').outside.tick).toBe('Send outside this customer')
    expect(catalogue('it').outside.tick).toBe('Invia fuori da questo cliente')
  })
})
