import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client'
import { ApiError } from '../../api/errors'
import { LOCALES } from '../../i18n/locales'
import { createTranslator, messagesFor } from '../../i18n/messages'
import { render, textOf } from '../parts/testing'
import { actHeld, blockRefOf, orderFileActsOf, orderSectionsOf, visibilityOf, visibilityTo, type ActItem, type FileActsState, type FileActWindow, type OrderFile, type OrderFilesMay, type OrderFilesRead } from './model'
import { OrderFilesBody } from './view/FilesView'
import { FileActWindows } from './view/FileActWindows'
import { deleteDocument, renameFile, setVisibility } from '../../../areas/_shared/record-thread/file-acts-api'
import { actProblemOf } from '../../../areas/_shared/record-thread/use-file-acts'

/**
 * F-OF-301 … F-OF-304 (order FILES tab W3): the acts on the order's own files — which act per file and right (the card's ⋯, ≤ 3 visible
 * buttons on a card), the windows' rules (Who can see…, Rename…, Delete…, New version…, Mark as priced?), the commands they send, the
 * refusals in words, the one extraction (the dock and the order page act through use-file-acts; Versions… mounted once on the order page).
 * Fake data only.
 */

// The DS Modal draws in place here (no portal on the server).
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

const ORDER = { id: 'so-seed-2', number: 'SEED-SO-0002' }
const OWNER: OrderFilesMay = { upload: true, delete: true, share: true, ask: true, askCustomer: true }
const SALES: OrderFilesMay = { upload: true, delete: false, share: false, ask: true, askCustomer: false }
const file = (id: string, over: Partial<OrderFile> = {}): OrderFile => ({
  id,
  name: `${id}.pdf`,
  kind: 'DOCUMENT',
  category: null,
  contentType: 'application/pdf',
  sizeBytes: 2048,
  versionNo: 2,
  at: '2026-11-20T10:00:00Z',
  from: { type: 'SalesOrder', id: ORDER.id, label: ORDER.number },
  line: null,
  audience: 'OFFICE_ONLY',
  bodyData: false,
  alsoOn: [],
  alsoOnOther: 0,
  inThread: null,
  version: 4,
  versions: 2,
  ...over,
})
const NOW = Date.parse('2026-11-22T10:00:00Z')
const actsOf = (one: OrderFile, may: OrderFilesMay | undefined = OWNER, readOnly = false, versions = true) => orderFileActsOf(one, { orderId: ORDER.id, may, readOnly, now: NOW, versions })
const named = (list: ReturnType<typeof orderFileActsOf>) => list.map((one) => one.act)
const heldOf = (list: ReturnType<typeof orderFileActsOf>, act: string) => list.find((one) => one.act === act)?.held

describe('F-OF-302 — the card’s ⋯: which act per file and right, held with words by state', () => {
  it('the Owner on an own file: New version… · Versions… · Who can see… · Mark as priced · Rename… · Use on another record… · Delete…', () => {
    expect(named(actsOf(file('spec')))).toEqual(['newVersion', 'versions', 'whoCanSee', 'markPriced', 'rename', 'useOn', 'delete'])
    // A line's file is the order's own too (L7); a work order's photo acts on its own page (no act here).
    expect(named(actsOf(file('logo', { from: { type: 'SalesOrderLine', id: 'line-1', label: 'SEED-SO-0002 · 1' } })))).toContain('whoCanSee')
    expect(actsOf(file('photo', { from: { type: 'WorkOrder', id: 'wo-41', label: 'WO-0041' } }))).toEqual([])
  })

  it('a right missing hides its act; Read-only keeps Versions… only (L3); one version only: no Versions…; no depth here: no Versions…', () => {
    expect(named(actsOf(file('spec'), SALES))).toEqual(['newVersion', 'versions', 'markPriced', 'rename', 'useOn'])
    expect(named(actsOf(file('spec'), OWNER, true))).toEqual(['versions'])
    expect(named(actsOf(file('spec', { versions: 1 })))).not.toContain('versions')
    expect(named(actsOf(file('spec'), OWNER, false, false))).not.toContain('versions')
    expect(actsOf(file('spec'), undefined)).toEqual([{ act: 'versions', held: null }])
  })

  it('before the read gives a version (S3), no act that writes is offered — never a held door for a missing fact', () => {
    expect(named(actsOf(file('spec', { version: undefined })))).toEqual(['versions'])
  })

  it('a priced file: Take the price mark off; a paper born priced keeps its mark (held with words, never run)', () => {
    expect(named(actsOf(file('po', { priced: true })))).toContain('unmarkPriced')
    expect(heldOf(actsOf(file('po', { priced: true })), 'unmarkPriced')).toBeNull()
    expect(heldOf(actsOf(file('conf', { priced: true, bornPriced: true, made: 'GENERATED' })), 'unmarkPriced')).toBe('acts.held.bornPriced')
  })

  it('held by state: a fiscal copy, a paper Nexus made, a legal hold, kept until a later day; body data never travels', () => {
    const fiscal = actsOf(file('xml', { fiscal: true }))
    expect([heldOf(fiscal, 'newVersion'), heldOf(fiscal, 'rename'), heldOf(fiscal, 'delete')]).toEqual(['acts.held.fiscal', 'acts.held.fiscalName', 'acts.held.fiscal'])
    const made = actsOf(file('conf', { made: 'GENERATED' }))
    expect([heldOf(made, 'newVersion'), heldOf(made, 'rename'), heldOf(made, 'delete')]).toEqual(['acts.held.madeVersion', 'acts.held.madeName', 'acts.held.madeDelete'])
    expect(heldOf(actsOf(file('spec', { kept: { legalHold: true, retainUntil: null } })), 'delete')).toBe('keep.legalHold')
    const kept = actsOf(file('spec', { kept: { legalHold: false, retainUntil: '2036-12-31T00:00:00Z' } })).find((one) => one.act === 'delete')
    expect(kept).toEqual({ act: 'delete', held: 'acts.held.kept', params: { date: '2036-12-31T00:00:00Z' } })
    expect(heldOf(actsOf(file('spec', { kept: { legalHold: false, retainUntil: '2020-01-01T00:00:00Z' } })), 'delete')).toBeNull()
    expect(named(actsOf(file('sheet', { bodyData: true })))).not.toContain('useOn')
  })

  it('the card shows at most 3 buttons: Download and ⋯ (Open in the conversation moved into the ⋯); the customer’s face has no ⋯', () => {
    const read: OrderFilesRead = { order: ORDER, groups: [{ key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [file('spec', { inThread: { messageId: 'm1' } })], leftOut: 0, measurementsLeftOut: 0 }], total: 1, truncated: false }
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view']!)
      const html = render(createElement(OrderFilesBody, { model: { read, problem: null, selected: [], canShare: true, may: OWNER, versionsHere: true }, party: { name: 'Seed Customer One' }, actions: { onOrderMessage: () => undefined } }), locale)
      const at = html.indexOf('fw-rtv-card-actions')
      const actions = html.slice(at, html.indexOf('</li>', at))
      expect((actions.match(/<button/g) ?? []).length, locale).toBeLessThanOrEqual(3)
      expect(html).toContain(`aria-label="${t('acts.menu.label', { name: 'spec.pdf' })}"`)
      expect(textOf(html)).not.toContain(t('order.inThread'))
      const portal = render(createElement(OrderFilesBody, { model: { read, problem: null, selected: [], canShare: false, face: 'customer' }, party: null, actions: { onOrderMessage: () => undefined } }), locale)
      expect(portal).not.toContain(t('acts.menu.label', { name: 'spec.pdf' }))
    }
  })
})

describe('F-OF-101 (S3 from.shipment) — a DDT’s papers inside the shipment they travel with', () => {
  it('one block per shipment: the DDT joins it, its door opens the shipment; an annulled DDT folds under it', () => {
    const ship = { type: 'Shipment', id: 'sh-1', label: 'SEED-SH-0001' }
    const pod = file('pod', { from: ship, made: 'POD' })
    const ddt = file('ddt', { from: { type: 'Ddt', id: 'ddt-1', label: 'DDT 12', shipment: { id: 'sh-1', label: 'SEED-SH-0001' } } })
    const old = file('ddt-old', { from: { type: 'Ddt', id: 'ddt-0', label: 'DDT 11', state: 'ANNULLED', shipment: { id: 'sh-1', label: 'SEED-SH-0001' } } })
    expect(blockRefOf(ddt)).toEqual(ship)
    const read: OrderFilesRead = { order: ORDER, groups: [{ key: 'SHIPMENTS', words: { en: 'Shipments & invoices', it: 'Spedizioni e fatture' }, files: [ddt, pod, old], leftOut: 0, measurementsLeftOut: 0 }], total: 3, truncated: false }
    const shipments = orderSectionsOf(read).find((section) => section.key === 'SHIPMENTS')!
    expect(shipments.blocks).toHaveLength(1)
    expect(shipments.blocks[0]!.head?.door).toEqual(ship)
    expect(shipments.blocks[0]!.files.map((one) => one.id)).toEqual(['ddt', 'pod'])
    expect(shipments.blocks[0]!.older.map((one) => one.id)).toEqual(['ddt-old'])
  })
})

describe('F-OF-303 — the windows: what holds their act, who sees a file after it, the commands they send', () => {
  const item = (over: Partial<ActItem> = {}): ActItem => ({ id: 'f1', name: 'Size spec.pdf', version: 4, visibility: ['OFFICE'], versions: 5, versionNo: 5, ...over })

  it('Who can see: shares with the customer keeping a floor or a link; takes it back keeping the rest; nothing to change holds it', () => {
    expect(visibilityTo(['OFFICE', 'FLOOR'], 'CUSTOMER')).toEqual(['OFFICE', 'FLOOR', 'PARTNER'])
    expect(visibilityTo(['OFFICE', 'FLOOR', 'PARTNER', 'LINK'], 'OFFICE')).toEqual(['OFFICE', 'FLOOR', 'LINK'])
    expect(visibilityOf({ audience: 'OFFICE_ONLY', audiences: ['CUSTOMER', 'FLOOR'] })).toEqual(['OFFICE', 'PARTNER', 'FLOOR'])
    expect(visibilityOf({ audience: 'CUSTOMER_CAN_SEE' })).toEqual(['OFFICE', 'PARTNER'])
    expect(actHeld({ kind: 'whoCanSee', items: [item()], to: 'OFFICE' })).toBe('acts.held.noChange')
    expect(actHeld({ kind: 'whoCanSee', items: [item()], to: 'CUSTOMER' })).toBeNull()
    expect(actHeld({ kind: 'whoCanSee', items: [item({ visibility: ['OFFICE', 'PARTNER'] })], to: 'OFFICE' })).toBeNull()
  })

  it('Delete needs a why (3 to 500); Rename a new name; New version one file; Mark as priced asks nothing more', () => {
    expect(actHeld({ kind: 'delete', items: [item()], reason: ' no ' })).toBe('acts.held.why')
    expect(actHeld({ kind: 'delete', items: [item()], reason: 'Wrong file' })).toBeNull()
    expect(actHeld({ kind: 'delete', items: [item()], reason: 'x'.repeat(501) })).toBe('acts.held.why')
    expect(actHeld({ kind: 'rename', items: [item()], name: 'Size spec.pdf' })).toBe('acts.held.sameName')
    expect(actHeld({ kind: 'rename', items: [item()], name: '  ' })).toBe('acts.held.sameName')
    expect(actHeld({ kind: 'rename', items: [item()], name: 'Size spec v5.pdf' })).toBeNull()
    expect(actHeld({ kind: 'newVersion', items: [item()], file: null, keepName: true })).toBe('acts.held.oneFile')
    expect(actHeld({ kind: 'newVersion', items: [item()], file: { name: 'spec.pdf', sizeBytes: 10 }, keepName: true })).toBeNull()
    expect(actHeld({ kind: 'priced', items: [item()], priced: true })).toBeNull()
  })

  it('each window in both languages: its title, What happens · the customer · what never changes, no key on screen', () => {
    const state = (window: FileActWindow): FileActsState => ({ window, busy: false, problem: null, notice: null, party: 'Seed Customer One' })
    const windows: FileActWindow[] = [
      { kind: 'whoCanSee', items: [item({ visibility: ['OFFICE', 'FLOOR'] })], to: 'CUSTOMER' },
      { kind: 'whoCanSee', items: [item(), item({ id: 'f2', name: 'Logo.png' })], to: 'CUSTOMER' },
      { kind: 'rename', items: [item()], name: 'Size spec v5.pdf' },
      { kind: 'delete', items: [item()], reason: '' },
      { kind: 'delete', items: [item(), item({ id: 'f2', name: 'Logo.png', versions: 1 })], reason: 'Wrong files' },
      { kind: 'newVersion', items: [item()], file: { name: 'Size spec v6.pdf', sizeBytes: 2048 }, keepName: true },
      { kind: 'priced', items: [item()], priced: true },
      { kind: 'priced', items: [item()], priced: false },
    ]
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view']!)
      for (const window of windows) {
        const html = render(createElement(FileActWindows, { state: state(window) }), locale)
        expect(html, `${locale} ${window.kind}`).toContain(t('acts.happens'))
        expect(textOf(html), `${locale} ${window.kind}`).not.toMatch(/\bacts\.[a-z]+\.[a-zA-Z]+/)
      }
      const one = textOf(render(createElement(FileActWindows, { state: state(windows[3]!) }), locale))
      expect(one).toContain(t('acts.delete.titleVersions', { name: 'Size spec.pdf', count: 5 }))
      expect(one).toContain(t('acts.delete.warn'))
      expect(one).toContain(t('acts.delete.go', { count: 5 }))
      expect(textOf(render(createElement(FileActWindows, { state: state(windows[0]!) }), locale))).toContain(t('acts.who.floor'))
      expect(textOf(render(createElement(FileActWindows, { state: { ...state(windows[2]!), problem: { key: 'acts.problem.words', params: { detail: 'The name is the same: nothing changes.' } } } }), locale))).toContain('The name is the same: nothing changes.')
    }
    expect(render(createElement(FileActWindows, { state: { window: null, busy: false, problem: null, notice: null, party: null } }))).toBe('')
  })

  it('the commands: delete the whole document and rename at the version, who can see names THIS record’s customer only when shared', async () => {
    const calls: { method: string; path: string; body?: unknown; idempotencyKey?: string }[] = []
    const handler = (method: string) => async (path: string, options: { body?: unknown; schema: { parse: (value: unknown) => unknown }; idempotencyKey?: string }) => {
      calls.push({ method, path, body: options.body, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) })
      return options.schema.parse({ file: { id: 'f 1' } })
    }
    const api = { post: handler('POST'), request: (method: string, path: string, options: never) => handler(method)(path, options) } as unknown as ApiClient
    await deleteDocument(api, 'f 1', { version: 4, reason: 'Wrong file' })
    await renameFile(api, 'f 1', { version: 4, name: 'Size spec v5.pdf' })
    await setVisibility(api, { id: 'f 1', version: 4 }, ['OFFICE', 'PARTNER'], 'party-1')
    await setVisibility(api, { id: 'f 1', version: 5 }, ['OFFICE', 'FLOOR'], 'party-1')
    expect(calls.map((call) => ({ method: call.method, path: call.path, body: call.body }))).toEqual([
      { method: 'POST', path: '/files/f%201/delete-document', body: { version: 4, reason: 'Wrong file' } },
      { method: 'POST', path: '/files/f%201/rename', body: { version: 4, name: 'Size spec v5.pdf' } },
      { method: 'PUT', path: '/files/f%201/visibility', body: { visibility: ['OFFICE', 'PARTNER'], partyId: 'party-1', version: 4 } },
      { method: 'PUT', path: '/files/f%201/visibility', body: { visibility: ['OFFICE', 'FLOOR'], partyId: null, version: 5 } },
    ])
    expect(calls.every((call) => typeof call.idempotencyKey === 'string')).toBe(true)
  })

  it('a refusal in words: changed meanwhile, no right, gone; else the API’s own sentence (a hold, a fiscal copy, a paper Nexus made)', () => {
    expect(actProblemOf(new ApiError('conflict', 409, 'conflict', 'This StoredFile changed since it was read.', null, [{ path: 'version', message: 'The current version is 5.' }]))).toEqual({ key: 'acts.problem.stale' })
    expect(actProblemOf(new ApiError('forbidden', 403, 'forbidden', 'Forbidden'))).toEqual({ key: 'acts.problem.forbidden' })
    expect(actProblemOf(new ApiError('not_found', 404, 'not_found', 'File not found.'))).toEqual({ key: 'acts.problem.notFound' })
    expect(actProblemOf(new ApiError('conflict', 409, 'conflict', 'A legal hold keeps this document: nothing was deleted.'))).toEqual({ key: 'acts.problem.words', params: { detail: 'A legal hold keeps this document: nothing was deleted.' } })
    expect(actProblemOf(new Error('offline'))).toEqual({ key: 'acts.problem.failed' })
  })
})

describe('F-OF-301 — one path per job: the dock and the order page act through use-file-acts; Versions… once on the order page', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const dock = read('../../../areas/_shared/record-thread/DockedOfficeThread.tsx')
  const acts = read('../../../areas/_shared/record-thread/use-file-acts.ts')
  const orderFiles = read('../../../areas/_shared/record-thread/use-order-files.ts')
  const page = read('../../../areas/sales/orders/record/OrderRecord.tsx')
  const view = read('./view/FilesView.tsx')

  it('the dock calls the hook and keeps no copy of the moved handlers', () => {
    expect(dock).toContain('const acts = useFileActs(api, {')
    for (const moved of ['const markPriced', 'const confirmUseOn', 'readUseOnTargets(', 'useFileOn(', 'setFilePriced(', 'restoreVersion(']) expect(dock, moved).not.toContain(moved)
    for (const kept of ['const markPriced = async', 'const bulk = async', 'const openUseOn = ', 'const confirmUseOn = async', 'readUseOnTargets(api, useOnFirst, useOnQuery, controller.signal)']) expect(acts, kept).toContain(kept)
  })

  it('the order page’s container acts through the same hook (no handler copied); the old Share N own path is gone', () => {
    expect(orderFiles).toContain("import { useFileActs } from './use-file-acts'")
    expect(orderFiles).toContain('const fileActs = useFileActs(api, {')
    for (const gone of ['setFilePriced(', 'shareWithParty(', 'listFiles(', 'readUseOnTargets(']) expect(orderFiles, gone).not.toContain(gone)
    expect(view).not.toContain('order.shareOwn')
  })

  it('Versions… (Restore inside) mounted ONCE on the order page; the generic row lost its inline Restore', () => {
    expect(page.match(/useFileDepth\(\{/g)?.length).toBe(1)
    expect(page.match(/<DepthDialogs /g)?.length).toBe(1)
    expect(page).toContain('onVersions: (fileId) => depthOpen.current(fileId),')
    expect(view).not.toContain('onRestore')
    expect(view).not.toContain("t('version.restore')")
  })

  it('the window’s bulk Delete N opens the Delete window (the whole document, with a reason) on every record', () => {
    expect(acts).toContain("if (action === 'remove') return openAct('delete', ids)")
    expect(acts).not.toContain('removeFile(')
    expect(view).toContain('{!model.order && <FileActWindows state={model.acts} actions={actions}')
  })
})

// ---- T (lead 11-22: "one body, exactly the same in every place"): the customer page's docked order window ------------------------------
describe('T — the customer page’s docked order: Versions… in the page’s ONE depth, Who can see… names the customer', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const work = read('../../../areas/sales/customers/record/use-customer-work.ts')
  const page = read('../../../areas/sales/customers/record/CustomerRecord.tsx')

  it('the depth is mounted ONCE in the customer page’s container and drawn once by the page (as on the order page); no handler copied', () => {
    expect(work.match(/useFileDepth\(\{/g)?.length).toBe(1)
    expect(work).toContain('onVersions: (fileId) => depthOpen.current(fileId),')
    expect(work).toContain('depthOpen.current = (fileId) => fileDepth.actions.onOpenVersions?.(fileId)')
    expect(work).toContain('reloadFiles: orderFiles.reload,')
    expect(page.match(/<DepthDialogs /g)?.length).toBe(1)
    expect(page).toContain('<DepthDialogs depth={customerDock.fileDepth.model} actions={customerDock.fileDepth.actions} />')
    for (const copy of ['setFilePriced(', 'useFileActs(', 'restoreVersion(', 'readHistory(', 'shareWithParty(']) expect(work, copy).not.toContain(copy)
  })

  it('the customer’s name reaches the order container (Who can see… offers "Office and {customer}"; files.manage still decides)', () => {
    expect(page).toContain('useCustomerDock(partyId, tab, record.party ? partyName(record.party) : null')
    expect(work).toContain('partyName: customerName,')
    expect(work).toContain("canShare: session.permissions.includes('files.manage'),")
    const item: ActItem = { id: 'f1', name: 'Size spec.pdf', version: 4, visibility: ['OFFICE'], versions: 1, versionNo: 1 }
    const draw = (party: string | null) => textOf(render(createElement(FileActWindows, { state: { window: { kind: 'whoCanSee', items: [item], to: 'OFFICE' }, busy: false, problem: null, notice: null, party } })))
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view']!)
      const shared = t('upload.audience.PARTNER', { party: 'Seed Customer One' })
      expect(textOf(render(createElement(FileActWindows, { state: { window: { kind: 'whoCanSee', items: [item], to: 'OFFICE' }, busy: false, problem: null, notice: null, party: 'Seed Customer One' } }), locale))).toContain(shared)
    }
    expect(draw(null)).not.toContain('Seed Customer One')
    // The body offers Versions… only where the page's depth is (the order page and now the customer page: `versionsHere`).
    const one = file('spec')
    expect(orderFileActsOf(one, { orderId: ORDER.id, may: OWNER, readOnly: false, now: NOW, versions: true }).some((act) => act.act === 'versions')).toBe(true)
    expect(read('../../../areas/_shared/record-thread/use-order-files.ts')).toContain('versionsHere: !!input.onVersions,')
  })
})
