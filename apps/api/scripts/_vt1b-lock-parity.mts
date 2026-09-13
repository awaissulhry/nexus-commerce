/** VT.1b item 3 — lock PARITY on every coordinate of GALE-JACKET and VX-TEST-3AX, through the live API. Read-only. */
import '../src/env.js'
const API = process.argv[2] ?? 'http://127.0.0.1:8091'
const { default: p } = await import('../src/db.js')
console.log('DB:', (process.env.DATABASE_URL ?? '').replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@'))
const j = (v: unknown) => JSON.stringify(v)
for (const sku of ['GALE-JACKET', 'VX-TEST-3AX']) {
  const product = await p.product.findFirst({ where: { sku }, select: { id: true, version: true } })
  if (!product) { console.log(`${sku}: not found`); continue }
  const listings = await p.channelListing.findMany({
    where: { productId: product.id }, select: { channel: true, marketplace: true, channelConnectionId: true, listingStatus: true, externalListingId: true },
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
  })
  console.log(`\n=== ${sku} (Product.version ${product.version}) — ${listings.length} parent coordinates`)
  for (const l of listings) {
    const acct = l.channelConnectionId ? `&accountId=${l.channelConnectionId}` : ''
    const proj = await (await fetch(`${API}/api/products/${product.id}/studio/projection?channel=${l.channel}&market=${l.marketplace}${acct}`)).json() as any
    const sheet = await (await fetch(`${API}/api/products/${product.id}/studio/sheet?scope=channel&channel=${l.channel}&market=${l.marketplace}${acct}`)).json() as any
    const cell = sheet.rows?.find((r: any) => r.parentId === null)?.values?.variation_theme?.value ?? null
    const a = proj.locked ? { locked: true, setChangeIs: proj.locked.setChangeIs, order: proj.locked.orderChangeAllowed, id: proj.locked.externalId } : { locked: false }
    const b = cell?.locked ? { locked: true, setChangeIs: cell.locked.setChangeIs, order: cell.locked.orderChangeAllowed, id: cell.locked.externalId } : { locked: false }
    const agree = j(a) === j(b)
    console.log(`  ${l.channel}·${l.marketplace} (${l.listingStatus}, ${l.externalListingId ?? 'no id'}) projection=${j(a)} cell=${j(b)} AGREE=${agree}`)
    if (proj.locked && cell?.locked && proj.locked.reason !== cell.locked.reason) {
      console.log(`      reasons differ BY DESIGN (eBay names the published axes): projection="${String(proj.locked.reason).slice(0, 70)}…" cell="${String(cell.locked.reason).slice(0, 70)}…"`)
    }
  }
}
await p.$disconnect()
