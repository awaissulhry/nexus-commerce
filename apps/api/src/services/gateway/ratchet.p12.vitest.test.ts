/**
 * P1.2 — the channel-gateway ratchet (scripts/channel-gateway-ratchet.mts) sees what it must see.
 *
 * Fixture source files in a temporary tree, each with the arm that must count and the arm that must
 * not; then the real tree, whose counts must not be above the committed baseline.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { counts, scan, scanQueueRowCreation } from '../../../scripts/channel-gateway-ratchet.mjs'

const root = mkdtempSync(join(tmpdir(), 'gw-ratchet-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
function write(file: string, text: string) {
  mkdirSync(join(root, file, '..'), { recursive: true })
  writeFileSync(join(root, file), text)
}

describe('P1.2 — the ratchet counts sends to a channel outside the gateway', () => {
  write('services/raw-amazon.ts', "export const a = () => fetch('https://sellingpartnerapi-eu.amazon.com/orders/v0/orders')\n")
  write('services/raw-ebay-apibase.ts', 'export const b = (apiBase: string) => fetch(`${apiBase}/sell/inventory/v1/offer`)\n')
  write('services/shopify-thing.ts', 'export const c = (url: string) => fetch(url)\n')
  write('services/ads/report.ts', 'export const d = (u: string) => fetch(u)\n')
  write('services/exempt.ts', "// gateway-exempt: OAuth token exchange\nexport const e = () => fetch('https://api.amazon.com/auth/o2/token')\n")
  write('services/no-reason.ts', "// gateway-exempt:\nexport const f = () => fetch('https://api.ebay.com/identity/v1/oauth2/token')\n")
  write('services/gateway/inside.ts', "export const g = () => fetch('https://api.ebay.com/sell/inventory/v1/offer')\n")
  write('services/not-a-channel.ts', "export const h = () => fetch('https://api.openai.com/v1/embeddings')\n")
  write('services/comment-only.ts', "// fetch('https://api.ebay.com/sell/inventory/v1/offer')\nexport const i = 1\n")
  write('services/raw-ebay.vitest.test.ts', "fetch('https://api.ebay.com/sell/inventory/v1/offer')\n")
  write('services/sdk.ts', "import { SellingPartner } from 'amazon-sp-api'\nexport const j = () => new SellingPartner({})\n")
  // A file that mixes channels: the API path in each call decides (outbound-sync.service.ts has both).
  write('services/mixed-sync.ts', "const shop = 'https://x.myshopify.com'\nexport const m1 = (apiBase: string) => fetch(`${apiBase}/sell/inventory/v1/offer`)\nexport const m2 = (apiBase: string) => fetch(`${apiBase}/variants.json?sku=1`)\n")
  write('services/https.ts', "import https from 'node:https'\nexport const k = () => https.request('https://advertising-api-eu.amazon.com/v2/profiles')\n")

  const sites = scan(root)
  const where = (file: string) => sites.filter((s) => s.file === file)

  it('counts a raw send by its host, its file path, or an eBay apiBase', () => {
    expect(where('services/raw-amazon.ts')).toEqual([expect.objectContaining({ channel: 'AMAZON_SP', exempt: null })])
    expect(where('services/raw-ebay-apibase.ts')).toEqual([expect.objectContaining({ channel: 'EBAY' })])
    expect(where('services/shopify-thing.ts')).toEqual([expect.objectContaining({ channel: 'SHOPIFY' })])
    expect(where('services/ads/report.ts')).toEqual([expect.objectContaining({ channel: 'AMAZON_ADS' })])
    expect(where('services/sdk.ts')).toEqual([expect.objectContaining({ channel: 'AMAZON_SP', send: 'new SellingPartner' })])
    expect(where('services/https.ts')).toEqual([expect.objectContaining({ channel: 'AMAZON_ADS' })])
  })
  it('a file that mixes channels: each call counts for the channel its API path names', () => {
    expect(where('services/mixed-sync.ts').map((s) => s.channel)).toEqual(['EBAY', 'SHOPIFY'])
  })
  it('lists an exemption WITH a reason, and counts one without', () => {
    expect(where('services/exempt.ts')).toEqual([expect.objectContaining({ exempt: 'OAuth token exchange' })])
    expect(where('services/no-reason.ts')).toEqual([expect.objectContaining({ channel: 'EBAY', exempt: null })])
  })
  it('does not count the gateway itself, other services, comments or tests', () => {
    for (const file of ['services/gateway/inside.ts', 'services/not-a-channel.ts', 'services/comment-only.ts', 'services/raw-ebay.vitest.test.ts']) expect(where(file)).toEqual([])
  })
  it('the counts are per channel, exemptions left out', () => {
    expect(counts(sites)).toEqual({ EBAY: 3, AMAZON_SP: 2, AMAZON_ADS: 2, SHOPIFY: 2, ETSY: 0 })
  })
})

describe('P1.3 — queue rows are created only by the one creation module', () => {
  write('services/direct-queue.ts', "export const q = (tx: any) => tx.outboundSyncQueue.createMany({ data: [] })\nexport const r = (prisma: any) => prisma.outboundSyncQueue.update({ where: {} })\n")
  write('services/outbound-rows.ts', "export const home = (db: any) => db.outboundSyncQueue.create({ data: {} })\n")
  it('counts a direct create / createMany anywhere else, not an update, not the module itself', () => {
    const found = scanQueueRowCreation(root)
    expect(found.map((f) => `${f.file} ${f.call}`)).toEqual(['services/direct-queue.ts outboundSyncQueue.createMany'])
  })
})

describe('P1.2 — the real tree is at or below the baseline', () => {
  it('--check passes', () => {
    const api = fileURLToPath(new URL('../../../', import.meta.url))
    const out = execFileSync('npx', ['tsx', 'scripts/channel-gateway-ratchet.mts', '--check'], { cwd: api, encoding: 'utf8' })
    expect(out).toMatch(/channel sends outside the gateway: \{"EBAY":\d+,"AMAZON_SP":0,/)
    expect(out).toMatch(/queue rows created outside services\/outbound-rows\.ts: 0/)
  }, 60_000)
})
