/** PCO-6 isolated browser proof: real UI/DS, local mock API, no application server or channel. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, expect } from '@playwright/test'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const records = join(repo, 'docs/publish-changes-only/records')
const pushCommand = 'ps -axo pid=,command= | /usr/bin/grep -E "^ *[0-9]+ (/[^ ]*/)?git push|^ *[0-9]+ /bin/bash \\.githooks/pre-push"'
function beforeWrite() {
  try {
    const pushes = execSync(pushCommand, { encoding: 'utf8', shell: '/bin/zsh' })
    if (pushes.trim()) throw new Error(`Refusing to edit while a push runs: ${pushes.trim()}`)
  } catch (error) {
    // grep's empty result is expected; an unreadable process list must fail closed.
    if (error.status !== 1 || error.stderr?.toString().trim()) throw error
  }
}
beforeWrite()
const root = await mkdtemp('/private/tmp/pco6-browser-')
await mkdir(records, { recursive: true })
const files = {
  'index.html': '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PCO-6 isolated QA</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  'auth.ts': 'export const usePermission = () => true',
  'backend.ts': "export const getBackendUrl = () => ''",
  'contracts.ts': `
const canChangeEditor = () => true
const preparePublication = async () => null
const publicationBlocker = () => null
const product = { id: 'pco-demo', sku: 'GALE-JACKET', name: 'Gale motorcycle jacket' }
const state = { kind: 'saved', at: 123 }
const scope = { scope: 'AMAZON', market: 'DE', accountId: 'amazon-one', listingId: 'selected-alias', canChangeEditor,
  marketplaces: [
    { id: 'amazon-de', channel: 'AMAZON', code: 'DE', name: 'Amazon Germany', language: 'de', accounts: [{ id: 'amazon-one', label: 'Nexus Amazon', primary: true }] },
    { id: 'ebay-it', channel: 'EBAY', code: 'IT', name: 'eBay Italy', language: 'it', accounts: [{ id: 'ebay-one', label: 'Nexus eBay', primary: true }] },
  ] }
const save = { state, preparePublication, publicationBlocker }
export const useStudioProduct = () => product
export const usePublicationSave = () => save
export const useStudioScope = () => scope
export const useStudioDiscoveryFailure = () => false
`,
  'main.tsx': `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { PublishMenu } from '@/app/products/[id]/edit/_studio/PublishMenu'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/a11y.css'
const dark = new URLSearchParams(location.search).get('dark') === '1'
if (dark) document.documentElement.classList.add('dark')
createRoot(document.getElementById('root')!).render(<main className={dark ? 'dark' : ''} style={{ padding: 24, minHeight: '100vh' }}>
  <h1>Gale motorcycle jacket</h1><p>GALE-JACKET · Saved</p><PublishMenu />
  <p>Isolated PCO-6 browser verification. Provider calls are mocked.</p>
</main>)
`,
}
files['index.html'] = files['index.html'].replace('</head>', '<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:var(--nds-bg);color:var(--nds-text)}h1{font-size:22px}</style></head>')
for (const [name, content] of Object.entries(files)) { beforeWrite(); await writeFile(join(root, name), content) }

const calls = [], reviews = new Map(), staleSent = new Set()
let nextReview = 0
const longValue = 'Historical unbroken value: ' + 'ContentObservation'.repeat(70)
function reviewFor(scope) {
  const id = `pco-review-${++nextReview}`
  const products = [{ productId: 'pco-demo', sku: 'GALE-JACKET' }, { productId: 'child-a', sku: 'GALE-S' }]
  const field = (id, status, selectable, current, channel) => ({ id, productId: 'pco-demo', sku: 'GALE-JACKET', field: id, label: id === 'title' ? 'Title' : id === 'unknown' ? 'Material' : 'Brand',
    status, selectable, selectedByDefault: false, localChanged: null, channelChanged: null, operation: 'replace',
    current: { state: 'value', value: current }, lastAccepted: { state: 'unknown', reason: 'No accepted publish record' },
    channel: channel === null ? { state: 'unknown', reason: 'The live read was unavailable' } : { state: 'value', value: channel },
    reason: status === 'CANNOT_COMPARE' ? 'Cannot compare because the live read failed.' : status === 'SAME' ? 'This value already matches the channel; nothing will be sent.' : 'No accepted publish record. Choose explicitly before replacing this channel value.' })
  const review = { id, productId: 'pco-demo', scope, accountLabel: 'Nexus test account', aliasLabel: scope.listingId ? 'Selected alias' : 'Primary listing',
    mode: 'live', action: 'update', excluded: 0, issues: [], expiresAt: new Date(Date.now() + 900_000).toISOString(),
    rows: products.map(p => ({ ...p, title: 'Gale jacket', existing: true })),
    changes: [field('title', 'DIFFERS', true, longValue, 'Channel title'), field('unknown', 'CANNOT_COMPARE', false, 'Polyester', null), field('brand', 'SAME', false, 'Nexus', 'Nexus')] }
  reviews.set(id, review)
  return review
}
const server = await createServer({ configFile: false, root, logLevel: 'warn', cacheDir: join(root, '.vite'),
  resolve: { dedupe: ['react', 'react-dom'], alias: [
    { find: '@/lib/auth/AuthProvider', replacement: join(root, 'auth.ts') },
    { find: '@/lib/backend-url', replacement: join(root, 'backend.ts') },
    { find: '@', replacement: join(repo, 'apps/web/src') },
    { find: 'react-dom', replacement: join(repo, 'node_modules/react-dom') },
    { find: 'react', replacement: join(repo, 'node_modules/react') },
  ] }, esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"development"' },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root, repo] } },
  plugins: [
    { name: 'pco6-isolated-contracts', enforce: 'pre', resolveId(source, importer) {
      if ((source === './contracts' || source === '../contracts') && importer?.includes('/edit/_studio/')) return join(root, 'contracts.ts')
    } },
    { name: 'pco6-local-api', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (!url.pathname.startsWith('/api/')) return next()
      const scenario = new URL(req.headers.referer ?? 'http://127.0.0.1').searchParams.get('case') ?? 'success'
      let body = {}; if (req.method !== 'GET') { let input = ''; for await (const part of req) input += part; body = input ? JSON.parse(input) : {} }
      const send = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
      calls.push({ method: req.method, path: url.pathname, body, scenario })
      if (url.pathname.endsWith('/preview')) {
        const review = reviewFor(body)
        return send(scenario === 'legacy' ? { ...review, changes: undefined } : review)
      }
      if (url.pathname.endsWith('/selection')) {
        const id = url.pathname.split('/').at(-2), review = reviews.get(id)
        if (!review || JSON.stringify(body.selectedIds) !== '["title"]') return send({ message: 'Invalid fixture selection' }, 400)
        if (scenario === 'delayed') await new Promise(done => setTimeout(done, 250))
        const selection = { reviewId: id, token: `choice-${calls.length}`, selectedIds: body.selectedIds, fieldCount: 1,
          products: [{ productId: 'pco-demo', sku: 'GALE-JACKET' }],
          payload: { format: 'json', content: JSON.stringify({ messages: [{ sku: 'GALE-JACKET', patches: [{ path: '/attributes/item_name', value: [{ value: longValue, language_tag: 'de_DE' }, { value: 'Preserved Italian title', language_tag: 'it_IT' }] }] }] }, null, 2) } }
        review.selection = selection
        return send(selection)
      }
      if (url.pathname.endsWith('/submit')) {
        const id = url.pathname.split('/').at(-2)
        if (!reviews.has(id)) return send({ message: 'Unknown fixture review' }, 404)
        if (body.selectionToken !== reviews.get(id).selection?.token) return send({ message: 'Wrong selection token' }, 400)
        await new Promise(done => setTimeout(done, 120))
        if (scenario === 'stale' && !staleSent.has(scenario)) { staleSent.add(scenario); return send({ message: 'Saved information changed. Refresh the review before publishing.' }, 409) }
        return send({ id, status: 'VERIFIED', message: 'Mock provider verified the submitted review.', results: [{ sku: 'GALE-JACKET', status: 'VERIFIED', message: 'Local mock only' }] })
      }
      return send({ message: 'Unexpected local API request' }, 404)
    }) } },
  ], optimizeDeps: { include: ['react', 'react-dom/client'] },
})

const report = { fixture: root, checkedAt: new Date().toISOString(), checks: [], screenshots: [], contrasts: [], calls, errors: [], expected409: [], blockedExternal: [] }
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  const base = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  async function open({ width = 1280, dark = false, scenario = 'success' } = {}) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: dark ? 'dark' : 'light' })
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { report.blockedExternal.push(url.href); return route.abort() }
      return route.continue()
    })
    page.on('pageerror', error => report.errors.push({ scenario, message: error.message }))
    page.on('console', message => {
      if (!['error', 'warning'].includes(message.type())) return
      const entry = { scenario, message: message.text() }
      if (scenario === 'stale' && /409/.test(entry.message)) report.expected409.push(entry)
      else report.errors.push(entry)
    })
    page.on('requestfailed', request => report.errors.push({ scenario, message: `${request.url()}: ${request.failure()?.errorText}` }))
    await page.goto(`${base}/?case=${scenario}&dark=${dark ? 1 : 0}`)
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    if (scenario !== 'legacy') await expect(page.getByRole('checkbox', { name: 'Title · GALE-JACKET' })).toBeVisible()
    return page
  }
  const titleChoice = page => page.getByRole('checkbox', { name: 'Title · GALE-JACKET' })
  const reviewButton = page => page.getByRole('button', { name: 'Review selected changes', exact: true })
  const publishButton = page => page.getByRole('button', { name: 'Publish 1 change', exact: true })
  const choose = async page => { await titleChoice(page).focus(); await page.keyboard.press('Space'); await expect(titleChoice(page)).toBeChecked(); await expect(reviewButton(page)).toBeEnabled() }
  const previewSelection = async page => { await reviewButton(page).click(); await expect(publishButton(page)).toBeEnabled(); await expect(page.getByRole('region', { name: 'Selected publication request' })).toBeFocused() }
  const screenshot = async (page, name) => { const path = join(records, `pco6-browser-${name}.png`); beforeWrite(); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path) }

  let page = await open()
  await expect(reviewButton(page)).toBeDisabled()
  await expect(page.getByText('Unknown — The live read was unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Material · GALE-JACKET' })).toBeDisabled()
  const reviewedId = [...reviews.keys()].at(-1)
  await choose(page); await previewSelection(page)
  const firstToken = reviews.get(reviewedId).selection.token
  await titleChoice(page).uncheck()
  await expect(publishButton(page)).toHaveCount(0); await expect(reviewButton(page)).toBeDisabled()
  await choose(page); await previewSelection(page)
  assert.notEqual(reviews.get(reviewedId).selection.token, firstToken)
  await publishButton(page).click({ clickCount: 2, delay: 5 })
  await expect(page.getByText('Publication verified', { exact: true })).toBeVisible()
  const submitted = calls.filter(c => c.path.endsWith('/submit'))
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].path, `/api/products/pco-demo/studio-publication/${reviewedId}/submit`)
  assert.equal(submitted[0].body.selectionToken, reviews.get(reviewedId).selection.token)
  report.checks.push('first publish unchecked; unknown disabled; Space selects; changing choice discards exact preview; one correct-token submit')
  await page.close()

  page = await open({ scenario: 'destination' }); await choose(page); await previewSelection(page)
  const beforeDestination = nextReview
  await page.getByRole('combobox').selectOption({ label: 'eBay Italy · Nexus eBay' })
  await expect(titleChoice(page)).not.toBeChecked(); await expect(reviewButton(page)).toBeDisabled()
  assert.ok(nextReview > beforeDestination)
  report.checks.push('destination change clears field selection and exact preview')
  await page.close()

  page = await open({ scenario: 'delayed' }); await choose(page); await reviewButton(page).click()
  await page.getByRole('combobox').selectOption({ label: 'eBay Italy · Nexus eBay' })
  await expect(titleChoice(page)).not.toBeChecked()
  await page.waitForTimeout(350)
  await expect(publishButton(page)).toHaveCount(0); await expect(reviewButton(page)).toBeDisabled()
  report.checks.push('late selection response cannot enable a replacement destination review')
  await page.close()

  page = await open({ scenario: 'stale' }); await choose(page); await previewSelection(page)
  const beforeStale = nextReview
  await publishButton(page).click(); await page.getByRole('button', { name: 'Refresh review', exact: true }).click()
  await expect(titleChoice(page)).not.toBeChecked(); await expect(reviewButton(page)).toBeDisabled()
  assert.ok(nextReview > beforeStale)
  report.checks.push('stale submit 409 plus refresh discards selected fields and token')
  await page.close()

  page = await open({ scenario: 'legacy' })
  await expect(page.getByText('Field review unavailable', { exact: true })).toBeVisible()
  await expect(reviewButton(page)).toBeDisabled()
  report.checks.push('legacy server response cannot enable whole-family publish')
  await page.close()

  for (const width of [1280, 390]) for (const dark of [false, true]) {
    const name = `${dark ? 'dark' : 'light'}-${width}`
    page = await open({ width, dark, scenario: name })
    await screenshot(page, `${name}-top`)
    const layout = await page.getByRole('dialog').evaluate(dialog => ({
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      dialog: { width: dialog.getBoundingClientRect().width, scroll: dialog.scrollWidth, client: dialog.clientWidth },
      overflowing: [...dialog.querySelectorAll('*')].filter(el => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'hidden')
        .map(el => ({ tag: el.tagName, className: el.className, scroll: el.scrollWidth, client: el.clientWidth })).slice(0, 10),
    }))
    assert.ok(layout.documentWidth <= width, `${name}: document overflow ${JSON.stringify(layout)}`)
    assert.ok(layout.dialog.scroll <= layout.dialog.client + 1, `${name}: dialog overflow ${JSON.stringify(layout)}`)
    assert.deepEqual(layout.overflowing, [], `${name}: descendant horizontal overflow`)
    await choose(page); await previewSelection(page)
    await page.getByText('Exact request to the channel', { exact: true }).click()
    await expect(page.getByLabel('Exact channel request', { exact: true })).toBeVisible()
    const contrast = await page.getByRole('dialog').evaluate(dialog => {
      const rgba = value => { const values = value.match(/[\d.]+/g)?.map(Number); return values?.length >= 3 ? [values[0], values[1], values[2], values[3] ?? 1] : [0, 0, 0, 0] }
      const blend = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1)
      const background = el => { const own = rgba(getComputedStyle(el).backgroundColor); return own[3] === 1 ? own : blend(own, el.parentElement ? background(el.parentElement) : [255, 255, 255, 1]) }
      const luminance = color => color.slice(0, 3).map(c => { const s = c / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4 }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0)
      return [...dialog.querySelectorAll('p,strong,dt,dd,label,span,button,select')].filter(el => el.getClientRects().length && !el.closest(':disabled') && [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())).map(el => {
        const bg = background(el), fg = blend(rgba(getComputedStyle(el).color), bg), a = luminance(fg), b = luminance(bg)
        return { text: el.textContent.trim().slice(0, 80), ratio: Math.round((Math.max(a, b) + .05) / (Math.min(a, b) + .05) * 100) / 100 }
      })
    })
    const failing = contrast.filter(sample => sample.ratio < 6.98)
    report.contrasts.push({ name, samples: contrast.length, minimum: Math.min(...contrast.map(sample => sample.ratio)), failing })
    assert.deepEqual(failing, [], `${name}: text contrast below 7:1`)
    await screenshot(page, `${name}-selection`)
    // All tabs stay inside the modal; Shift+Tab from its first control wraps to its last.
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button').first().focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await dialog.evaluate(el => {
      const controls = [...el.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(e => e.tabIndex >= 0 && !e.matches(':disabled') && !e.closest('[inert],[hidden]') && e.getClientRects().length)
      return document.activeElement === controls.at(-1)
    }), true, `${name}: reverse tab wrap`)
    for (let i = 0; i < 16; i++) { await page.keyboard.press('Tab'); assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, `${name}: focus escaped`) }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeFocused()
    report.checks.push(`${name}: long values wrap, contrast ≥7:1, field Space/Tab trap/Escape and opener focus restore`)
    await page.close()
  }
  assert.deepEqual(report.blockedExternal, [], 'Unexpected non-local request attempted')
  assert.deepEqual(report.errors, [], 'Unexpected browser console or network errors')
  report.ok = true
} catch (error) {
  report.ok = false
  report.failure = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
  beforeWrite()
  const output = join(records, 'pco6-browser.json')
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks, contrasts: report.contrasts, errors: report.errors,
    expected409: report.expected409.length, blockedExternal: report.blockedExternal, failure: report.failure, record: output, screenshots: report.screenshots }, null, 2))
}
