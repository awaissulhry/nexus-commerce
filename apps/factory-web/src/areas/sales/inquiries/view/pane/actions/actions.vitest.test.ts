import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../../../../lib/i18n/messages'
import { canFor, PROSPECT_VIEW, QUOTED_VIEW, VIEW } from '../../../demo/fixtures'
import type { InquiryView } from '../../../api'
import { paneActions, paneHeld } from './model'

/**
 * B-TH-218 (threads plan TH-1b; O-SAL-INQ-LIST.pane-actions; wall W20, W21, W37): ONE main button that follows the request, the
 * other actions held with their reasons, the production manager's held set (B-TH-014), Ask for info only toward the request's own
 * customer (a prospect first becomes one), a closed request's outcome in words. Make order and Make style draft are not drawn
 * until B-TH-025 / 026 (no dead buttons).
 */

const words = CATALOGUE.en['sales-inquiries']!
const owner = canFor('owner')

describe('the actions row (B-TH-218)', () => {
  it('the main button follows the request: something to quote → Make quote; nothing that can go on a quote → Ask for info', () => {
    const row = paneActions(VIEW, owner, false)
    expect(row.main).toBe('quote')
    expect(row.others).toEqual(['askInfo', 'decline'])
    const nothingToQuote: InquiryView = { ...VIEW, lines: [] }
    const ask = paneActions(nothingToQuote, owner, false)
    expect(ask.main).toBe('askInfo')
    expect(ask.others).toEqual(['quote', 'decline'])
    // Only the three actions of today: no Make order, no Make style draft.
    expect([row.main, ...row.others]).toEqual(['quote', 'askInfo', 'decline'])
  })

  it('the production manager sees every action, held "Needs the sales permission" — never hidden', () => {
    const production = canFor('production')
    const row = paneActions(VIEW, production, false)
    expect(row.main).toBe('quote')
    for (const action of ['quote', 'askInfo', 'decline'] as const) expect(row.held[action]).toEqual({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } })
    expect(words['held.right']).toBe('Needs the sales permission ({right})')
    expect(row.menu.every((item) => item.held !== null)).toBe(true)
  })

  it('Ask for info goes only to the request\'s own customer: a prospect is held "Make the customer first" (W20, W21)', () => {
    expect(paneHeld(PROSPECT_VIEW, 'askInfo', owner, false)).toEqual({ key: 'pane.held.prospect' })
    expect(paneActions(PROSPECT_VIEW, owner, false).menu.map((item) => item.id)).toContain('match')
    expect(paneHeld(VIEW, 'askInfo', owner, false)).toBeNull()
    expect(paneHeld(VIEW, 'askInfo', owner, true)).toEqual({ key: 'held.offline' })
    // Without email.send a mail request cannot be asked; a portal request needs no mail.
    const noMail = { ...owner, email: false }
    expect(paneHeld({ ...VIEW, source: 'MAIL' }, 'askInfo', noMail, false)).toEqual({ key: 'held.right', params: { right: 'right.email.send' } })
    expect(paneHeld({ ...VIEW, source: 'PORTAL' }, 'askInfo', noMail, false)).toBeNull()
  })

  it('a closed request shows what it became (the quote with ITS own status), and no buttons', () => {
    const row = paneActions(QUOTED_VIEW, owner, false)
    expect(row.main).toBeNull()
    expect(row.others).toEqual([])
    expect(row.outcome?.key).toMatch(/^pane\.outcome\.quoted/)
  })

  it('Make quote says the quote is a DRAFT and the customer reads "Quote being prepared" (not told yet)', () => {
    expect(words['done.quote']).toContain('as a draft')
    expect(words['done.quote']).toContain('Quote being prepared')
    expect(CATALOGUE.it['sales-inquiries']!['done.quote']).toContain('Preventivo in preparazione')
    expect(words['pane.ask.portal']).toContain('portal')
  })
})
