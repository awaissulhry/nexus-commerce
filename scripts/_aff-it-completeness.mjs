// READ-ONLY: per-family field completeness for the IT Amazon flat file.
// Flags empty critical fields on parents vs children. Writes NOTHING.
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const { rows } = await (await fetch(`${API}/api/amazon/flat-file/rows?marketplace=IT`)).json()
const pl = (r) => String(r.parentage_level ?? '').toLowerCase()
const has = (r, keys) => keys.some((k) => r[k] != null && String(r[k]).trim() !== '')

// group by family
const fam = new Map()
for (const r of rows) {
  const key = pl(r) === 'parent' ? String(r.item_sku ?? '') : String(r.parent_sku ?? r.item_sku ?? '')
  if (!fam.has(key)) fam.set(key, { parent: null, kids: [] })
  if (pl(r) === 'parent') fam.get(key).parent = r; else fam.get(key).kids.push(r)
}

const PRICE = ['purchasable_offer__our_price', 'standard_price', 'list_price']
const QTY = ['fulfillment_availability__quantity']
const oneSize = (t) => t === 'AUTO_ACCESSORY'  // knee sliders: no size axis

console.log('FAMILY                          | P:title theme brand img bul desc | C:title color size price qty asin brand img bul desc')
console.log('-'.repeat(115))
const totals = { pTitle:0,pTheme:0,pBrand:0,pImg:0,pBul:0,pDesc:0, cTitle:0,cColor:0,cSize:0,cPrice:0,cQty:0,cAsin:0,cBrand:0,cImg:0,cBul:0,cDesc:0, kids:0 }
for (const [key, f] of [...fam.entries()].sort()) {
  const p = f.parent
  const pt = p ? String(p.product_type ?? '') : ''
  // parent gaps
  const pMiss = p ? {
    title: !has(p,['item_name']), theme: !has(p,['variation_theme']), brand: !has(p,['brand']),
    img: !has(p,['main_product_image_locator','main_image_url']), bul: !has(p,['bullet_point_1']), desc: !has(p,['product_description']),
  } : null
  // child gaps (aggregate counts)
  let c = { title:0,color:0,size:0,price:0,qty:0,asin:0,brand:0,img:0,bul:0,desc:0 }
  for (const k of f.kids) {
    if (!has(k,['item_name'])) c.title++
    if (!has(k,['color','color_name'])) c.color++
    if (!oneSize(String(k.product_type??'')) && !has(k,['size','size_name','apparel_size'])) c.size++
    if (!has(k,PRICE)) c.price++
    if (!has(k,QTY)) c.qty++
    if (!has(k,['external_product_id'])) c.asin++
    if (!has(k,['brand'])) c.brand++
    if (!has(k,['main_product_image_locator','main_image_url'])) c.img++
    if (!has(k,['bullet_point_1'])) c.bul++
    if (!has(k,['product_description'])) c.desc++
  }
  totals.kids += f.kids.length
  if (pMiss){ if(pMiss.title)totals.pTitle++; if(pMiss.theme)totals.pTheme++; if(pMiss.brand)totals.pBrand++; if(pMiss.img)totals.pImg++; if(pMiss.bul)totals.pBul++; if(pMiss.desc)totals.pDesc++ }
  totals.cTitle+=c.title; totals.cColor+=c.color; totals.cSize+=c.size; totals.cPrice+=c.price; totals.cQty+=c.qty; totals.cAsin+=c.asin; totals.cBrand+=c.brand; totals.cImg+=c.img; totals.cBul+=c.bul; totals.cDesc+=c.desc
  const flag = (b) => b ? '✗' : '·'
  const pStr = pMiss ? `${flag(pMiss.title)}     ${flag(pMiss.theme)}    ${flag(pMiss.brand)}    ${flag(pMiss.img)}  ${flag(pMiss.bul)}  ${flag(pMiss.desc)}  ` : 'no-parent-row'.padEnd(28)
  const n=(x)=>String(x).padStart(2)
  const cStr = `${n(c.title)}   ${n(c.color)}  ${n(c.size)}  ${n(c.price)}  ${n(c.qty)}  ${n(c.asin)}  ${n(c.brand)}  ${n(c.img)}  ${n(c.bul)}  ${n(c.desc)}`
  console.log(`${key.slice(0,31).padEnd(31)} | ${pStr} | ${cStr}`)
}
console.log('-'.repeat(115))
console.log('LEGEND parent: ✗=missing on parent · =present   |   child columns = COUNT of children missing that field  (kids total='+totals.kids+')')
console.log('\nCHILD-FIELD MISSING TOTALS:', JSON.stringify({title:totals.cTitle,color:totals.cColor,size:totals.cSize,price:totals.cPrice,qty:totals.cQty,asin:totals.cAsin,brand:totals.cBrand,img:totals.cImg,bullets:totals.cBul,desc:totals.cDesc}))
console.log('PARENT-FIELD MISSING TOTALS:', JSON.stringify({title:totals.pTitle,theme:totals.pTheme,brand:totals.pBrand,img:totals.pImg,bullets:totals.pBul,desc:totals.pDesc}))
