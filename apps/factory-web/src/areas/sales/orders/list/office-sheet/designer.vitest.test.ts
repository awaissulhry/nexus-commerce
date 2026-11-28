import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../../../lib/api/client'
import { giveToDesigner } from './api'
import { CONFIRMED_ROW, DRAFT_ROW, NO_NEWS, PRODUCTION_ROW, SENT_ROW, readRow } from './fixtures'
import { designerPlanOf, orderKeyOf } from './map'

describe('owb-of4 extra step — Give to the designer (bulk on the office sheet)', () => {
  it('takes confirmed orders not with the designer yet; drafts, Sent orders and the ones already with the designer are skipped and counted', () => {
    const withDesigner = readRow({ id: 'order-9', news: { ...NO_NEWS, withDesigner: true } })
    const rows = [DRAFT_ROW, SENT_ROW, CONFIRMED_ROW, PRODUCTION_ROW, withDesigner]
    const plan = designerPlanOf(rows, rows.map(orderKeyOf))
    expect(plan.go.map((row) => row.id)).toEqual(['order-1', 'order-2'])
    expect(plan).toMatchObject({ already: 1, other: 2, tooMany: false })
  })

  it('at most 100 orders at once', () => {
    const rows = Array.from({ length: 101 }, (_, index) => readRow({ id: `order-${index}` }))
    expect(designerPlanOf(rows, rows.map(orderKeyOf)).tooMany).toBe(true)
  })

  it('calls POST /sales/orders/designer with the order ids and the picked person', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = { post: async (path: string, options?: { body?: unknown }) => (calls.push({ path, body: options?.body }), { added: 2 }) } as unknown as ApiClient
    expect(await giveToDesigner(api, { orderIds: ['order-1', 'order-2'], userId: 'user-7' })).toEqual({ added: 2 })
    expect(calls).toEqual([{ path: '/sales/orders/designer', body: { orderIds: ['order-1', 'order-2'], userId: 'user-7' } }])
  })

  it('the act stands in the bulk bar only for orders.manage (with Confirm, Delete the drafts, Restrict)', () => {
    const hook = readFileSync(new URL('./use-office-sheet.ts', import.meta.url), 'utf8')
    expect(hook).toMatch(/\.\.\.\(manage\s*\?\s*\[[\s\S]*id: 'designer'/)
  })
})

describe('owb-of4 step 4 — Incoming on a phone draws cards', () => {
  it('Incoming keeps the list frame’s phone cards on (it never passes cards={null}) and the Confirm door is 48 px there', () => {
    const view = readFileSync(new URL('../../../inquiries/view/InquiriesView.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../../../inquiries/inquiries.css', import.meta.url), 'utf8')
    expect(view).not.toMatch(/cards=\{null\}/)
    expect(css).toMatch(/\.fw-inq-confirm\s*\{\s*min-height:\s*48px/)
  })
})
