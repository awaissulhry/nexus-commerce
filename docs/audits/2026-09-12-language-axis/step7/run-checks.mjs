import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
const here='docs/audits/2026-09-12-language-axis/step7/'
if(os.loadavg()[0]>8)throw Error('Load above 8; checks did not run')
const prior=JSON.parse(await fs.readFile(here+'api-tests-final.json','utf8'))
const files=[...new Set([...prior.testResults.map(r=>r.name.split('/apps/api/')[1]),'src/services/pim/import-jobs.vitest.test.ts','src/lib/auth/permissions-manifest-order.vitest.test.ts'])]
const checks=[
 {name:'api-tests',cmd:'../../node_modules/.bin/vitest',args:['run',...files,'--reporter=json','--outputFile=../../'+here+'api-tests-complete.json'],cwd:'apps/api'},
 {name:'api-types',cmd:process.execPath,args:['scripts/typecheck-scoped.mjs','apps/api/src/routes/catalog-transfer.routes.ts','apps/api/src/routes/marketplaces.routes.ts','apps/api/src/services/products/products-grid.contract.ts','apps/api/src/services/pim/catalog-transfer-jobs.ts','apps/api/src/services/outbound-sync.service.ts','apps/api/src/lib/auth/permissions-manifest.ts']},
 {name:'web-types',cmd:process.execPath,args:['scripts/typecheck-scoped.mjs','apps/web/src/app/products/next/ProductsNextClient.tsx','apps/web/src/app/products/listing-readiness/page.tsx','apps/web/src/app/products/catalog-transfer/page.tsx']},
 ...['check-raw-primitives-ratchet','ds-conformance-guard','check-token-resolution','check-ag-grid-import-boundary'].map(name=>({name,cmd:process.execPath,args:[`scripts/${name}.mjs`]})),
]
const receipts=[]
for(const check of checks){const start=new Date().toISOString();const r=spawnSync(check.cmd,check.args,{cwd:check.cwd??process.cwd(),encoding:'utf8',maxBuffer:8*1024*1024});const receipt={...check,start,finish:new Date().toISOString(),exitCode:r.status,output:r.stdout+r.stderr,error:r.error?.message};receipts.push(receipt);console.log(JSON.stringify({name:check.name,exitCode:r.status}));await fs.writeFile(here+'checks.json',JSON.stringify(receipts,null,2))}
process.exitCode=receipts.some(r=>r.exitCode!==0)?1:0
