// Local stand-in for an Impact product page, to check the fit finder in a real browser without Shopify.
// It renders the REAL snippets (xavia-fit-finder.liquid + xavia-fit-charts.liquid) with liquidjs, mimics Impact's
// variant picker (a size change re-renders the picker from the server, as Impact does) and its product form.
// It is not evidence of Shopify behaviour; the unpublished preview theme is. Nothing here calls Shopify.
//   npm i --no-save liquidjs   (or LIQUIDJS=/path/to/liquidjs)
//   node integrations/shopify/impact/verification/fit-finder/server.mjs [port]
// Page options: /?locale=it&tags=JACKET,men,women&type=Jacket&sizes=XS,S,M,L,XL&sold=XL&override=<json>
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildAsset } from '../../fit-finder/build.mjs'

const { Liquid } = await import(process.env.LIQUIDJS || 'liquidjs')
const root = fileURLToPath(new URL('../../fit-finder/', import.meta.url))
const engine = new Liquid({ root, extname: '.liquid', strictFilters: true })
engine.registerFilter('asset_url', name => `/assets/${name}`)
engine.registerFilter('image_url', url => url)

const DEFAULT_SIZES = 'XS,S,M,L,XL,XXL,3XL,4XL,5XL'
function product(query) {
  const sizes = (query.get('sizes') || DEFAULT_SIZES).split(','), sold = new Set((query.get('sold') || '').split(',').filter(Boolean))
  const selected = query.get('size') || sizes[0]
  const override = query.get('override')
  return {
    sizes, selected,
    values: sizes.map((name, i) => ({ name, id: 1000 + i, available: !sold.has(name), selected: name === selected })),
    product: {
      title: query.get('title') || 'GALE jacket', type: query.get('type') ?? 'Jacket', tags: (query.get('tags') ?? 'JACKET,men,women,textile').split(',').filter(Boolean),
      featured_image: query.get('image') === 'none' ? '' : '/product.svg', metafields: { xavia: { fit_chart: override ? { value: JSON.parse(override) } : '' } },
    },
  }
}

async function picker(query) {
  const p = product(query)
  const option = { position: 2, values: p.values }
  const snippet = await engine.renderFile('xavia-fit-finder', {
    product: p.product, option, form_id: 'product-form-1', request: { locale: { iso_code: query.get('locale') || 'en' } },
    localization: { country: { iso_code: query.get('country') || 'IT' } }, routes: { root_url: query.get('locale') && query.get('locale') !== 'en' ? `/${query.get('locale')}` : '/' },
  })
  const radios = p.values.map(v => `<input class="sr-only" type="radio" id="o-${v.id}" form="product-form-1" name="product-form-1-option2" data-option-position="2" value="${v.id}"${v.selected ? ' checked' : ''}><label class="block${v.available ? '' : ' is-disabled'}" for="o-${v.id}">${v.name}</label>`).join('')
  return `<script data-variant type="application/json">${JSON.stringify({ id: 5000 + p.sizes.indexOf(p.selected), options: ['Black', p.selected] })}</script>
    <fieldset class="variant-picker__option"><div class="variant-picker__option-info"><legend>Size:</legend> <span>${p.selected}</span> <button type="button" class="size-chart-link">Size chart</button></div>
    ${snippet}
    <div class="values">${radios}</div></fieldset>`
}

async function page(query) {
  return `<!doctype html><html lang="${query.get('locale') || 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fit finder stand-in</title>
<style>
  :root { --text-primary: 26 26 26; --background-primary: 255 255 255; --dialog-background: 255 255 255; --button-background-primary: 255 122 0; --button-text-primary: 255 255 255;
    --success-text: 22 128 61; --success-background: 232 245 237; --warning-text: 176 92 0; --error-text: 196 32 32; --error-background: 253 236 236; --rounded-input: 8px; --rounded-button: 999px; --rounded-block: 12px;
    --text-font-family: "Jost", system-ui, sans-serif; --heading-font-family: "Jost", system-ui, sans-serif; }
  body { margin: 0; font-family: var(--text-font-family); color: rgb(var(--text-primary)); background: rgb(var(--background-primary)); }
  main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px); gap: 32px; max-width: 1100px; margin: 24px auto; padding: 0 16px; }
  @media (max-width: 799px) { main { grid-template-columns: 1fr; } }
  .gallery { background: #f4f4f5; border-radius: 12px; min-height: 300px; display: grid; place-items: center; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .variant-picker__option { border: 0; padding: 0; margin: 0 0 16px; display: grid; gap: 12px; }
  .variant-picker__option-info { display: flex; gap: 6px; align-items: center; } .size-chart-link { margin-left: auto; background: none; border: 0; text-decoration: underline; font: inherit; }
  .values { display: flex; flex-wrap: wrap; gap: 8px; } .block { min-width: 48px; min-height: 44px; display: grid; place-items: center; border: 1px solid #ccc; border-radius: 8px; padding: 0 10px; cursor: pointer; }
  input:checked + .block { border-color: #000; box-shadow: inset 0 0 0 1px #000; } .is-disabled { color: #999; text-decoration: line-through; }
  .add { width: 100%; min-height: 52px; border: 0; border-radius: 999px; background: rgb(var(--button-background-primary)); color: #fff; font: inherit; font-weight: 700; }
</style></head><body>
<main><div class="gallery"><img src="/product.svg" alt="" width="240" height="240"></div>
<div><h1>${product(query).product.title}</h1>
<variant-picker form-id="product-form-1" data-query="${query.toString().replace(/"/g, '&quot;')}">${await picker(query)}</variant-picker>
<form id="product-form-1" action="/cart/add" method="post"><input type="hidden" name="id" value="5000"><button type="submit" class="add">Add to cart</button></form>
<p id="cart-status" role="status"></p></div></main>
<script>
  // Impact stand-in: a size change fetches the picker again and replaces it (inline scripts do not run again).
  window.__added = []
  document.body.addEventListener('change', async event => {
    const input = event.target.closest('input[data-option-position][form="product-form-1"]')
    if (!input) return
    const picker = document.querySelector('variant-picker'), query = new URLSearchParams(picker.dataset.query)
    query.set('size', input.nextElementSibling.textContent)
    picker.dataset.query = query.toString()
    picker.innerHTML = await (await fetch('/fragment?' + query)).text()
    document.forms['product-form-1'].elements.id.value = String(5000 + Number(input.value) - 1000)
    document.forms['product-form-1'].dispatchEvent(new CustomEvent('variant:change', { bubbles: true }))
  })
  // Impact's ProductForm listens on the form itself and sends FormData to /cart/add.js.
  document.forms['product-form-1'].addEventListener('submit', event => {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(event.target))
    window.__added.push(data)
    document.getElementById('cart-status').textContent = 'Added variant ' + data.id
  })
</script></body></html>`
}

// The 3D mannequin alone: /viewer.html?sex=female&height=170&weight=80&chest=102&waist=88&rings=1
const VIEWER_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mannequin</title>
<style>body{margin:0;font-family:system-ui;background:#fff} #stage{position:relative;width:420px;height:640px;margin:20px;border-radius:16px;background:radial-gradient(120% 80% at 50% 35%,#fbfbfc,#e7e8eb)} .xff-3d{position:absolute;inset:0;width:100%;height:100%} .xff-3d-labels{position:absolute;inset:0;pointer-events:none} .xff-3d-label{position:absolute;transform:translateY(-50%);display:flex;align-items:center} .xff-3d-label__line{position:absolute;right:100%;height:1px;background:#999;transform-origin:right center} .xff-3d-label__text{white-space:nowrap;background:#fff;border-radius:999px;padding:4px 10px;font:600 12px system-ui;box-shadow:0 1px 4px rgba(0,0,0,.15)}</style>
<div id="stage"></div><script type="module">
import { createViewer } from '/src/xavia-fit-viewer.js'
const q = new URLSearchParams(location.search), n = k => q.get(k) ? Number(q.get(k)) : undefined
const v = createViewer(document.getElementById('stage'), { urls: { male: '/assets/xavia-fit-body-male.js', female: '/assets/xavia-fit-body-female.js' }, label: '3D body' })
await v.setBody({ sex: q.get('sex') || 'male', values: { height: n('height'), chest: n('chest'), waist: n('waist'), hips: n('hips') }, weightKg: n('weight') })
if (q.get('skin')) v.setSkin(Number(q.get('skin')))
if (q.get('rings')) { v.setFrame('torso'); v.setRings([{ measure: 'chest', tone: 'ok', text: 'Chest · Just right' }, { measure: 'waist', tone: 'warn', text: 'Waist · Close fit' }]) }
if (q.get('yaw')) setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
window.__viewer = v
</script>`

const PRODUCT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#f4f4f5"/><path d="M70 40l30 12 30-12 30 20-12 30-14-6v86H66V84l-14 6-12-30z" fill="#222"/><path d="M100 52v124" stroke="#555" stroke-width="2"/><path d="M60 70l40-8 40 8" stroke="#ff7a00" stroke-width="5" fill="none"/></svg>`

const port = Number(process.argv[2] || process.env.PORT || 4317)
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await page(url.searchParams))
    if (url.pathname === '/fragment') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await picker(url.searchParams))
    if (url.pathname === '/assets/xavia-fit-finder.js') return res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(buildAsset())
    // Source modules and packed bodies, for viewer-only checks (/viewer.html) and the theme's separate body assets.
    const body = url.pathname.match(/^\/assets\/(xavia-fit-body-(?:male|female)\.js)$/)
    if (body) return res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(readFileSync(new URL(`body/${body[1]}`, new URL('../../fit-finder/', import.meta.url))))
    const source = url.pathname.match(/^\/src\/(xavia-fit-[a-z]+\.js)$/)
    if (source) return res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(readFileSync(new URL(source[1], new URL('../../fit-finder/', import.meta.url))))
    if (url.pathname === '/viewer.html') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(VIEWER_PAGE)
    if (url.pathname === '/product.svg') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(PRODUCT_SVG)
    res.writeHead(404).end('not found')
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error?.stack || error))
  }
}).listen(port, '127.0.0.1', () => console.log(`fit finder stand-in on http://127.0.0.1:${port}/`))
