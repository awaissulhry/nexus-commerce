import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from '@playwright/test'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
import { authenticatedStudioPage } from '../../../../scripts/studio-browser-auth.mjs'
assert.equal(process.argv[2],'screen')
const rootId='cmokmy3a40078pm0p1fvnu523'
const target=await databaseTarget('local');assert.equal(target.identity.database,'nexus_development')
const db=new Client({connectionString:target.connectionString});await db.connect();await db.query('BEGIN READ ONLY')
const index=(await db.query('SELECT * FROM "ReadinessIndex" WHERE "productId" IN (SELECT id FROM "Product" WHERE id=$1 OR "parentId"=$1)',[rootId])).rows
const accounts=(await db.query('SELECT id,"channelType" FROM "ChannelConnection" WHERE "isActive"=true')).rows
await db.query('ROLLBACK');await db.end()
assert.equal(index.length,714)
const browser=await chromium.launch({headless:false})
const requests=[],blocked=[],errors=[],readings=[]
try {
 const page=await authenticatedStudioPage(browser,{base:'http://localhost:3000',viewport:{width:1440,height:1000}})
 const allow=new Set(['/api/auth/me','/api/auth/csrf','/api/marketplaces/grouped','/api/connections',`/api/products/${rootId}`,`/api/products/${rootId}/readiness`,`/api/products/${rootId}/studio/destination`,`/api/products/${rootId}/sync-queue`,'/api/products/ai/drafts'])
 await page.context().route('**/*',async route=>{
  const request=route.request(),u=new URL(request.url())
  if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)) {blocked.push({kind:'external browser resource',host:u.hostname,path:u.pathname});return route.abort()}
  if(u.pathname.startsWith('/api/')) {
   if(request.method()!=='GET'||!allow.has(u.pathname)){blocked.push({kind:'API outside readiness screen',method:request.method(),path:u.pathname});return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Outside the read-only readiness screen gate.'})})}
   requests.push({method:request.method(),path:u.pathname})
  }
  return route.continue()
 })
 page.on('pageerror',error=>errors.push(error.message))
 const cases=[{scope:'master',market:'DE',language:'de'},{scope:'master',market:'IT',language:'it'},
 {scope:'AMAZON',market:'DE',language:'de'},{scope:'AMAZON',market:'BE',language:'nl'},{scope:'AMAZON',market:'BE',language:'fr'},{scope:'AMAZON',market:'UK',language:'en'},
 {scope:'EBAY',market:'IT',language:'it'},{scope:'SHOPIFY',market:'GLOBAL',language:'en'},{scope:'ETSY',market:'GLOBAL',language:'en'}]
 const variants=[{width:1440,theme:'light'},{width:1728,theme:'light'},{width:1440,theme:'dark'},{width:1728,theme:'dark'},{width:960,theme:'light'}]
 for(const [i,c] of cases.entries()) for(const variant of i===0?variants:[variants[0]]){
  await page.setViewportSize({width:variant.width,height:1000})
  const query=new URLSearchParams({scope:c.scope,market:c.market,locale:c.language,tab:'errors'})
  if(c.scope!=='master')query.set('account',accounts.find(a=>a.channelType===c.scope).id)
  const responsePromise=page.waitForResponse(r=>r.url().includes(`/products/${rootId}/readiness?`)&&new URL(r.url()).searchParams.get('locale')===c.language&&r.status()===200,{timeout:60000})
  await page.goto(`http://localhost:3000/products/${rootId}/edit/studio?${query}`,{waitUntil:'domcontentloaded'})
  const response=await responsePromise,body=await response.json()
  await page.evaluate(theme=>{document.documentElement.classList.toggle('dark',theme==='dark');document.documentElement.dataset.theme=theme},variant.theme)
  const matrix=page.getByRole('table',{name:'Readiness matrix',exact:true});await matrix.waitFor({state:'visible',timeout:60000})
  await page.waitForFunction(()=>document.querySelector('[data-readiness-state]'))
  const entries=await matrix.locator('[data-readiness-language]').evaluateAll(nodes=>nodes.map(node=>({language:node.dataset.readinessLanguage,state:node.dataset.readinessState,pct:node.dataset.readinessPct,text:node.textContent})))
  assert.equal(entries.length,body.matrix.length);assert.equal(body.matrix[0].channel,null);assert.ok(body.matrix.filter(e=>e.channel===null).findIndex(e=>e.language==='nl')<body.matrix.filter(e=>e.channel===null).findIndex(e=>e.language==='fr'))
  for(const entry of body.matrix){const rows=index.filter(r=>r.coordinateKey===entry.coordinateKey&&r.language===entry.language);assert.ok(rows.length);const total=rows.reduce((n,r)=>n+r.requiredTotal,0),filled=rows.reduce((n,r)=>n+r.requiredFilled,0);const pct=rows.some(r=>r.pct===null)||!total?null:Math.round(100*filled/total);assert.equal(entry.pct,pct);const row=matrix.locator('tbody tr').filter({has:page.getByText(entry.label,{exact:true})});const pill=row.locator(`[data-readiness-language="${entry.language}"]`);assert.equal(await pill.getAttribute('data-readiness-state'),entry.state);assert.equal(await pill.getAttribute('data-readiness-pct'),String(entry.pct));}
  const scope=body.scopes.find(s=>s.id===c.scope),chip=page.locator(`[data-scope-id="${c.scope}"]`)
  assert.equal(await chip.getAttribute('aria-checked'),'true')
  const chipText=await chip.innerText(),tip=await chip.getAttribute('title')
  assert.ok(tip?.includes(c.language.toUpperCase()),tip);assert.ok(tip?.includes(scope.pct===null?'—':`${scope.pct}%`),tip)
  for(const language of scope.languages??[])if(language.language!==c.language)assert.ok(tip.includes(language.language.toUpperCase()),tip)
  const bounds=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,matrix:document.querySelector('table[aria-label="Readiness matrix"]')?.getBoundingClientRect().toJSON()}))
  assert.ok(bounds.document<=bounds.viewport+1,JSON.stringify(bounds))
  const key=`${c.scope}-${c.market}-${c.language}-${variant.width}-${variant.theme}`
  await page.screenshot({path:new URL(`screen-${key}.png`,import.meta.url).pathname})
  const attention=page.getByRole('table',{name:'Needs attention by language',exact:true});await attention.evaluate(table=>table.closest('.nds-card').scrollIntoView({block:'start'}))
  assert.equal(await attention.locator('tbody tr').count(),body.matrix.filter(e=>e.state!=='ready').length)
  await page.screenshot({path:new URL(`attention-${key}.png`,import.meta.url).pathname})
  if(i===0){const scroll=matrix.locator('xpath=ancestor::*[contains(@class,"nds-grid-wrap")][1]');const geometry=await scroll.evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth,right:e.getBoundingClientRect().right,viewport:innerWidth}));assert.ok(geometry.right<=geometry.viewport+1,JSON.stringify(geometry));let old=0,moved=0;if(geometry.scroll>geometry.client){assert.equal(await scroll.getAttribute('tabindex'),'0');await scroll.scrollIntoViewIfNeeded();await scroll.focus();old=await scroll.evaluate(e=>e.scrollLeft);await page.keyboard.press('ArrowRight');await page.waitForTimeout(300);moved=await scroll.evaluate(e=>e.scrollLeft);assert.ok(moved>old,JSON.stringify({old,moved,geometry}));}readings.push({keyboardScroll:{old,moved,...geometry,tabIndex:await scroll.getAttribute('tabindex')}})}
  const record={coordinate:c,...variant,at:new Date().toISOString(),matrixEntries:entries.length,attentionRows:body.matrix.filter(e=>e.state!=='ready').length,scope:{pct:scope.pct,state:scope.state,required:scope.required},chipText,tip,bounds,screenshot:`screen-${key}.png`}
  readings.push(record);console.log(JSON.stringify({scope:c.scope,market:c.market,language:c.language,...variant,matrixEntries:entries.length,chip:scope.pct,state:scope.state}))
 }
 assert.equal(errors.length,0,JSON.stringify(errors))
 const receipt={at:new Date().toISOString(),productId:rootId,target:target.identity,databaseRows:index.length,databaseReadRolledBack:true,readings,requests,blocked,pageErrors:errors,providerNote:'Only audited database GET routes admitted. Publish/readiness and unrelated calls refused before dispatch. No content writes.'}
 fs.writeFileSync(new URL('screen-evidence.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n')
} catch(error){fs.writeFileSync(new URL('screen-failure.json',import.meta.url),JSON.stringify({error:String(error),readings,requests,blocked,errors},null,2)+'\n');throw error}
finally{await browser.close()}
