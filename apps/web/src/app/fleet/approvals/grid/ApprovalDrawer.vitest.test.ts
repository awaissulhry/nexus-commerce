/**
 * Approvals grid — the request drawer, rendered (node SSR; build agent D2, 2026-10-05). The DS Drawer portals to <body>,
 * which a server render cannot do, so it is replaced by its content; the detail read is replaced by a fixture.
 *
 * Pins what the person must be able to rely on: the asker's words are plain text (never HTML), a channel answer Nexus
 * cannot see is said to be unknown, a refused approve stays focusable and says why, and a failed run says why up top.
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { QueueDetail, QueueRow } from '@nexus/shared/approval-queue'
import type { PlanDetail } from './planWords'
import type { ApprovalActions } from './contracts'

const fixture: { detail: QueueDetail | null; plan: PlanDetail | null } = { detail: null, plan: null }

vi.mock('@/design-system/components', async (original) => ({
  ...(await original<typeof import('@/design-system/components')>()),
  Drawer: ({ open, title, subtitle, children, footer, className }: { open: boolean; title?: ReactNode; subtitle?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string }) =>
    open ? createElement('div', { 'data-drawer': className }, createElement('h2', null, title), subtitle, children, createElement('footer', null, footer)) : null,
}))
vi.mock('@/lib/workspaces/Link', () => ({
  default: ({ href, children, className }: { href: string; children?: ReactNode; className?: string }) => createElement('a', { href, className }, children),
}))
vi.mock('./useApprovalDetail', () => ({
  NOT_FOUND_WORDS: 'This request no longer exists.',
  useApprovalDetail: () => (fixture.detail
    ? { state: { kind: 'ready', detail: fixture.detail }, detail: fixture.detail, reload: () => undefined }
    : { state: { kind: 'not-found' }, detail: null, reload: () => undefined }),
  usePlanDetail: () => ({ state: fixture.plan ? { kind: 'ready', plan: fixture.plan } : { kind: 'loading' }, reload: () => undefined }),
}))

const { ApprovalDrawer } = await import('./ApprovalDrawer')

const base: QueueRow = {
  id: 'appr_0123456789abcdef',
  toolName: 'set-price',
  title: 'Set master price',
  area: 'pricing',
  state: 'waiting',
  rawStatus: 'pending',
  note: null,
  target: { kind: 'product', id: 'p1', sku: 'TEST-GLOVE-M', name: 'Test glove M', count: 1, href: '/products/p1/edit' },
  channel: 'EBAY',
  market: 'IT',
  changes: [{ label: 'Base price', from: '€50.00', to: '€52.00' }],
  changeCount: 1,
  summary: null,
  asker: { kind: 'claude', label: 'Claude · Test', person: 'Test Person', connection: 'Claude Desktop' },
  decider: null,
  reversibility: 'full',
  reachesOutside: true,
  nexusRecord: false,
  requestedAt: '2026-10-05T08:00:00.000Z',
  expiresAt: '2026-10-06T08:00:00.000Z',
  executeAfter: null,
  decidedAt: null,
  plan: null,
  canApprove: true,
  cannotApproveWhy: null,
  bulkApprovable: true,
  bulkBlockedWhy: null,
  automation: { level: 'ask', max: 'auto', whyWaits: 'Your rule for Set master price: Ask me' },
}

const detailOf = (over: Partial<QueueDetail> = {}): QueueDetail => ({
  ...base,
  allChanges: base.changes,
  items: [],
  editArgs: null,
  askerReason: null,
  operatorNote: null,
  reason: null,
  timeline: [{ at: '2026-10-05T08:00:00.000Z', kind: 'asked', words: 'Claude · Test asked' }],
  channelResult: null,
  change: null,
  canEdit: true,
  ...over,
})

const actions: ApprovalActions = {
  approve: async () => undefined,
  reject: async () => undefined,
  undo: async () => undefined,
  hold: async () => undefined,
  retry: async () => undefined,
  openAutomate: () => undefined,
  refresh: () => undefined,
  busyIds: new Set(),
  errors: new Map(),
  dismissError: () => undefined,
}

const render = (detail: QueueDetail | null, over: Partial<ApprovalActions> = {}, plan: PlanDetail | null = null) => {
  fixture.detail = detail
  fixture.plan = plan
  return renderToStaticMarkup(createElement(ApprovalDrawer, { id: base.id, row: base, actions: { ...actions, ...over }, refreshKey: 0, onClose: () => undefined }))
}

describe('the request drawer', () => {
  it('a waiting request: status, product link, where, why it waits, the verbs, an edit form and the facts', () => {
    const html = render(detailOf({ askerReason: 'Competitors dropped to <b>€51</b>.\nStill above cost.' }))
    expect(html).toContain('data-drawer="fleet-portal')
    expect(html).toContain('Set master price')
    expect(html).toContain('Asked by Claude · Test')
    expect(html).toContain('>Waiting<')
    expect(html).toMatch(/<a href="\/products\/p1\/edit"[^>]*><span[^>]*>TEST-GLOVE-M<\/span><\/a>/)
    expect(html).toContain('eBay IT')
    expect(html).toContain('Reaches a marketplace or a buyer; can be undone')
    expect(html).toContain('Your rule for Set master price: Ask me')
    for (const verb of ['>Approve<', '>Reject…<', '>Automate this kind…<']) expect(html).toContain(verb)
    // Claude's words are plain text: the tag is escaped, never rendered.
    expect(html).toContain('Claude says')
    expect(html).toContain('Competitors dropped to &lt;b&gt;€51&lt;/b&gt;.')
    expect(html).not.toContain('<b>€51</b>')
    // Edit, then approve: the master price starts from the request's own value.
    expect(html).toContain('Change the value, then approve')
    expect(html).toContain('value="52.00"')
    expect(html).toContain('The request now says €52.00.')
    // Footer: the id (short on screen), asked, expires.
    expect(html).toContain('appr_0…cdef')
    expect(html).toContain('Copy the request id')
    expect(html).toContain('Expires')
  })

  it('an approve this person may not give is held (focusable) and says why', () => {
    const html = render(detailOf({ canApprove: false, cannotApproveWhy: 'You may not change prices in this business.' }))
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="[^"]+"[^>]*>Approve<\/button>/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve</)
    expect(html).toContain('You cannot approve this: You may not change prices in this business. You can still reject it.')
  })

  it('a failed run says why up top and offers Retry', () => {
    const html = render(detailOf({ state: 'failed', note: 'Execution failed: the price is below the floor.' }))
    expect(html).toContain('The run failed')
    expect(html).toContain('Execution failed: the price is below the floor.')
    expect(html).toContain('>Retry<')
    expect(html).not.toContain('>Approve<')
  })

  it('a finished change whose channel answer Nexus cannot see never claims success; Undo when it can be undone', () => {
    const html = render(detailOf({
      state: 'done',
      rawStatus: 'executed',
      canEdit: false,
      decider: { kind: 'person', label: 'Test Person' },
      decidedAt: '2026-10-05T08:05:00.000Z',
      timeline: [
        { at: '2026-10-05T08:00:00.000Z', kind: 'asked', words: 'Claude · Test asked' },
        { at: '2026-10-05T08:05:00.000Z', kind: 'ran', words: 'Ran · approved by Test Person' },
      ],
      channelResult: { state: 'unknown', words: 'Nexus cannot see the channel’s answer for this kind of change.' },
      change: { id: 'chg_1', undoable: true, undoneAt: null, whyNotUndoable: null },
    }))
    expect(html).toContain('Done in Nexus')
    expect(html).not.toContain('reached eBay IT')
    expect(html).toContain('Nexus cannot see the channel’s answer')
    expect(html).toContain('Ran · approved by Test Person')
    expect(html).toContain('>Undo this change…<')
    expect(html).toContain('Decided by')
    expect(html).not.toContain('Change the value, then approve')
    expect(html).not.toContain('>Approve<')
  })

  it('a tool without a declared edit value says to ask again; a bulk request lists its items', () => {
    const html = render(detailOf({
      toolName: 'bulk-price-change',
      changeCount: 120,
      items: [
        { sku: 'TEST-A', name: 'Alpha', change: { label: 'Base price', from: '€1.00', to: '€2.00' } },
        { sku: 'TEST-B', name: null, change: { label: 'Base price', from: '€3.00', to: '€4.00' } },
      ],
    }))
    expect(html).toContain('To change it, ask Claude for a new request.')
    expect(html).toContain('Items in this request')
    expect(html).toContain('TEST-A')
    expect(html).toContain('and 118 more')
  })

  it('a request that is gone says so plainly', () => {
    const html = render(null)
    expect(html).toContain('This request no longer exists.')
    expect(html).not.toContain('>Approve<')
  })

  it('a decision in flight locks this row’s verbs, and its error stays until closed', () => {
    const html = render(detailOf(), { busyIds: new Set([base.id]), errors: new Map([[base.id, 'Nexus could not be reached.']]) })
    expect(html).toContain('Working…')
    expect(html).toContain('Nexus could not be reached.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reject…<\/button>/)
  })

  it('a change plan: its kinds, live step counts, and its steps as one list (ticks only while it waits)', () => {
    const step = (n: number, status: string) => ({
      step: n, tool: 'set-price', title: 'Set master price', status, reason: status === 'failed' ? 'Below the floor' : null, changeId: null,
      undoesChangeId: null, outbound: true, preview: { sku: `TEST-${n}`, changes: { 'base price': { from: 1, to: 2 } } },
      // The API's words for the step (approval-queue.service.ts withStepChanges), as a single request's row reads.
      changes: [{ label: 'Base price', from: '€1.00', to: '€2.00' }], changeCount: 1,
    })
    const plan = (status: string, steps: ReturnType<typeof step>[]): PlanDetail => ({
      approvalId: base.id, status, title: 'Reprice gloves', summary: 'Three gloves up by 5%.', planHash: 'h',
      kinds: [{ tool: 'set-price', title: 'Set master price', count: 3, outbound: true, reversibility: 'full' }],
      steps: steps.length, byStatus: {}, list: steps,
    })
    const planRow = { toolName: 'submit-change-plan', title: 'Change plan', target: null, canEdit: false, allChanges: [], changeCount: 3 }

    const running = render(
      detailOf({ ...planRow, state: 'running', rawStatus: 'executing', note: '1 of 3 steps done, 1 failed', plan: { steps: 3, byStatus: { done: 1, failed: 1, pending: 1 } } }),
      {},
      plan('executing', [step(1, 'done'), step(2, 'failed'), step(3, 'pending')]),
    )
    expect(running).toContain('Running · 1 of 3')
    expect(running).toContain('1 of 3 steps done · 1 failed')
    expect(running).toContain('3 × Set master price — reach a marketplace or a buyer; can be undone')
    // Each fact once: the progress bar carries the step count (no "Result" line repeating it), the kinds list carries the
    // kinds (not the plan's summary sentence as well).
    expect(running).not.toContain('>Result<')
    expect(running.match(/steps done/g)).toHaveLength(1)
    expect(running).not.toContain('Three gloves up by 5%.')
    // A step's change in the grid's words, never the preview's raw numbers.
    expect(running).toContain('TEST-1 · Base price: €1.00 → €2.00')
    expect(running).not.toContain('base price: 1 → 2')
    // Rules apply to Claude's single requests only: no "Automate this kind…" on a plan.
    expect(running).not.toContain('Automate this kind')
    expect(running).toMatch(/<ol[^>]*tabindex="0"/)
    expect(running).not.toMatch(/<input[^>]*type="checkbox"/)
    expect(running).toContain('Why it failed: Below the floor')
    expect(running).not.toContain('>Approve')

    const waiting = render(
      detailOf({ ...planRow, state: 'waiting', rawStatus: 'pending', plan: { steps: 3, byStatus: { pending: 3 } } }),
      {},
      plan('pending', [step(1, 'pending'), step(2, 'pending'), step(3, 'pending')]),
    )
    expect(waiting).toContain('>Approve 3 changes<')
    expect(waiting).not.toContain('Automate this kind')
    expect(waiting.match(/<input[^>]*type="checkbox"[^>]*>/g)).toHaveLength(3)
    expect(waiting.match(/<input[^>]*type="checkbox"[^>]*tabindex="0"/g)).toHaveLength(1)
    expect(waiting).not.toContain('Change the value, then approve')
  })
})
