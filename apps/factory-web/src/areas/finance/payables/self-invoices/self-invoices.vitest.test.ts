import { describe, expect, it } from 'vitest'
import { SELF_INVOICE_KINDS as DOMAIN_KINDS } from '@nexus/factory-domain/invoicing/self-invoices/self-invoices'
import { SELF_INVOICE_KINDS } from './api'
import { designScreen } from './fixtures'
import { cancelHeld, createDialogHeld, createHeld, deadlineWords, draftHeld, presetKind, reasonProblem, selfInvoiceAbilitiesOf, stageOf, statusOfRows } from './model'

/** B-W2b-417 — Finance › Payables › Self-invoices: the rules without a browser; made-up data only. */

const FINANCE = selfInvoiceAbilitiesOf(['invoices.view', 'invoices.manage', 'invoices.issue', 'payables.view', 'money.cost'])
const SALES = selfInvoiceAbilitiesOf(['invoices.view', 'money.price'])
const rows = designScreen.cases[0]!.model.section.list.value!.selfInvoices

describe('self-invoices', () => {
  it('reads the kinds and the rows as the API does', () => {
    expect([...SELF_INVOICE_KINDS]).toEqual([...DOMAIN_KINDS])
    expect(statusOfRows('open')).toBe('PENDING')
    expect(statusOfRows('all')).toBeNull()
  })

  it('counts the deadline down in words and says where each stands', () => {
    expect(deadlineWords({ state: 'DUE_SOON', daysLeft: 3 })).toEqual({ key: 'self.deadline.left', params: { count: 3 } })
    expect(deadlineWords({ state: 'LATE', daysLeft: -1 })).toEqual({ key: 'self.deadline.late', params: { count: 1 } })
    expect(deadlineWords({ state: 'OPEN', daysLeft: 0 })).toEqual({ key: 'self.deadline.today' })
    expect(rows.map((row) => stageOf(row).key)).toEqual(['self.stage.toDraft', 'self.stage.toDraft', 'self.stage.draft', 'self.stage.issued'])
  })

  it('holds each verb with why: the rights (a purchase’s amounts are the cost grain), a draft made, issued', () => {
    expect(draftHeld(rows[0]!, FINANCE)).toBeNull()
    expect(draftHeld(rows[2]!, FINANCE)).toEqual({ key: 'self.held.hasDraft' })
    expect(draftHeld(rows[3]!, FINANCE)).toEqual({ key: 'self.held.notPending' })
    expect(draftHeld(rows[0]!, SALES)).toEqual({ key: 'self.held.noManage' })
    expect(draftHeld(rows[0]!, { ...FINANCE, cost: false })).toEqual({ key: 'self.held.noCost' })
    expect(cancelHeld(rows[3]!, FINANCE)).toEqual({ key: 'self.held.issued' })
    expect(cancelHeld(rows[2]!, FINANCE)).toBeNull()
    expect(createHeld(SALES)).toEqual({ key: 'self.held.noManage' })
    const candidates = designScreen.cases[0]!.model.section.candidates.value!
    expect(presetKind(candidates[0]!)).toBe('TD18')
    expect(presetKind(candidates[1]!)).toBeNull()
    expect(createDialogHeld({ candidate: candidates[1]!, kind: null, busy: false })).toEqual({ key: 'self.create.held.kind' })
    expect(reasonProblem('no')).toEqual({ key: 'self.cancelProblem.short' })
  })

  it('covers the states and roles the design names', () => {
    expect(designScreen.screen).toBe('SCR-445')
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['finance', 'in-page', 'create', 'cancel', 'sales', 'empty', 'loading', 'error', 'no-permission']))
  })
})
