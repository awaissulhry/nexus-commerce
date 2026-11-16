import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INBOX_PROBLEMS, INBOX_STATUSES, inboxTouched, type InboxList } from './api'
import { dismissHeld, fileHeld, inboxAbilitiesOf, inboxShown, INBOX_ROWS, reasonProblem, statusOfInboxRows } from './model'

// B-W2b-GB02: the SDI inbox, pure, and its words in both languages.

const words = (lang: string) => JSON.parse(readFileSync(new URL(`../../../../../messages/${lang}/payables-inbox.json`, import.meta.url), 'utf8'))
const list = (items: number, dismissed = 0): InboxList => ({ items: Array.from({ length: items }, () => ({}) as never), nextCursor: null, counts: { open: items, dismissed } })

describe('the SDI inbox', () => {
  it('shows the waiting deliveries by default, and is not drawn while nothing ever waited', () => {
    expect(INBOX_ROWS.map(statusOfInboxRows)).toEqual(['OPEN', 'DISMISSED', 'RECORDED', null])
    expect(inboxShown(list(0), 'open', null)).toBe(false)
    expect(inboxShown(null, 'open', null)).toBe(false)
    expect(inboxShown(list(2), 'open', null)).toBe(true)
    expect(inboxShown(list(0, 1), 'open', null)).toBe(true)
    expect(inboxShown(list(0), 'recorded', null)).toBe(true)
    expect(inboxShown(null, 'open', 'problem.read.unavailable')).toBe(true)
  })

  it('holds Dismiss and Open the file with why', () => {
    const finance = inboxAbilitiesOf(['payables.view', 'payables.manage', 'files.read'])
    const reader = inboxAbilitiesOf(['payables.view'])
    expect(dismissHeld({ status: 'OPEN' }, finance, false)).toBeNull()
    expect(dismissHeld({ status: 'OPEN' }, reader, false)).toEqual({ key: 'held.noManage' })
    expect(dismissHeld({ status: 'OPEN' }, finance, true)).toEqual({ key: 'held.busy' })
    expect(dismissHeld({ status: 'RECORDED' }, finance, false)).toEqual({ key: 'held.recorded' })
    expect(dismissHeld({ status: 'DISMISSED' }, finance, false)).toEqual({ key: 'held.dismissed' })
    expect(fileHeld({ xmlFileId: 'f1' }, finance)).toBeNull()
    expect(fileHeld({ xmlFileId: null }, finance)).toEqual({ key: 'held.noFile' })
    expect(fileHeld({ xmlFileId: 'f1' }, reader)).toEqual({ key: 'held.noFiles' })
  })

  it('takes a dismissal reason of 1 to 500 characters, and reads again on its live events', () => {
    expect(reasonProblem('  ')).toEqual({ key: 'dismiss.reasonEmpty' })
    expect(reasonProblem('x'.repeat(501))).toEqual({ key: 'dismiss.reasonLong', params: { max: 500 } })
    expect(reasonProblem('Consegna di prova')).toBeNull()
    expect(inboxTouched({ type: 'sdi_inbox_item.dismissed' })).toBe(true)
    expect(inboxTouched({ type: 'supplier_invoice.sdi_picked_up' })).toBe(true)
    expect(inboxTouched({ type: 'invoice.issued' })).toBe(false)
  })

  it('says every problem, state and row in Italian and English', () => {
    for (const lang of ['it', 'en']) {
      const w = words(lang)
      for (const problem of INBOX_PROBLEMS) expect(w.problem[problem], `${lang} ${problem}`).toBeTruthy()
      for (const status of INBOX_STATUSES) expect(w.status[status], `${lang} ${status}`).toBeTruthy()
      for (const rows of INBOX_ROWS) {
        expect(w.rows[rows], `${lang} ${rows}`).toBeTruthy()
        expect(w.empty[rows], `${lang} empty ${rows}`).toBeTruthy()
      }
    }
  })
})
