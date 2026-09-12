import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { productPresetTestStore } from '../services/listing-wizard/product-presets-test-store.js'
const runtime = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof productPresetTestStore>, publish: vi.fn() }))
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => runtime.store.db[key as string] }) }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class { isConfigured() { return false } } }))
vi.mock('../services/categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../services/listing-wizard/product-types.service.js', () => ({ ProductTypesService: class {} }))
vi.mock('../services/listing-wizard/schema-parser.service.js', () => ({ SchemaParserService: class {} }))
vi.mock('../services/listing-wizard/telemetry.service.js', () => ({ WIZARD_EVENT_TYPES: [], writeStepTransition: vi.fn(), writeWizardEvent: vi.fn() }))
vi.mock('../services/ebay-category.service.js', () => ({ EbayCategoryService: class {} }))
vi.mock('../services/listing-wizard/channel-publish.service.js', () => ({ ChannelPublishService: class { publishToChannel = runtime.publish } }))
vi.mock('../services/listing-images/image-resolution.service.js', () => ({ ImageResolutionService: class {} }))
vi.mock('../services/ai/listing-content.service.js', () => ({ ListingContentService: class {}, BudgetExceededError: class extends Error {} }))
vi.mock('../services/ai/budget.service.js', () => ({ readBudgetLimits: vi.fn() }))
vi.mock('../services/ai/usage-logger.service.js', () => ({ logUsage: vi.fn() }))
vi.mock('../services/idempotency.service.js', () => ({ idempotencyService: {} }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
import templates from './wizard-templates.routes.js'
import wizardRoutes from './listing-wizard.routes.js'
import { SubmissionService } from '../services/listing-wizard/submission.service.js'
const app = Fastify()
let temporaryPage: string | undefined
beforeAll(async () => {
  runtime.store = productPresetTestStore()
  await app.register(templates, { prefix: '/api' }); await app.register(wizardRoutes, { prefix: '/api' })
  app.get('/api/auth/csrf', async () => ({ csrfToken: 'isolated-fixture' }))
  app.get('/api/auth/me', async () => ({ user: { id: 'owner', displayName: 'Session 2 preset fixture', email: 'fixture@example.test', roleKeys: ['owner'] }, isOwner: true, permissions: ['listings.publish', 'products.view'] }))
  app.get('/api/fixture/evidence', async () => ({ ...runtime.store.data, writes: runtime.store.writes, validation: runtime.store.data.listingWizard.map(w => new SubmissionService(runtime.store.db as any).validateMultiChannel(w as any)) }))
  app.setNotFoundHandler(async request => ({ fixture: true, path: request.url, data: [], items: [], profiles: [], connections: [], alerts: [], count: 0, total: 0 }))
  await app.ready()
})
afterAll(async () => { await app.close(); if (temporaryPage) await unlink(temporaryPage) })
beforeEach(() => { runtime.store = productPresetTestStore(); runtime.publish.mockClear() })
const apply = (payload: object) => app.inject({ method: 'POST', url: '/api/wizard-templates/outerwear/apply', payload })
const resumeQuery = (scope = runtime.store.scope) => new URLSearchParams({ ...scope, listingId: scope.listingId ?? '' }).toString()

it('round-trips review/apply/retry/exact resume and refuses wrong product/account and legacy scope replacement', async () => {
  runtime.store.addDraft({ variations: { includedSkus: ['p1-S'] } })
  const before = structuredClone(runtime.store.data.channelListing)
  const previewResponse = await apply({ productContext: runtime.store.scope, dryRun: true })
  expect(previewResponse.statusCode).toBe(200)
  expect(runtime.store.writes).toEqual([])
  const { preview } = previewResponse.json()
  const body = { productContext: runtime.store.scope, reviewKey: preview.reviewKey, wizardId: preview.wizardId }
  const response = await apply(body)
  expect(response.statusCode).toBe(200)
  const id = response.json().wizard.id
  expect((await apply(body)).json().replayed).toBe(true)
  expect((await app.inject({ url: `/api/listing-wizard/${id}?${resumeQuery()}` })).json().wizard.channelStates['AMAZON:IT'].variations.theme).toBe('SIZE_NAME')
  expect((await app.inject({ url: `/api/listing-wizard/${id}?${resumeQuery({ ...runtime.store.scope, productId: 'p2' })}` })).statusCode).toBe(409)
  expect((await app.inject({ url: `/api/listing-wizard/${id}?${resumeQuery({ ...runtime.store.scope, accountId: 'account-b' })}` })).statusCode).toBe(409)
  expect((await app.inject({ url: `/api/listing-wizard/${id}` })).statusCode).toBe(409)
  expect((await app.inject({ method: 'POST', url: '/api/listing-wizard/start', payload: { productId: 'p1', channel: 'AMAZON', marketplace: 'IT' } })).statusCode).toBe(409)
  expect((await apply({ wizardId: id, dryRun: true })).statusCode).toBe(409)
  for (const payload of [{ state: { productPresetScope: null } }, { channels: [{ platform: 'AMAZON', marketplace: 'FR' }] }, { channelStates: { 'AMAZON:FR': { variations: { theme: 'COLOR_NAME' } } } }]) {
    expect((await app.inject({ method: 'PATCH', url: `/api/listing-wizard/${id}`, payload: { ...payload, expectedUpdatedAt: response.json().wizard.updatedAt } })).statusCode).toBe(409)
  }
  for (const action of ['submit', 'retry', 'schedule-publish']) expect((await app.inject({ method: 'POST', url: `/api/listing-wizard/${id}/${action}`, payload: {} })).statusCode).toBe(409)
  expect(runtime.publish).not.toHaveBeenCalled()
  expect(runtime.store.data.channelListing).toEqual(before)
})
it('requires the reviewed draft revision on later edits and preserves destination through a successful CAS', async () => {
  runtime.store.addDraft()
  const preview = (await apply({ productContext: runtime.store.scope, dryRun: true })).json().preview
  const saved = (await apply({ productContext: runtime.store.scope, reviewKey: preview.reviewKey })).json().wizard
  const writeCount = runtime.store.writes.length
  const patch = (payload: object) => app.inject({ method: 'PATCH', url: `/api/listing-wizard/${saved.id}`, payload })
  expect((await patch({ currentStep: 2 })).statusCode).toBe(409)
  expect((await patch({ currentStep: 2, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' })).statusCode).toBe(409)
  expect(runtime.store.writes).toHaveLength(writeCount)
  const response = await patch({ currentStep: 2, expectedUpdatedAt: saved.updatedAt })
  expect(response.statusCode).toBe(200)
  expect(response.json().wizard.currentStep).toBe(2)
  expect(response.json().wizard.state.productPresetScope).toEqual(runtime.store.scope)
  expect(response.json().wizard.channelStates['AMAZON:IT'].variations.theme).toBe('SIZE_NAME')
  expect(runtime.publish).not.toHaveBeenCalled()
})
it('refuses expired or non-draft bound resumes', async () => {
  runtime.store.addDraft()
  const preview = (await apply({ productContext: runtime.store.scope, dryRun: true })).json().preview
  const saved = (await apply({ productContext: runtime.store.scope, reviewKey: preview.reviewKey })).json().wizard
  const draft = runtime.store.data.listingWizard.find(w => w.id === saved.id)!
  draft.status = 'DISCARDED'
  expect((await app.inject({ url: `/api/listing-wizard/${saved.id}?${resumeQuery()}` })).statusCode).toBe(409)
  draft.status = 'DRAFT'
  draft.expiresAt = new Date('2000-01-01T00:00:00.000Z')
  expect((await app.inject({ url: `/api/listing-wizard/${saved.id}?${resumeQuery()}` })).statusCode).toBe(409)
})
it('does not drop account or alias inputs on legacy start, patch or resume', async () => {
  for (const extra of [{ accountId: 'account-b' }, { aliasKey: 'alias-one' }, { channels: [{ platform: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }] }]) expect((await app.inject({ method: 'POST', url: '/api/listing-wizard/start', payload: { productId: 'p1', channel: 'AMAZON', marketplace: 'IT', ...extra } })).statusCode).toBe(409)
  const draft = runtime.store.addDraft()
  expect((await app.inject({ url: `/api/listing-wizard/${draft.id}?${resumeQuery()}` })).statusCode).toBe(409)
  expect((await app.inject({ method: 'PATCH', url: `/api/listing-wizard/${draft.id}`, payload: { channels: [{ platform: 'AMAZON', marketplace: 'IT', aliasKey: 'alias-one' }] } })).statusCode).toBe(409)
  expect(runtime.store.writes).toEqual([])
})
it('refuses stale apply and rolls back if the wizard CAS fails', async () => {
  runtime.store.addDraft()
  const preview = (await apply({ productContext: runtime.store.scope, dryRun: true })).json().preview
  runtime.store.db.listingWizard.updateMany = async () => ({ count: 0 })
  expect((await apply({ productContext: runtime.store.scope, reviewKey: preview.reviewKey })).statusCode).toBe(409)
  expect(runtime.store.writes).toEqual([])
})

it.skipIf(process.env.NEXUS_SESSION_TWO_PRESETS_BROWSER !== '1')('serves isolated preset browser fixture', async () => {
  runtime.store.addDraft({ variations: { includedSkus: [] } }, { currentStep: 4 })
  runtime.store.data.channelListing = runtime.store.data.channelListing.filter(row => row.id !== 'p2:account-a:FR:primary')
  runtime.store.data.wizardTemplate.push({ ...structuredClone(runtime.store.data.wizardTemplate[0]), id: 'future-skus', name: 'Future Amazon listing SKUs', description: 'Future listing SKU settings for an unlisted destination', channels: [{ platform: 'AMAZON', marketplace: 'FR' }], defaults: { skuStrategy: { parentSku: 'per-marketplace', childSku: 'per-marketplace', fbaFbm: 'suffixed' } } })
  const directory = fileURLToPath(new URL('../../../web/src/app/channels/listing-presets/session-two-fixture/', import.meta.url))
  await mkdir(directory, { recursive: true })
  const page = `${directory}page.tsx`
  // wx refuses an existing page; only the file this fixture created is removed on shutdown.
  await writeFile(page, `'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Field, Listbox } from '@/design-system/components'
import { ProductListingPresets } from '@/app/products/[id]/edit/_studio/presets/ProductListingPresets'
export default function Fixture() {
  const [coordinate, setCoordinate] = useState('p1|account-a|IT|')
  const [theme, setTheme] = useState('light')
  useEffect(() => { const root = document.documentElement; const previous = root.dataset.theme; const wasDark = root.classList.contains('dark'); root.dataset.theme = theme; root.classList.toggle('dark', theme === 'dark'); return () => { root.classList.toggle('dark', wasDark); if (previous) root.dataset.theme = previous; else delete root.dataset.theme } }, [theme])
  const [productId, accountId, market, aliasKey] = coordinate.split('|')
  return <section style={{display:'grid',gap:'var(--nds-space-16)',padding:'var(--nds-space-24)'}}>
    <h1>Isolated product preset fixture</h1>
    <div><Button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>Use {theme === 'light' ? 'dark' : 'light'} theme</Button></div>
    <Field label="Product destination"><Listbox width="auto" value={coordinate} onChange={setCoordinate} options={[
      {value:'p1|account-a|IT|',label:'Alpine · Main store · Italy · Primary'},
      {value:'p2|account-a|IT|',label:'Coastal · Main store · Italy · Primary'},
      {value:'p1|account-b|IT|',label:'Alpine · Second store · Italy · Primary'},
      {value:'p1|account-a|FR|',label:'Alpine · Main store · France · Primary'},
      {value:'p2|account-a|FR|',label:'Coastal · Main store · France · Unlisted'},
      {value:'p1|account-a|IT|alias-one',label:'Alpine · Main store · Italy · Alias'},
    ]} /></Field>
    <div><ProductListingPresets scope={{productId, channel:'AMAZON', accountId, market, aliasKey, listingId:productId === 'p2' && market === 'FR' ? null : productId+':'+accountId+':'+market+':'+(aliasKey || 'primary')}} productLabel={productId === 'p1' ? 'ALPINE · Alpine jacket family' : 'COASTAL · Coastal jacket family'} accountLabel={accountId === 'account-a' ? 'Main store' : 'Second store'} listingLabel={productId === 'p2' && market === 'FR' ? 'Unlisted primary destination' : aliasKey || 'Primary listing'} /></div>
  </section>
}
`, { flag: 'wx' })
  temporaryPage = page
  await app.listen({ host: '127.0.0.1', port: 4102 })
  await writeFile('/tmp/nexus-session-two-presets-fixture-ready.json', JSON.stringify({ pid: process.pid, port: 4102, page }))
  await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
}, 3600000)
