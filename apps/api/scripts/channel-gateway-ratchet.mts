/**
 * P1.2 (docs/channel-connections/FINAL-PLAN.md, section 5 item 1) — the channel-gateway ratchet.
 *
 * Counts the places that send to a channel WITHOUT the gateway (services/gateway/gateway.ts): a
 * `fetch(`, `https.request(`, `axios…(` or `new SellingPartner(` whose target is eBay, Amazon SP-API,
 * Amazon Ads, Shopify or Etsy. The count per channel may only go down (the method that took the MAP
 * lookups from 60 to 0).
 *
 * Which channel a send belongs to, in this order: a channel host written in the call itself; else the
 * API path written in the call (`/sell/…` is eBay, `/variants.json` Shopify — a file can mix channels);
 * else the channel hosts written anywhere in its file; else the channel named in its file path; else an
 * eBay `apiBase` argument. A send that is not a channel API call — an OAuth token exchange the gateway itself
 * depends on, a pre-signed storage URL — carries `// gateway-exempt: <reason>` on its line or one of
 * the two lines above; it is listed, not counted. An exemption without a reason is counted.
 *
 * Run from apps/api:  npx tsx scripts/channel-gateway-ratchet.mts
 *   --list     every counted and exempt site
 *   --check    exit 1 when a channel's count is above its baseline below (pre-push)
 *
 * READ-ONLY. Parses source files with the TypeScript AST (a regex would count comments and mocks).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import ts from 'typescript'

type Channel = 'EBAY' | 'AMAZON_SP' | 'AMAZON_ADS' | 'SHOPIFY' | 'ETSY'

/**
 * Sends outside the gateway allowed per channel. Lower a number in the same change that moves a path;
 * raising one is a visible diff that has to be justified.
 *
 * 2026-09-19, P1.2a: first count 42 Amazon SP-API sends; Amazon moved (SDK sender, listings client, 18
 * direct sends) → 0, and 22 non-API sends marked exempt with their reason.
 * 2026-09-19, P1.2b: eBay 94 → 0 (ebayFetch, callTradingApi with its account on every caller, 80 direct
 * sends); 11 eBay non-API sends exempt (OAuth, connector identity, one Amazon pre-signed upload).
 * Then the API-path rule found 10 more eBay sends in outbound-sync.service.ts (a file with both eBay and
 * Shopify, counted as Shopify before) — moved; Shopify's true count is 15.
 * 2026-09-19, P1.2c: Shopify 15 → 0 (the account GraphQL client, the env-credential paths as app-level
 * calls, the bulk mutation); 4 exempt (2 staged uploads, the connector heartbeat, the OAuth exchange).
 * 2026-09-19, P1.2d: Amazon Ads 13 → 0 (the Ads client's sender, the debug probe; 11 exempt: report
 * downloads, OAuth, connect-time identity) and Etsy 4 → 0 (the account reader, the legacy writer as
 * app-level; 2 exempt: connector identity). **The burn-down is closed: every channel at 0.** Any increase
 * from here is a regression — which is what a baseline of 0 is for.
 */
const BASELINE: Record<Channel, number> = {
  EBAY: 0,
  AMAZON_SP: 0,
  AMAZON_ADS: 0,
  SHOPIFY: 0,
  ETSY: 0,
}

const HOSTS: Array<[Channel, RegExp]> = [
  ['AMAZON_ADS', /advertising-api(-eu|-fe|-test)?\.amazon\.com/],
  ['AMAZON_SP', /sellingpartnerapi-(na|eu|fe)\.amazon\.com|api\.amazon\.(com|co\.uk|co\.jp)\/auth\/o2/],
  ['EBAY', /(^|[/.])(api|apiz|svcs|open\.api|auth|signin)(\.sandbox)?\.ebay\.com/],
  ['SHOPIFY', /myshopify\.com|\/admin\/api\/20\d\d-\d\d/],
  ['ETSY', /(openapi|api)\.etsy\.com/],
]
/** The API path written in the call itself — decides before the file's hosts (a file can mix channels). */
const API_PATHS: Array<[Channel, RegExp]> = [
  ['EBAY', /\/(sell|commerce|post-order|developer)\/|\/ws\/api\.dll|\/identity\/v1\//],
  ['SHOPIFY', /\/admin\/api\/|\/(variants|products|locations|inventory_levels|inventory_items|orders|fulfillments|webhooks)(\/[^`'"]*)?\.json|graphql\.json/],
  ['AMAZON_ADS', /\/(v2|v3)\/(sp|sb|sd|profiles|portfolios)|\/sp\/(campaigns|adGroups|keywords|targets)|\/reporting\/reports/],
  ['AMAZON_SP', /\/(listings|orders|fba|feeds|reports|catalog|notifications|sellers|finances|aplus|definitions|products|mfn|shipping)\/(v\d|20\d\d)/],
]
const PATH_CHANNEL: Array<[Channel, RegExp]> = [
  ['AMAZON_ADS', /amazon-ads|advertising|(^|\/)ads[-/]/i],
  ['EBAY', /ebay/i],
  ['SHOPIFY', /shopify/i],
  ['ETSY', /etsy/i],
  ['AMAZON_SP', /amazon|sp-api|(^|\/)fba|aplus/i],
]
const EXEMPT = /gateway-exempt:\s*(\S.*)$/

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../src')

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '__tests__' ? [] : files(full)
    return /\.tsx?$/.test(entry.name) && !/\.(vitest\.)?test\.tsx?$|\.d\.ts$/.test(entry.name) ? [full] : []
  })
}

function hostChannels(text: string): Channel[] {
  return HOSTS.filter(([, re]) => re.test(text)).map(([channel]) => channel)
}

export interface Site { file: string; line: number; channel: Channel; send: string; target: string; exempt: string | null }

export function scan(root = SRC): Site[] {
  const sites: Site[] = []
  for (const full of files(root)) {
    const file = path.relative(root, full).replace(/\\/g, '/')
    if (file.startsWith('services/gateway/') || file.startsWith('test-support/')) continue
    const text = fs.readFileSync(full, 'utf8')
    if (!/fetch\(|\.request\(|axios|SellingPartner\(/.test(text)) continue
    const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true)
    const lines = text.split('\n')
    const fileChannels = hostChannels(text)
    const pathChannel = PATH_CHANNEL.find(([, re]) => re.test(file))?.[0] ?? null
    const visit = (node: ts.Node) => {
      let send: string | null = null
      let args: ts.NodeArray<ts.Expression> | undefined
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source)
        if (callee === 'fetch' || callee === 'globalThis.fetch') send = 'fetch'
        else if (/^(https?|node:https?)\.request$|^https?\.(get|request)$/.test(callee)) send = callee
        else if (/^axios(\.(get|post|put|patch|delete|request))?$/.test(callee)) send = callee
        args = node.arguments
      } else if (ts.isNewExpression(node) && node.expression.getText(source) === 'SellingPartner') {
        send = 'new SellingPartner'
        args = node.arguments
      }
      if (send) {
        const target = (args?.[0]?.getText(source) ?? '').replace(/\s+/g, ' ')
        const own = hostChannels(target)
        const byPath = API_PATHS.find(([, re]) => re.test(target))?.[0] ?? null
        const channel: Channel | null = own[0]
          ?? byPath
          ?? (fileChannels.length === 1 ? fileChannels[0] : null)
          ?? (fileChannels.length > 1 ? (pathChannel && fileChannels.includes(pathChannel) ? pathChannel : fileChannels[0]) : null)
          ?? pathChannel
          ?? (/\bapiBase\b/.test(target) ? 'EBAY' : null)
          ?? (send === 'new SellingPartner' ? 'AMAZON_SP' : null)
        if (channel) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
          let exempt: string | null = null
          for (let i = line; i >= Math.max(0, line - 2) && !exempt; i--) exempt = EXEMPT.exec(lines[i])?.[1]?.trim() || null
          sites.push({ file, line: line + 1, channel, send, target: target.slice(0, 90), exempt })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return sites
}

export function counts(sites: Site[]): Record<Channel, number> {
  const out: Record<Channel, number> = { EBAY: 0, AMAZON_SP: 0, AMAZON_ADS: 0, SHOPIFY: 0, ETSY: 0 }
  for (const site of sites) if (!site.exempt) out[site.channel]++
  return out
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
if (isMain) {
  const sites = scan()
  const count = counts(sites)
  if (process.argv.includes('--list')) {
    for (const site of [...sites].sort((a, b) => a.channel.localeCompare(b.channel) || a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log(`${site.exempt ? 'exempt ' : 'OUTSIDE'} ${site.channel.padEnd(10)} ${site.file}:${site.line}  ${site.send}(${site.target})${site.exempt ? `  — ${site.exempt}` : ''}`)
    }
  }
  console.log(`channel sends outside the gateway: ${JSON.stringify(count)} (exempt: ${sites.filter((s) => s.exempt).length})`)
  if (process.argv.includes('--check')) {
    const over = (Object.keys(BASELINE) as Channel[]).filter((channel) => count[channel] > BASELINE[channel])
    if (over.length) {
      console.error(`❌ channel-gateway ratchet: ${over.map((c) => `${c} ${count[c]} > ${BASELINE[c]}`).join(', ')}.`)
      console.error('   A new send to a channel must go through services/gateway/gateway.ts (gatewayCall), or carry')
      console.error('   `// gateway-exempt: <reason>` when it is not a channel API call. Run with --list to see the sites.')
      process.exit(1)
    }
    const under = (Object.keys(BASELINE) as Channel[]).filter((channel) => count[channel] < BASELINE[channel])
    if (under.length) console.log(`   lower the baseline: ${under.map((c) => `${c} ${BASELINE[c]} → ${count[c]}`).join(', ')}`)
  }
}
