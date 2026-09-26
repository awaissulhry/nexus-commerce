/**
 * CHMAP M5 — the anonymiser behind `scripts/chmap-anonymise.mts` and `scripts/chmap-golden-build.mts`.
 * See the CLI script for what is replaced and why. Returns the anonymised bytes, the replacement map (original →
 * fake, shared across calls so parent/child links survive between files) and the scan's leaks (must be empty).
 */
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { parse as parseCsv } from 'csv-parse/sync'


/** Words that name the Owner's business or people, and hosts that serve its files. Whole words only (`regalo` stays). */
const PRIVATE_WORDS = /\b(?:www\.)?xaviaracing(?:\.it)?\b|\bxavia(?:\s+racing)?\b|\b(?:airmesh|aireon|misano|ventra|gale|moss|regal|awais|sulhry|riccione)\b/gi
const PRIVATE_URL = /https?:\/\/[^\s"'<>]*(?:shopify|cloudinary|media-amazon|xavia)[^\s"'<>]*/gi
export const scrubText = (text: string) => text.replace(PRIVATE_URL, 'https://example.test/fixture').replace(PRIVATE_WORDS, 'FIXTURE')
/** The broad scan: any private word or host left in any part of the zip (text, attributes, rels, docProps). */
export async function broadScan(bytes: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  const found: string[] = []
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.(xml|rels|vml)$/.test(name)) continue
    const text = await zip.file(name)!.async('string')
    for (const m of text.matchAll(new RegExp(PRIVATE_WORDS.source, 'gi'))) found.push(`${name}: ${m[0]}`)
    for (const m of text.matchAll(new RegExp(PRIVATE_URL.source, 'gi'))) found.push(`${name}: ${m[0].slice(0, 60)}`)
    for (const m of text.matchAll(/absPath url="(?!")[^"]*"/g)) found.push(`${name}: ${m[0].slice(0, 60)}`)
    // An ASIN that is not one of our fakes (B0FX…) is a real Amazon product id.
    for (const m of text.matchAll(/\bB0(?!FX)[0-9A-Z]{8}\b/g)) found.push(`${name}: a real-looking ASIN (${m[0].slice(0, 4)}…)`)
  }
  return [...new Set(found)]
}
/** Every XML part: file paths out, private words and hosts replaced (text nodes and attribute values alike). */
async function scrubZip(zip: JSZip) {
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.(xml|rels|vml)$/.test(name)) continue
    const xml = await zip.file(name)!.async('string')
    let next = xml.replace(/absPath url="[^"]*"/g, 'absPath url=""')
    next = next.replace(/>([^<]+)</g, (_m, t: string) => `>${scrubText(t)}<`).replace(/="([^"]*)"/g, (_m, v: string) => `="${scrubText(v)}"`)
    if (name.startsWith('docProps/app.xml')) next = next.replace(/<vt:lpstr>[^<]*<\/vt:lpstr>/g, m => m)
    if (next !== xml) zip.file(name, next)
  }
}

export async function anonymiseAmazonTemplate(bytes: Buffer, fake: Map<string, string> = new Map()) {
  const { detectAmazonTemplate, rewriteTemplateDataRows } = await import('../../src/services/amazon/template-workbook.js')
  const hash = (value: string, n = 8) => createHash('sha256').update(`chmap-fixture:${value}`).digest('hex').slice(0, n)
  const root = (header: string) => header.replace(/\[[^\]]*\]/g, '').replace(/#\d+/g, '').split('.')[0]
  const leaf = (header: string) => header.replace(/\[[^\]]*\]/g, '').replace(/#\d+/g, '').split('.').at(-1)
  const TEXT_ROOTS = new Set(['item_name', 'bullet_point', 'product_description', 'generic_keyword', 'brand', 'manufacturer', 'model_name', 'model_number', 'part_number', 'title_differentiation'])
  const PRICE = (h: string) => /^(purchasable_offer|list_price|uvp_list_price)/.test(root(h)) && /value(_with_tax)?$/.test(leaf(h) ?? '')

  const parsed = await detectAmazonTemplate(bytes)
    if (!parsed) throw new Error('not an Amazon template')
  const skuHeader = parsed.headers.find(h => root(h) === 'contribution_sku')!
  const replace = (original: string, make: () => string) => { if (!original.trim()) return original; if (!fake.has(original)) fake.set(original, make()); return fake.get(original)! }
  const lorem = (text: string) => {
    const words = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima', 'mike', 'november', 'oscar']
    const out: string[] = []
    const seed = hash(text, 16)
    for (let i = 0; out.join(' ').length < Math.min(text.length, 1800); i++) out.push(words[parseInt(seed[i % 16], 16) % words.length])
    return `Fixture ${out.join(' ')}`.slice(0, Math.max(8, Math.min(text.length, 1800)))
  }
  const skuFake = (sku: string) => `FX-${hash(sku, 6).toUpperCase()}${/-(XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)$/.exec(sku)?.[0] ?? ''}`

  const rows = parsed.rows.map(row => {
    const out: Record<string, string> = {}
    for (const header of parsed.headers) {
      const value = row[header] ?? ''
      if (!value) continue
      const r = root(header)
      if (header === skuHeader || (r === 'child_parent_sku_relationship' && leaf(header) === 'parent_sku')) out[header] = replace(value, () => skuFake(value))
      // The product id: the current template's amzn1…product_id_value, and the old flat file's external_product_id / merchant_suggested_asin.
      else if ((r === 'amzn1' && header.endsWith('product_id_value')) || r === 'external_product_id' || r === 'merchant_suggested_asin') out[header] = replace(value, () => /^B0/.test(value) ? `B0FX${hash(value, 6).toUpperCase()}` : `400${parseInt(hash(value, 9), 16).toString().padStart(10, '0').slice(0, 10)}`)
      else if (/media_location$|source_location$/.test(header) || /^https?:\/\//.test(value)) out[header] = replace(value, () => `https://example.test/fixture/${hash(value, 10)}.${/\.pdf/i.test(value) ? 'pdf' : 'jpg'}`)
      else if (TEXT_ROOTS.has(r)) out[header] = replace(value, () => r === 'brand' || r === 'manufacturer' ? 'ACME FIXTURE' : lorem(value))
      else if (PRICE(header) && Number.isFinite(Number(value))) out[header] = replace(value, () => String(40 + parseInt(hash(value, 4), 16) % 120))
      else out[header] = value
    }
    return out
  })

  const written = await rewriteTemplateDataRows(bytes, rows)
  const zip = await JSZip.loadAsync(written.bytes)
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  // The seller's contributor id and the template instance id, wherever the settings carry them (plain or URL-encoded).
  const settingsText = [...(await zip.file('xl/sharedStrings.xml')?.async('string') ?? '').matchAll(/contributorId(?:=|%3D)([A-Za-z0-9.%]+?)(?:&|%26)/g)].map(m => decodeURIComponent(m[1]))
  for (const id of settingsText) fake.set(id, 'amzn1.cr.o.FIXTURECONTRIBUTOR')
  if (parsed.meta.templateIdentifier) fake.set(parsed.meta.templateIdentifier, `00000000-0000-4000-8000-${hash(parsed.meta.templateIdentifier, 12)}`)
  // Shared strings: every entry whose text is an original private value becomes its fake (indexes unchanged).
  const sstFile = zip.file('xl/sharedStrings.xml')
  // The settings row (row 1 of the template sheet): its base64 dictionaries carry the seller's own data — shipping
  // template names and ids, the brand. Decode, scrub, re-encode; the chunks go back as inline strings and their old
  // shared strings are emptied.
  await rewriteSettingsRow(zip, parsed.meta.sheet, fake, hash)
  if (sstFile) {
    let sst = await sstFile.async('string')
    sst = sst.replace(/<si>([\s\S]*?)<\/si>/g, (whole, inner: string) => {
      const text = unesc([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''))
      if (fake.has(text)) return `<si><t xml:space="preserve">${esc(fake.get(text)!)}</t></si>`
      let changed = text
      for (const [orig, f] of fake) if (orig.length > 6 && changed.includes(orig)) changed = changed.split(orig).join(f)
      for (const [orig, f] of fake) { const enc = encodeURIComponent(orig); if (orig.length > 6 && changed.includes(enc)) changed = changed.split(enc).join(encodeURIComponent(f)) }
      return changed === text ? whole : `<si><t xml:space="preserve">${esc(changed)}</t></si>`
    })
    zip.file('xl/sharedStrings.xml', sst)
  }
  // Inline strings and every other XML part (settings may be inline): replace the ids and any private value left.
  for (const name of Object.keys(zip.files)) {
    if (!/\.(xml|rels)$/.test(name) || name === 'xl/sharedStrings.xml') continue
    let xml = await zip.file(name)!.async('string')
    const before = xml
    for (const [orig, f] of fake) if (orig.length > 6) { xml = xml.split(esc(orig)).join(esc(f)); xml = xml.split(encodeURIComponent(orig)).join(encodeURIComponent(f)) }
    if (name === 'docProps/core.xml') xml = xml.replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, '<dc:creator>Nexus fixture</dc:creator>').replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy>Nexus fixture</cp:lastModifiedBy>')
    if (name === 'docProps/app.xml') xml = xml.replace(/<Company>[\s\S]*?<\/Company>/, '<Company></Company>').replace(/<Manager>[\s\S]*?<\/Manager>/, '<Manager></Manager>')
    if (xml !== before) zip.file(name, xml)
  }
  await scrubZip(zip)
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })

  // The scan: no original private value, the contributor id, or the template id may survive anywhere.
  const check = await JSZip.loadAsync(out)
  const leaks: string[] = []
  const originals = [...fake.keys()].filter(v => v.length > 5 && !/^\d+(\.\d+)?$/.test(v))
  for (const name of Object.keys(check.files)) {
    if (check.files[name].dir) continue
    const text = await check.file(name)!.async('string')
    for (const orig of originals) if (text.includes(esc(orig)) || text.includes(encodeURIComponent(orig))) leaks.push(`${name}: ${orig.slice(0, 40)}`)
  }
  const back = await detectAmazonTemplate(out, { strict: true })
  if (!back || back.rows.length !== parsed.rows.length) throw new Error('the anonymised copy does not read back with the same rows')
  return { bytes: out, rows: back.rows.length, fake, leaks: [...new Set([...leaks, ...(await broadScan(out))])] }
}

/**
 * Our eBay listing workbook: SKUs and parent SKUs (the same fakes as the Amazon copies), titles, subtitles,
 * descriptions, Item/Listing IDs, image links, policy IDs, prices and the brand are replaced; eBay's own vocabulary
 * (conditions, categories, aspect values) and the column set stay. Scanned like the Amazon copy.
 */
export async function anonymiseEbayWorkbook(bytes: Buffer, fake: Map<string, string> = new Map()) {
  const ExcelJS = (await import('exceljs')).default
  const hash = (value: string, n = 8) => createHash('sha256').update(`chmap-fixture:${value}`).digest('hex').slice(0, n)
  const replace = (original: string, make: () => string) => { if (!original.trim()) return original; if (!fake.has(original)) fake.set(original, make()); return fake.get(original)! }
  const skuFake = (sku: string) => `FX-${hash(sku, 6).toUpperCase()}${/-(XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)$/.exec(sku)?.[0] ?? ''}`
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes)
  if (book.worksheets.length !== 1) throw new Error('one eBay worksheet per file')
  const sheet = book.worksheets[0]
  const headers = Array.from({ length: sheet.columnCount }, (_, i) => sheet.getCell(1, i + 1).text.trim())
  const rule = (h: string): ((v: string) => string) | null => {
    if (h === 'SKU' || h === 'Parent SKU') return v => replace(v, () => skuFake(v))
    if (h === 'Title' || h === 'Subtitle') return v => replace(v, () => `Fixture title ${hash(v, 6)}`)
    if (h === 'Description') return v => replace(v, () => `<div>Fixture description ${hash(v, 8)}</div>`)
    if (h === 'Item ID' || /Policy ID$/.test(h) || h === 'Listing ID') return v => replace(v, () => `9${parseInt(hash(v, 10), 16).toString().padStart(11, '0').slice(0, 11)}`)
    if (/^Image \d+$/.test(h)) return v => replace(v, () => `https://example.test/fixture/${hash(v, 10)}.jpg`)
    if (/^Price|^BO (Floor|Ceiling)/.test(h)) return v => Number.isFinite(Number(v)) && Number(v) > 0 ? replace(v, () => String(40 + parseInt(hash(v, 4), 16) % 120)) : v
    if (/^(Marca|Brand)\b/.test(h)) return v => replace(v, () => 'ACME FIXTURE')
    if (h === 'Last Pushed') return () => '2026-01-01T00:00:00.000Z'
    return null
  }
  const rules = headers.map(rule)
  sheet.eachRow((row, n) => {
    if (n === 1) return
    rules.forEach((r, i) => { if (!r) return; const cell = row.getCell(i + 1); const v = cell.text; if (v) cell.value = r(v) })
  })
  if (!/^ebay_[a-z]{2}$/i.test(sheet.name)) sheet.name = 'FIXTURE'
  book.creator = 'Nexus fixture'; book.lastModifiedBy = 'Nexus fixture'; book.company = ''
  const written = await JSZip.loadAsync(Buffer.from(await book.xlsx.writeBuffer()))
  await scrubZip(written)
  const out = await written.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const check = await JSZip.loadAsync(out)
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const leaks: string[] = []
  const originals = [...fake.keys()].filter(v => v.length > 5 && !/^\d+(\.\d+)?$/.test(v))
  for (const name of Object.keys(check.files)) {
    if (check.files[name].dir) continue
    const text = await check.file(name)!.async('string')
    for (const orig of originals) if (text.includes(esc(orig))) leaks.push(`${name}: ${orig.slice(0, 40)}`)
  }
  return { bytes: out, fake, leaks: [...new Set([...leaks, ...(await broadScan(out))])] }
}

async function rewriteSettingsRow(zip: JSZip, sheetName: string, fake: Map<string, string>, hash: (v: string, n?: number) => string) {
  const unesc = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const workbook = await zip.file('xl/workbook.xml')!.async('string')
  const rid = new RegExp(`<sheet[^>]*name="${sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*r:id="([^"]+)"`).exec(workbook)?.[1]
  const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')
  const target = rid ? new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels) : null
  const path = (target?.[1] ?? target?.[2] ?? '').replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/')
  const sheetFile = zip.file(path)
  if (!sheetFile) throw new Error(`template sheet ${sheetName} not found`)
  let sheet = await sheetFile.async('string')
  const sstFile = zip.file('xl/sharedStrings.xml')
  let sst = sstFile ? await sstFile.async('string') : ''
  const entries = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')))
  const row1 = /<row r="1"[^>]*>([\s\S]*?)<\/row>/.exec(sheet)
  if (!row1) return
  const cells = [...row1[1].matchAll(/<c r="([A-Z]+1)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(m => {
    const attrs = m[2], body = m[3] ?? ''
    const shared = /t="s"/.test(attrs) ? Number(/<v>(\d+)<\/v>/.exec(body)?.[1]) : null
    const text = shared !== null ? entries[shared] ?? '' : unesc([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''))
    return { whole: m[0], ref: m[1], shared, text }
  }).filter(c => /^settings\d*=/.test(c.text))
  if (!cells.length) return
  cells.sort((a, b) => Number(/^settings(\d*)=/.exec(a.text)![1] || 1) - Number(/^settings(\d*)=/.exec(b.text)![1] || 1))
  const full = cells.map(c => c.text.slice(c.text.indexOf('=') + 1)).join('')
  const uuid = (v: string) => `00000000-0000-4000-8000-${hash(v, 12)}`
  let shipping = 0
  const scrubJson = (value: unknown, attribute = ''): unknown => {
    if (typeof value === 'string') return scrubText(fake.get(value) ?? value)
    if (Array.isArray(value)) return value.map(v => scrubJson(v, attribute))
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>
      const attr = typeof o.attribute === 'string' ? o.attribute : attribute
      if (attr.startsWith('merchant_shipping_group') && o.aliases && typeof o.aliases === 'object' && !Array.isArray(o.aliases)) {
        const aliases: Record<string, string> = {}
        for (const [name, id] of Object.entries(o.aliases as Record<string, string>)) {
          const fakeName = fake.get(name) ?? (fake.set(name, `Fixture shipping template ${++shipping}`), fake.get(name)!)
          aliases[/^[0-9a-f-]{36}$/.test(name) ? uuid(name) : fakeName] = /^[0-9a-f-]{36}$/.test(String(id)) ? uuid(String(id)) : fakeName
        }
        return { ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'aliases' ? v : scrubJson(v, attr)])), aliases }
      }
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [scrubText(fake.get(k) ?? k), scrubJson(v, attr)]))
    }
    return value
  }
  const params = full.split('&').map(pair => {
    const eq = pair.indexOf('=')
    if (eq <= 0) return pair
    const key = pair.slice(0, eq)
    let raw = pair.slice(eq + 1)
    let value = raw
    try { value = decodeURIComponent(raw) } catch { /* keep */ }
    if (key === 'contributorId') return `${key}=${encodeURIComponent('amzn1.cr.o.FIXTURECONTRIBUTOR')}`
    if (/^[A-Za-z0-9+/]+=*$/.test(value) && value.length > 12) {
      try {
        const json = JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
        return `${key}=${encodeURIComponent(Buffer.from(JSON.stringify(scrubJson(json))).toString('base64'))}`
      } catch { /* not base64 JSON: plain text below */ }
    }
    const next = scrubText(fake.get(value) ?? value)
    return next === value ? pair : `${key}=${encodeURIComponent(next)}`
  })
  const rebuilt = params.join('&')
  const size = Math.ceil(rebuilt.length / cells.length)
  cells.forEach((cell, i) => {
    const part = rebuilt.slice(i * size, (i + 1) * size)
    const text = `${i === 0 ? 'settings' : `settings${i + 1}`}=${part}`
    sheet = sheet.replace(cell.whole, `<c r="${cell.ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`)
    if (cell.shared !== null) entries[cell.shared] = ''
  })
  zip.file(path, sheet)
  if (sstFile) {
    let i = 0
    sst = sst.replace(/<si>([\s\S]*?)<\/si>/g, whole => { const index = i++; return cells.some(c => c.shared === index) ? '<si><t></t></si>' : whole })
    zip.file('xl/sharedStrings.xml', sst)
  }
}

/**
 * NCF N8 — Shopify's own product CSV. Replaced, consistently (same original → same fake, across the file): handles
 * (also where a metafield value names one), titles, bodies, SKUs, barcodes, vendor, product type, tags, SEO text,
 * picture URLs (the store's CDN path and shop id go with them) and alt text, metafield values, prices and cost, stock
 * numbers, Google Shopping labels/MPN. Kept: Shopify's own vocabulary (status, published, option names and values,
 * booleans, units, tracker, policy, the taxonomy breadcrumb) and every header. The copy is then SCANNED
 * (`scanShopifyCsv`): no replaced original may remain anywhere in its text, and no private word or store host; the
 * scan's positive control (a planted original) must be caught, or the copy is refused.
 */
export function anonymiseShopifyCsv(bytes: Buffer, fake: Map<string, string> = new Map()) {
  const hash = (value: string, n = 8) => createHash('sha256').update(`chmap-fixture:${value}`).digest('hex').slice(0, n)
  const replace = (original: string, make: () => string) => { const key = original.trim(); if (!key) return original; if (!fake.has(key)) fake.set(key, make()); return fake.get(key)! }
  const skuFake = (sku: string) => `FX-${hash(sku, 6).toUpperCase()}${/-(XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL|\d{2})$/.exec(sku)?.[0] ?? ''}`
  const grid = parseCsv(bytes, { bom: true, relax_column_count: true }) as string[][]
  const headers = grid[0]
  const originals = new Set<string>()
  const keep = (v: string) => v
  const listOf = (v: string, sep: RegExp, join: string, make: (item: string) => string) => v.split(sep).map(s => s.trim()).filter(Boolean).map(item => { originals.add(item); return replace(item, () => make(item)) }).join(join)
  const money = (v: string) => /^\d+(\.\d+)?$/.test(v.trim()) ? replace(`price:${v.trim()}`, () => `${40 + parseInt(hash(v, 4), 16) % 120}.00`) : v
  const rule = (h: string): ((v: string) => string) => {
    if (h === 'Handle' || h === 'URL handle') return v => replace(v, () => `fixture-product-${hash(v, 6)}`)
    if (h === 'Title') return v => replace(v, () => `Fixture product ${hash(v, 6)}`)
    if (h === 'Body (HTML)' || h === 'Description') return v => v.trim() ? replace(v, () => `<p>Fixture description ${hash(v, 8)}</p>`) : v
    if (h === 'Vendor') return v => replace(v, () => 'ACME FIXTURE')
    if (h === 'Type') return v => replace(v, () => `Fixture type ${hash(v, 4)}`)
    if (h === 'Tags') return v => listOf(v, /,/, ', ', item => `tag-${hash(item, 4)}`)
    if (h === 'Variant SKU' || h === 'SKU') return v => replace(v, () => skuFake(v.trim()))
    if (/^Variant Barcodes?$|^Barcodes?$/.test(h)) return v => replace(v, () => `400${parseInt(hash(v, 9), 16).toString().padStart(10, '0').slice(0, 10)}`)
    if (/^(Variant Price|Price|Variant Compare At Price|Compare-at price|Cost per item)$/.test(h)) return money
    if (/^(Variant Inventory Qty|Inventory quantity)$/.test(h)) return v => /^-?\d+$/.test(v.trim()) ? String(parseInt(hash(`qty:${v}`, 4), 16) % 20) : v
    if (/^(Image Src|Product image URL|Variant Image|Variant image URL)$/.test(h)) return v => replace(v, () => `https://example.test/fixture/${hash(v, 10)}.jpg`)
    if (/^(Image Alt Text|Image alt text)$/.test(h)) return v => v.trim() ? replace(v, () => `Fixture picture ${hash(v, 4)}`) : v
    if (/^SEO (Title|title)$/.test(h)) return v => replace(v, () => `Fixture SEO title ${hash(v, 6)}`)
    if (/^SEO (Description|description)$/.test(h)) return v => replace(v, () => `Fixture SEO description ${hash(v, 6)}`)
    if (/^Google Shopping \/ (MPN|Manufacturer part number|Custom Label|Custom label|Ad group name|Ads labels)/.test(h)) return v => replace(v, () => `fixture-${hash(v, 6)}`)
    if (/\((product|variant)\.metafields\./.test(h)) return v => {
      const t = v.trim()
      if (!t || /^-?\d+(\.\d+)?$/.test(t) || /^(true|false)$/i.test(t)) return v
      // A list value names items one by one (other products' handles, metaobject handles, texts): each item on its own.
      return t.includes(';') ? listOf(t, /;/, '; ', item => fake.get(item) ?? `fixture-value-${hash(item, 6)}`) : (originals.add(t), replace(t, () => `Fixture value ${hash(t, 6)}`))
    }
    return keep
  }
  // Handles first, so a metafield that names another product's handle reuses that handle's fake.
  const handleCol = headers.findIndex(h => h === 'Handle' || h === 'URL handle')
  for (const line of grid.slice(1)) if (handleCol >= 0 && line[handleCol]?.trim()) rule(headers[handleCol])(line[handleCol])
  const rules = headers.map(rule)
  const rows = grid.slice(1).map(line => headers.map((h, i) => {
    const value = line[i] ?? ''
    if (!value.trim()) return value
    const out = rules[i](value)
    if (out !== value && value.trim().length > 5 && !/^\d+(\.\d+)?$/.test(value.trim())) originals.add(value.trim())
    return out
  }))
  // A replaced word that Shopify's own vocabulary in the kept columns also carries (a product type inside the taxonomy
  // breadcrumb, a colour that is also an option value) is Shopify's word, not the Owner's: it is not scanned for.
  const vocabulary = rows.flatMap(line => line.filter((_, i) => rules[i] === keep)).filter(v => v.trim())
  for (const original of [...originals]) if (vocabulary.some(v => v.includes(original))) originals.delete(original)
  const cell = (v: string) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const text = [headers, ...rows].map(line => line.map(cell).join(',')).join('\n') + '\n'
  const leaks = scanShopifyCsv(text, originals)
  // The scan's positive control: an original planted into a copy must be caught, or the scan proves nothing.
  const planted = [...originals].find(o => o.length > 8 && !/^\d/.test(o))
  const control = planted ? scanShopifyCsv(`${text}${planted}\n`, originals).length > leaks.length : false
  return { bytes: Buffer.from(text, 'utf8'), fake, leaks, control, replaced: originals.size, rows: rows.length }
}

/** The scan: any replaced original, private word or store host left in the text. Empty = clean. Findings name no value. */
export function scanShopifyCsv(text: string, originals: Iterable<string> = []): string[] {
  const found: string[] = []
  for (const original of originals) if (original.length > 5 && !/^\d+(\.\d+)?$/.test(original) && text.includes(original)) found.push('an original value remains')
  for (const m of text.matchAll(new RegExp(PRIVATE_WORDS.source, 'gi'))) found.push('a private word remains')
  for (const m of text.matchAll(new RegExp(PRIVATE_URL.source, 'gi'))) found.push('a store link remains')
  for (const m of text.matchAll(/[a-z0-9-]+\.myshopify\.com|cdn\.shopify\.com\/s\/files\/\d/gi)) found.push('a store host remains')
  return found
}
