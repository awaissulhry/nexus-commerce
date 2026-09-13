import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { specimen } from './specimen.mjs'
import { chromium } from '@playwright/test'
import { authenticatedStudioPage } from '../../../../scripts/studio-browser-auth.mjs'
const sourceSnapshot = () => {
 const out = {}
 const walk = dir => { for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
  const file = path.join(dir,entry.name)
  if(entry.isDirectory()) walk(file)
  else if(/\.(tsx?|css)$/.test(file)) out[file]=createHash('sha256').update(fs.readFileSync(file)).digest('hex')
 } }
 for(const dir of ['apps/web/src/app/products/[id]/edit/_studio','apps/web/src/design-system','apps/api/src/services/pim']) walk(dir)
 return out
}
const sourceBefore = sourceSnapshot()
const step = process.argv[2]; assert.ok(['a','b','c','c-missing','d','e','f','g','h'].includes(step))
const rootId = 'cmokmy3a40078pm0p1fvnu523', base = 'http://localhost:3000'
const sheets = new Map()
const requests = [], blocked = [], errors = [], consoleErrors = [], readings = []
const cases = [{ scope:'master', market:'IT', language:'it' }, { scope:'AMAZON', market:'DE', language:'de' },
 { scope:'AMAZON', market:'BE', language:'nl' }, { scope:'AMAZON', market:'BE', language:'fr' }, { scope:'EBAY', market:'IT', language:'it' }]
const accounts = await (await fetch('http://127.0.0.1:4120/api/connections')).json()
const markets = await (await fetch('http://127.0.0.1:4120/api/marketplaces/grouped')).json()
const browser = await chromium.launch({ headless:false })
let page
const newContext = browser.newContext.bind(browser)
browser.newContext = async options => {
 const context = await newContext(options)
 context.on('page', p => {
  p.on('console', m => { if(m.type()==='error') consoleErrors.push({ text: m.text(), location: m.location() }) })
  p.on('requestfailed', r => requests.push({failed:true,path:new URL(r.url()).pathname,reason:r.failure()?.errorText}))
 })
 return context
}
try {
 page = await authenticatedStudioPage(browser, { base, viewport:{ width:1440, height:1000 } })
 await page.context().route('**/*', async route => {
  const req = route.request(), u = new URL(req.url())
  if (!['localhost','127.0.0.1','[::1]'].includes(u.hostname)) { blocked.push({kind:'external browser resource',host:u.hostname});return route.abort() }
  if (!u.pathname.startsWith('/api/') || u.pathname.startsWith('/api/auth/')) return route.continue()
  const method=req.method()
  if (method !== 'GET' && !(method === 'POST' && u.pathname === '/api/pim/formulas/batch')) {
   blocked.push({kind:'mutation',method,path:u.pathname});return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Read-only screen gate.'})})
  }
  const response = await fetch(`http://127.0.0.1:4120${u.pathname}${u.search}`, {method,headers:{'content-type':'application/json'},...(req.postData()?{body:req.postData()}: {})})
  const body=await response.text();if(u.pathname.endsWith('/studio/sheet')&&response.ok) sheets.set(u.search,JSON.parse(body));requests.push({path:u.pathname,query:u.search,status:response.status})
  return route.fulfill({status:response.status,contentType:'application/json',body})
 })
 page.on('pageerror', error => errors.push(error.message))
 for (const c of cases.filter(c => step !== 'c-missing' || c.market === 'BE')) for (const width of [1440,1728]) for (const theme of ['light','dark']) {
  await page.setViewportSize({width,height:1000})
  const query=new URLSearchParams({scope:c.scope,market:c.market,locale:c.language,tab:'information'})
  if(c.scope!=='master'){
   const list=Array.isArray(accounts)?accounts:accounts.connections??accounts.accounts??[]
   const account=list.find(a=>(a.channelType??a.channel)===c.scope)
   assert.ok(account,`Missing ${c.scope} account; keys ${Object.keys(accounts)}`);query.set('account',account.id)
  }
  await page.goto(`${base}/products/${rootId}/edit/studio?${query}`,{waitUntil:'domcontentloaded'})
  await page.locator('.ag-root').first().waitFor({state:'visible',timeout:60000})
  await page.waitForFunction(()=>document.querySelectorAll('.ag-row[row-id]').length>0,{},{timeout:60000})
  await page.waitForTimeout(600)
  await page.evaluate(t=>{document.documentElement.classList.toggle('dark',t==='dark')},theme)
  await page.waitForTimeout(250)
  let languagesReading
  if(step==='c'||step==='c-missing') {
   const responseReady=page.waitForResponse(response=>{const u=new URL(response.url());return u.pathname.endsWith('/studio/sheet')&&u.searchParams.has('locales')&&response.status()===200},{timeout:60000})
   await page.getByRole('button',{name:/^Languages\s/}).click()
   await responseReady
   await page.waitForFunction(()=>!document.body.innerText.includes('Loading information')&&document.querySelectorAll('.ag-grid-scrolling-container .ag-row[row-id]').length>0,{},{timeout:60000})
   await page.waitForTimeout(1000)
   const selected=new URL(page.url()).searchParams.get('locales')?.split(',')??[]
   const entry=[...sheets.entries()].reverse().find(([query])=>new URLSearchParams(query).get('locales')===selected.join(','))
   assert.ok(entry,'Languages view must use the sheet route locales parameter')
   const wire=entry[1]
   const localizable=wire.columns.filter(column=>column.locale)
   const textKeys=new Set(wire.columns.filter(column=>column.locale||column.localizable).map(column=>column.key))
   await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>(button.textContent??'').startsWith('Languages')&&button.getAttribute('aria-pressed')==='true'),{},{timeout:15000})
   assert.ok(localizable.every(column=>column.key.endsWith('@'+column.locale)))
   const counts={'Needs translation':0,'AI drafts':0,'Out of date':0}
   for(const row of wire.rows) for(const [key,cell] of Object.entries(row.values)) {
    if(!textKeys.has(key)) continue
    if(cell.requested&&cell.language!==cell.requested) counts['Needs translation']++
    if(cell.translation&&cell.translation.source!=='manual'&&!cell.translation.reviewedAt) counts['AI drafts']++
    if(cell.translation?.outdated) counts['Out of date']++
   }
   const buttons={}
   for(const [label,count] of Object.entries(counts)) {
    const button=page.getByRole('button',{name:new RegExp('^'+label+':')})
    await button.waitFor({state:'visible'})
    const box=await button.boundingBox()
    assert.ok(box&&box.x>=0&&box.x+box.width<=width,JSON.stringify({label,box,width}))
    buttons[label]=await button.innerText()
    assert.ok(buttons[label].includes(String(count)),JSON.stringify({label,count,actual:buttons[label]}))
   }
   languagesReading={selected,columns:wire.columns.length,localizable:localizable.length,counts,buttons,
    groups:await page.locator('.ag-header-group-cell').allTextContents(),
    selectedChips:await page.getByRole('group',{name:'Content language',exact:true}).locator('[aria-pressed="true"]').allTextContents()}
   assert.equal(languagesReading.selectedChips.length,selected.length)
   const visibleFields=await page.locator('.ag-header-cell[col-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('col-id')).filter(key=>key&&!key.startsWith('ag-')))
   assert.ok(visibleFields.every(key=>textKeys.has(key)),JSON.stringify({visibleFields,textKeys:[...textKeys]}))
   if(localizable.length) {
    const group=page.locator('.ag-header-group-text').first()
    const box=await group.boundingBox()
    assert.ok(box&&box.x>=0&&box.x+box.width<=width,JSON.stringify({fieldHeading:await group.textContent(),box,width}))
   }
   languagesReading.visibleFields=visibleFields
   if(c.scope==='master'&&width===1440&&theme==='light') {
    const before=page.url()
    await page.reload({waitUntil:'domcontentloaded'})
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>(button.textContent??'').startsWith('Languages')&&button.getAttribute('aria-pressed')==='true'),{},{timeout:60000})
    await page.waitForFunction(()=>document.querySelectorAll('.ag-grid-scrolling-container .ag-row[row-id]').length>0,{},{timeout:60000})
    assert.equal(page.url(),before)
    await page.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme)
    await page.waitForTimeout(250)
    const afterReload=await page.locator('.ag-header-cell[col-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('col-id')).filter(key=>key&&!key.startsWith('ag-')))
    assert.ok(afterReload.every(key=>textKeys.has(key)),JSON.stringify(afterReload))
    languagesReading.reload='Same locales URL and active Languages restored after full reload'
   }
  }
  let chipReading
  if(step==='b') {
   const group=page.getByRole('group',{name:'Content language',exact:true})
   await group.waitFor({state:'visible'})
   const expected=c.scope==='master' ? [...new Set([markets._meta.primaryLanguage,...Object.values(markets).filter(Array.isArray).flatMap(rows=>rows.flatMap(row=>row.languages))])].sort((a,b)=>a===markets._meta.primaryLanguage?-1:b===markets._meta.primaryLanguage?1:a.localeCompare(b)) : markets[c.scope].find(row=>row.code===c.market).languages
   chipReading=await group.getByRole('button').evaluateAll(nodes=>nodes.map(e=>({text:e.textContent,pressed:e.getAttribute('aria-pressed'),box:e.getBoundingClientRect().toJSON(),background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color})))
   const display=new Intl.DisplayNames(['en'],{type:'language'})
   assert.deepEqual(chipReading.map(e=>e.text),expected.map(code=>display.of(code)+(c.scope==='master'&&code===markets._meta.primaryLanguage?' · source':'')))
   assert.equal(chipReading.filter(e=>e.pressed==='true').length,1)
   assert.ok(chipReading.every(e=>e.box.height===28),JSON.stringify(chipReading))
   if(c.market==='BE') {
    const original=expected.indexOf(c.language), other=original===0?1:0
    await group.getByRole('button').nth(other).focus()
    const switched=page.waitForResponse(response=>{const u=new URL(response.url());return u.pathname.endsWith('/studio/sheet')&&u.searchParams.get('locale')===expected[other]&&response.status()===200})
    await page.keyboard.press('Space')
    await switched
    await page.waitForFunction(lang=>new URL(location.href).searchParams.get('locale')===lang,expected[other])
    assert.equal(await group.getByRole('button').nth(other).getAttribute('aria-pressed'),'true')
    const restored=page.waitForResponse(response=>{const u=new URL(response.url());return u.pathname.endsWith('/studio/sheet')&&u.searchParams.get('locale')===c.language&&response.status()===200})
    await group.getByRole('button').nth(original).focus();await page.keyboard.press('Enter')
    await restored
    await page.waitForFunction(lang=>new URL(location.href).searchParams.get('locale')===lang,c.language)
    await page.waitForFunction(()=>document.querySelectorAll('.ag-grid-scrolling-container .ag-row[row-id]').length>0,{},{timeout:60000})
    await page.waitForTimeout(600)
    chipReading.keyboard='Space switched language; Enter restored original language'
   }
  }
  const reading=await page.evaluate(()=>({url:location.href,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,
   rows:[...document.querySelectorAll('.ag-grid-scrolling-container .ag-row[row-id]')].map(e=>e.getAttribute('row-id')),
   headers:[...document.querySelectorAll('.ag-header-cell[col-id]')].map(e=>({id:e.getAttribute('col-id'),text:e.textContent})),
   marks:[...document.querySelectorAll('.nds-cell-prov')].map(e=>({class:e.className,title:e.getAttribute('title'),width:e.getBoundingClientRect().width})),
   activeViews:[...document.querySelectorAll('button[aria-pressed="true"]')].map(e=>e.textContent),
   scopeBar:document.querySelector('[data-scope-id]')?.parentElement?.parentElement?.textContent,
   text:document.body.innerText.slice(-800)}))
  assert.ok(reading.rows.length,JSON.stringify(reading));assert.ok(reading.documentWidth<=width+1,JSON.stringify(reading))
  if(chipReading) reading.languageChips=chipReading
  if(languagesReading) {
   assert.ok(reading.activeViews.some(text=>text.startsWith('Languages')),JSON.stringify(reading.activeViews))
   reading.languagesView=languagesReading
  }
  if (step === 'c-missing') {
   const empty = page.locator('.cs-contract-empty')
   await empty.waitFor({state:'visible'})
   assert.match(await empty.innerText(), /Amazon · BE: OUTERWEAR contract not loaded/)
   assert.match(await empty.innerText(), /Refresh requirements/)
   const pills = await page.locator('.nds-readypill-num').allTextContents()
   assert.ok(pills.length >= 21, JSON.stringify(pills))
   assert.ok(pills.every(text => text === '—'), JSON.stringify(pills))
   reading.missingContract = { empty: await empty.innerText(), pills }
  }
  if (step === 'd') {
   const entry = [...sheets.entries()].reverse().find(([query]) => {
    const q = new URLSearchParams(query)
    return q.get('market') === c.market && q.get('locale') === c.language && !q.has('locales') && (c.scope === 'master' ? !q.has('channel') : q.get('channel') === c.scope)
   })
   assert.ok(entry, 'Actual single-language sheet reply is required')
   const wire = entry[1]
   const text = wire.columns.filter(column => column.localizable)
   assert.ok(text.length > 0, `A populated ${c.scope}/${c.market}/${c.language} contract is required for d`)
   assert.equal(wire.meta.schemaMissing.length, 0, 'd cannot accept a missing contract')
   const facts = []
   for (const row of wire.rows) for (const column of text) {
    const cell = row.values[column.key]
    assert.ok(cell, `${row.id}:${column.key}`)
    for (const key of ['tier','language','requested','provenance']) assert.ok(cell[key], `${row.id}:${column.key}:${key}`)
    for (const key of ['requestedLocale','effectiveLocale','translationState','needsTranslation']) assert.equal(Object.hasOwn(cell,key), false, `Old wire ${key}`)
    assert.equal(cell.requested, c.language)
    assert.ok(cell.provenance.from, `${row.id}:${column.key} must name the answering tier`)
    facts.push({ field: column.key, tier: cell.tier, language: cell.language, member: cell.provenance.member, from: cell.provenance.from, follows: cell.follows })
   }
   assert.equal(await page.locator('.ag-root .nds-source-indicator').count(), 0)
   assert.ok(reading.marks.length > 0, 'Resolved inherited/computed values must show marks')
   reading.contentWire = { textColumns: text.length, cells: facts.length, samples: facts.slice(0, text.length), legacySourceIndicators: 0 }
  }
  const name=`${step}-${c.scope}-${c.market}-${c.language}-${width}-${theme}`
  await page.screenshot({path:new URL(`screen-${name}.png`,import.meta.url).pathname})
  if(step==='a') {
   await page.evaluate(html=>{
    const wrapper=document.createElement('section');wrapper.id='lx6-ds-specimen';wrapper.innerHTML=html;
    Object.assign(wrapper.style,{position:'fixed',bottom:'16px',left:'16px',right:'16px',zIndex:'9999',padding:'16px',background:'var(--nds-surface)',color:'var(--nds-text)',border:'1px solid var(--nds-border)',boxShadow:'var(--nds-shadow-card)',fontSize:'var(--nds-font-size-base)'})
    for(const cell of wrapper.querySelectorAll('.ag-cell'))Object.assign(cell.style,{position:'relative',display:'flex',height:'30px',lineHeight:'30px',width:'100%'})
    document.body.append(wrapper)
   },specimen)
   reading.specimen=await page.locator('#lx6-ds-specimen .nds-cell-prov-outdated').evaluate(e=>({title:e.title,box:e.getBoundingClientRect().toJSON(),foreground:getComputedStyle(e).color,background:getComputedStyle(e.closest('.ag-cell')).backgroundColor,tabIndex:e.getAttribute('tabindex')}))
   await page.screenshot({path:new URL(`specimen-${name}.png`,import.meta.url).pathname})
   await page.locator('#lx6-ds-specimen').evaluate(e=>e.remove())
  }
  readings.push({at:new Date().toISOString(),requested:c,width,theme,...reading,screenshot:`screen-${name}.png`})
  console.log(JSON.stringify({step,...c,width,theme,rows:reading.rows.length,columns:reading.headers.length,marks:reading.marks.length,url:reading.url}))
 }
 assert.equal(errors.length,0,JSON.stringify(errors))
 const reactErrors=consoleErrors.filter(error=>/Maximum update depth|Too many re-renders|Hydration failed|Minified React error|Cannot update a component/i.test(error.text))
 assert.equal(reactErrors.length,0,JSON.stringify(reactErrors))
 const sourceAfter = sourceSnapshot()
 const sourceChanges = [...new Set([...Object.keys(sourceBefore),...Object.keys(sourceAfter)])].filter(file => sourceBefore[file] !== sourceAfter[file])
 assert.equal(sourceChanges.length, 0, `Source changed during the browser gate; this reading is invalid: ${sourceChanges.join(', ')}`)
 const api=await (await fetch('http://127.0.0.1:4120/gate/evidence')).json()
 assert.equal(api.transportAttempts.length,0);assert.equal(api.blockedGateways.length,0)
 fs.writeFileSync(new URL(`screens-${step}.json`,import.meta.url),JSON.stringify({at:new Date().toISOString(),sourceBefore,sourceAfter,readings,requests,blocked,consoleErrors,errors,api},null,2)+'\n')
} catch(error) {
 page ??= browser.contexts()[0]?.pages()[0]
 if(page) await page.screenshot({path:new URL(`screen-${step}-failure.png`,import.meta.url).pathname}).catch(()=>{})
 fs.writeFileSync(new URL(`screens-${step}-failure.json`,import.meta.url),JSON.stringify({error:String(error),sourceBefore,sourceAfter:sourceSnapshot(),readings,requests,blocked,consoleErrors,errors},null,2)+'\n');throw error
} finally {await browser.close()}
