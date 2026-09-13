import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root=process.cwd()
const result=await build({ stdin:{ contents:`
 export { default as prisma } from './apps/api/src/db.ts';
 export { default as products } from './apps/api/src/routes/products.routes.ts';
 export { default as studio } from './apps/api/src/routes/product-studio.routes.ts';
 export { default as formulas } from './apps/api/src/routes/cell-formula.routes.ts';
 export { default as translations } from './apps/api/src/routes/product-translations.routes.ts';
 export { default as global } from './apps/api/src/routes/pim-global.routes.ts';
 export { inDatabaseTransaction } from './apps/api/src/lib/database-context.ts';
 `,resolveDir:root,loader:'ts'},outfile:'docs/audits/2026-09-12-language-axis/step4/rehearsal-runtime.mjs',bundle:true,platform:'node',format:'esm',packages:'external',metafile:true,
 banner:{js:"import { createRequire as lxCreateRequire } from 'node:module'; const require = lxCreateRequire(import.meta.url);"},
 plugins:[{name:'local-rehearsal-boundaries',setup(b){
  b.onLoad({filter:/\/categories\/seller-schema\.service\.ts$/},()=>({contents:`import { loadAmazonSpec } from '../pim/channel-specs/index.js'; export const amazonSellerSpec=(_account,market,type)=>loadAmazonSpec(market,type);`,loader:'js'}))
  b.onLoad({filter:/\/lib\/queue\.ts$/},()=>({contents:`export const redis=null,outboundSyncQueue=null,readCacheQueue=null,searchIndexQueue=null;export const addJobSafely=async()=>({enqueued:false});export const resolveRedisTarget=()=>null;`,loader:'js'}))
  b.onLoad({filter:/\/product-read-cache\.service\.ts$/},()=>({contents:`export const productReadCacheService={refresh:async()=>{},refreshMany:async()=>{},refreshInTransaction:async()=>{}};export const FACE_IMAGE_ORDER_BY=[],FACE_IMAGE_SELECT={};export const pickFaceImage=()=>null;`,loader:'js'}))
 }}]})
const sha=b=>createHash('sha256').update(b).digest('hex')
const files=[];for(const f of Object.keys(result.metafile.inputs).filter(f=>f!=='<stdin>'))files.push({file:f,sha256:sha(await readFile(f))})
await writeFile('docs/audits/2026-09-12-language-axis/step4/rehearsal-build.json',JSON.stringify({builtAt:new Date().toISOString(),files,substitutions:['seller schema: existing local CategorySchema cache only','queues: no workers or Redis','derived ProductReadCache: no refresh'],runtimeSha256:sha(await readFile('docs/audits/2026-09-12-language-axis/step4/rehearsal-runtime.mjs'))},null,2)+'\n')
console.log(JSON.stringify({inputs:files.length}))
