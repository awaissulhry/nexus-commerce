import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root=process.cwd(); const phase='screen'
const result=await build({ stdin:{ contents:`
 export { default as prisma } from './apps/api/src/db.ts';
 export { default as marketplaces } from './apps/api/src/routes/marketplaces.routes.ts';
 export { default as connections } from './apps/api/src/routes/connections.routes.ts';
 export { productAiDraftRoutes as productsAi } from './apps/api/src/routes/product-enrichment.routes.ts';
 export { default as savedViews } from './apps/api/src/routes/saved-view-persistence.routes.ts';
 export { default as pim } from './apps/api/src/routes/pim.routes.ts';
 export { default as categories } from './apps/api/src/routes/categories.routes.ts';
 export { default as products } from './apps/api/src/routes/products.routes.ts';
 export { default as studio } from './apps/api/src/routes/product-studio.routes.ts';
 export { default as formulas } from './apps/api/src/routes/cell-formula.routes.ts';
 export { default as translations } from './apps/api/src/routes/product-translations.routes.ts';
 export { default as global } from './apps/api/src/routes/pim-global.routes.ts';
 export { reconcileFamilyReadiness } from './apps/api/src/services/pim/readiness-index.service.ts';
 export { writeContent } from './apps/api/src/services/pim/content-write.ts';
 export { withCachedSchemas } from './apps/api/src/services/pim/cached-schema-context.ts';
 export { inDatabaseTransaction } from './apps/api/src/lib/database-context.ts';
 `,resolveDir:root,loader:'ts'},outfile:`docs/audits/2026-09-12-language-axis/step6/rehearsal-runtime-${phase}.mjs`,bundle:true,platform:'node',format:'esm',packages:'external',metafile:true,
 banner:{js:"import { createRequire as lxCreateRequire } from 'node:module'; const require = lxCreateRequire(import.meta.url);"},
 plugins:[{name:'local-rehearsal-boundaries',setup(b){
  for(const [pattern,method] of [[/\/shopify\/admin-client\.ts$/,'shopifyAdmin'],[/\/etsy\/read-client\.ts$/,'etsyReader']]) b.onLoad({filter:pattern},async args=>({contents:(await readFile(args.path,'utf8')).replace(`export async function ${method}`,`async function unusedOriginal_${method}`)+`\nexport async function ${method}(){globalThis.__lxBlockedGateways?.push({gateway:'${method}',at:new Date().toISOString()});throw new Error('Provider schema unavailable in the local cache-only readiness harness.');}`,loader:'ts'}))
  b.onLoad({filter:/\/categories\/seller-schema\.service\.ts$/},()=>({contents:`import { loadAmazonSpec } from '../pim/channel-specs/index.js'; export const amazonSellerSpec=(_account,market,type)=>loadAmazonSpec(market,type);`,loader:'js'}))
  b.onLoad({filter:/\/lib\/queue\.ts$/},()=>({contents:`export const redis=null,outboundSyncQueue=null,readCacheQueue=null,searchIndexQueue=null;export const addJobSafely=async()=>({enqueued:false});export const resolveRedisTarget=()=>null;`,loader:'js'}))
  b.onLoad({filter:/\/product-read-cache\.service\.ts$/},()=>({contents:`export const productReadCacheService={refresh:async()=>{},refreshMany:async()=>{},refreshInTransaction:async()=>{}};export const FACE_IMAGE_ORDER_BY=[],FACE_IMAGE_SELECT={};export const pickFaceImage=()=>null;`,loader:'js'}))
 }}]})
const sha=b=>createHash('sha256').update(b).digest('hex')
const files=[];for(const f of Object.keys(result.metafile.inputs).filter(f=>f!=='<stdin>'))files.push({file:f,sha256:sha(await readFile(f))})
await writeFile(`docs/audits/2026-09-12-language-axis/step6/rehearsal-build-${phase}.json`,JSON.stringify({builtAt:new Date().toISOString(),files,substitutions:['Shopify/Etsy gateways refused before credentials/rate limiter/network','seller schema: existing local CategorySchema cache only','queues: no workers or Redis','derived ProductReadCache: no refresh'],runtimeSha256:sha(await readFile(`docs/audits/2026-09-12-language-axis/step6/rehearsal-runtime-${phase}.mjs`))},null,2)+'\n')
console.log(JSON.stringify({inputs:files.length}))
