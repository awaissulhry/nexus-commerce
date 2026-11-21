import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONFIRMATION_NONE, CONFIRMATION_OUTDATED, CONFIRMATION_SENT } from '../../depth/demo/fixtures'
import { agreementOf, revisionYesOf, sendVersionOf, signedCheckOf } from './agreement'

// F-OC-203 (order CHANGES tab, W2; 10-design §6; L5, L9, L10): the Customer's agreement — one tag and one sentence, their yes and our
// confirmation.

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const change = (revision: number, decision: string, answeredAt: string | null = null) => ({ id: `a${revision}`, revision, customer: { decision, requestId: null, answeredAt } })
const waitingOn = (decision: string, answeredAt: string | null = null) => ({ reapprovalNeededAt: '2026-11-19T10:00:00Z', changes: [change(1, 'ACCEPTED'), change(2, decision, answeredAt)] }) as never

describe('F-OC-203: the one tag and sentence — the first that applies', () => {
  it('cancelled; waiting for our first approval', () => {
    expect(agreementOf({ status: 'CANCELLED', changes: waitingOn('WAITING'), confirmation: CONFIRMATION_SENT })).toEqual({ kind: 'cancelled' })
    expect(agreementOf({ status: 'PENDING_APPROVAL', changes: null, confirmation: CONFIRMATION_NONE })).toEqual({ kind: 'afterApproval' })
  })

  it('the latest revision\'s yes comes before the confirmation: said no, waiting, never asked or expired (L5)', () => {
    expect(agreementOf({ status: 'IN_PRODUCTION', changes: waitingOn('REFUSED', '2026-11-13T09:40:00Z'), confirmation: CONFIRMATION_SENT })).toEqual({ kind: 'saidNo', revision: 2, at: '2026-11-13T09:40:00Z' })
    expect(agreementOf({ status: 'IN_PRODUCTION', changes: waitingOn('WAITING'), confirmation: CONFIRMATION_SENT })).toEqual({ kind: 'waiting', revision: 2, since: '2026-11-19T10:00:00Z' })
    expect(agreementOf({ status: 'IN_PRODUCTION', changes: waitingOn('NOT_ASKED'), confirmation: CONFIRMATION_SENT })).toEqual({ kind: 'notAsked', revision: 2, expired: false })
    expect(agreementOf({ status: 'IN_PRODUCTION', changes: waitingOn('EXPIRED'), confirmation: CONFIRMATION_SENT })).toEqual({ kind: 'notAsked', revision: 2, expired: true })
    // The order waits for no yes: the confirmation says it.
    expect(revisionYesOf({ reapprovalNeededAt: null, changes: [change(2, 'NOT_ASKED')] } as never)).toBeNull()
  })

  it('then our confirmation: send a new one (changed after the one sent), not sent yet, agreed and confirmed; not read: nothing claimed', () => {
    expect(agreementOf({ status: 'IN_PRODUCTION', changes: null, confirmation: { ...CONFIRMATION_OUTDATED, sentAt: '2026-11-04T09:00:00Z', sentVersion: 1 } })).toEqual({ kind: 'sendNew', version: 1 })
    expect(agreementOf({ status: 'IN_PRODUCTION', changes: null, confirmation: CONFIRMATION_NONE })).toEqual({ kind: 'notSent' })
    expect(agreementOf({ status: 'IN_PRODUCTION', changes: null, confirmation: CONFIRMATION_SENT })).toMatchObject({ kind: 'agreed', version: CONFIRMATION_SENT.sentVersion })
    expect(agreementOf({ status: 'IN_PRODUCTION', changes: null, confirmation: null })).toEqual({ kind: 'unknown' })
  })

  it('"Send version N…": the newest when it prints the order as it is, else the one the send makes', () => {
    expect(sendVersionOf({ versions: [{ version: 2 }], upToDate: true } as never)).toBe(2)
    expect(sendVersionOf({ versions: [{ version: 2 }], upToDate: false } as never)).toBe(3)
    expect(sendVersionOf({ versions: [], upToDate: null } as never)).toBe(1)
  })

  it('B-OC-015: the signed PDF in true words — "differs" never stands for "missing"; before the server says, a mismatch is unchecked (neutral)', () => {
    expect(signedCheckOf({ documentMatches: true, documentCheck: 'MATCHES' })).toBe('kept')
    expect(signedCheckOf({ documentMatches: false, documentCheck: 'PDF_MISSING' })).toBe('missing')
    expect(signedCheckOf({ documentMatches: false, documentCheck: 'DIFFERS' })).toBe('differs')
    expect(signedCheckOf({ documentMatches: true })).toBe('kept')
    expect(signedCheckOf({ documentMatches: false })).toBe('unchecked')
  })
})

describe('F-OC-203: the walls and the language — the sources say it', () => {
  it('L10: without the price grain Open, Make and Send are hidden and ONE line says who sends it (never a held button)', () => {
    const card = source('../../confirmation/view/ConfirmationCard.tsx')
    expect(card).toContain('const priced = model.can.price')
    expect(card).toContain('{priced ? (')
    expect(card).toContain("{!priced && <p className=\"fw-pt-quiet\">{t('changesTab.agreement.noPrice')}</p>}")
    expect(card).toContain("{t('changesTab.agreement.send', { version: sendVersionOf(value) })}")
    expect(card).toContain("label: t('changesTab.agreement.makeOnly')")
  })

  it('L9: made and sent in the order\'s language — never the office person\'s screen language', () => {
    const hook = source('../../depth/use-order-depth.ts')
    expect(hook).toContain('makeConfirmation(api, order.id, customerLocaleOf(order)')
    expect(hook).toContain('language: customerLocaleOf(order) /* F-OC-203 (L9) */')
    expect(hook).not.toContain('input.language')
    expect(source('../../depth/view/DepthDialogs.tsx')).toContain("language: order.language === 'en' ? 'en' : 'it'")
  })

  it('L5: "Ask {customer}…" opens the ask window on the revision; the band\'s green "sent" tag is gone; the re-approval banner lands here', () => {
    const section = source('./view/AgreementSection.tsx')
    expect(section).toContain("actions?.depth?.onDialog?.({ kind: 'askRevision', amendmentId: toAsk.amendmentId, revision: toAsk.revision })")
    expect(section).toContain('model.can.manage && model.can.askCustomer ? revisionToAskOf(changes) : null')
    expect(source('../../depth/view/DepthBand.tsx')).not.toContain('confirmation.sentTag')
    expect(source('../view/OrderRecordView.tsx')).toContain("`${tabHref(recordHref, 'changes', search)}#confirmation`")
    expect(source('../../depth/use-order-depth.ts')).toContain('await askRevisedOrder(api, order, now.amendmentId, customerQuestionOf(order, \'\'), { quotes: readsQuotes }, recipient)')
  })
})
