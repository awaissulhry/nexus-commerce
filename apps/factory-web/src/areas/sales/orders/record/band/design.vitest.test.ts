import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { ORDER_FLOW_NS } from '../flow-words'
import { SendDesignDoor } from '../view/overview/FlowParts'
import { bandTagsOf, designDueOf, designStateOf, maySendDesign } from './model'

/**
 * owb-of7 step 2 — "Send the design for approval" on the order (Overview's Where it is now + Changes › Customer's agreement): ONE
 * `POST /approvals-out` with the order id (kind ARTWORK, the order's picture as the mockup); the state shows as the band's Design tag
 * (waits / approved / change); drawn only for who may — the designer may not today (shared-asks line of owb-of7). Written, not run.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = (node: ReactElement): string => renderToString(createElement(I18nProvider, { locale: 'en', messages: {} }, node))

describe('owb-of7 step 2: the button calls approvals-out once with the order id', () => {
  it('ONE askApproval: kind ARTWORK, recordType SalesOrder, recordId the order, the picture as its file, sent; nothing while one runs', () => {
    const flow = read('./use-order-flow.ts')
    expect(flow).toContain("askApproval(api, { kind: 'ARTWORK', recordType: 'SalesOrder', recordId: orderId,")
    expect(flow).toContain('fileIds: [pictureFileId], send: true')
    expect(flow).toContain('if (!orderId || !pictureFileId || design.busy || !mayDesign) return')
    expect(flow.match(/askApproval\(/g)?.length).toBe(1)
  })
  it('drawn only for who may (partners.approvals.ask + orders.manage): sales yes, the designer no', () => {
    expect(maySendDesign(['orders.view', 'orders.manage', 'partners.approvals.ask', 'partners.approvals.view'])).toBe(true)
    expect(maySendDesign(['orders.view.own', 'files.read', 'threads.post'])).toBe(false)
    const design = { state: null, may: true, held: null, busy: false, problem: null }
    expect(html(createElement(SendDesignDoor, { design }))).toContain('Send the design for approval')
    expect(html(createElement(SendDesignDoor, { design: { ...design, may: false } }))).toBe('')
    expect(read('../view/overview/WhereCard.tsx')).toContain('<SendDesignDoor design={model.flow.design}')
    expect(read('../changes/view/AgreementSection.tsx')).toContain('<SendDesignDoor design={model.flow.design}')
  })
  it('the state is the latest ARTWORK / PROOF request — the band\'s Design tag', () => {
    expect(designStateOf([{ kind: 'ARTWORK', status: 'APPROVED', createdAt: '2026-11-01T00:00:00Z' }, { kind: 'PROOF', status: 'OPEN', createdAt: '2026-11-20T00:00:00Z' }])).toBe('WAITS')
    expect(designStateOf([{ kind: 'ARTWORK', status: 'REFUSED', createdAt: '2026-11-01T00:00:00Z' }])).toBe('CHANGE')
    expect(designStateOf([{ kind: 'SAMPLE', status: 'OPEN', createdAt: '2026-11-01T00:00:00Z' }])).toBeNull()
    expect(designStateOf([{ kind: 'ARTWORK', status: 'WITHDRAWN', createdAt: '2026-11-01T00:00:00Z' }])).toBeNull()
    expect(bandTagsOf({ life: 'CONFIRMED', design: 'WAITS' })[0]).toMatchObject({ kind: 'DESIGN', key: 'tag.DESIGN_WAITS' })
    expect(read('../view/OrderRecordView.tsx')).toContain('design: model.flow?.design.state ?? null')
    expect(designDueOf('2026-11-28')).toBe('2026-12-05T12:00:00.000Z')
  })
  it('every new word in English and Italian', () => {
    for (const locale of LOCALES) for (const key of ['design.send', 'design.busy', 'design.noPicture', 'design.waits', 'design.failed', 'design.question', 'design.state.WAITS', 'design.state.APPROVED', 'design.state.CHANGE']) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
