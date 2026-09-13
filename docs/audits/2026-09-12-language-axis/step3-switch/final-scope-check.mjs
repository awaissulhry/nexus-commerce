import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const scope = JSON.parse(readFileSync(new URL('scope.json',import.meta.url)))
const load = spawnSync('uptime',[],{encoding:'utf8'}).stdout
if (Number(load.match(/load averages?:\s*([\d.]+)/)?.[1] ?? Infinity)>8) throw new Error(load)
const commands = [
 ['web-types','node',['scripts/typecheck-scoped.mjs','apps/web/src/app/products/[id]/edit/_studio/sheet/channel/types.ts','apps/web/src/app/products/[id]/edit/_studio/sheet/content-wire.vitest.test.ts']],
 ['diff-check','git',['diff','--check','--',...scope]],
]
const receipts=[]
for (const [name,cmd,args] of commands) {
 const startedAt = new Date().toISOString()
 const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:5*1024*1024})
 const receipt={name,cmd,args,startedAt,finishedAt:new Date().toISOString(),load,exitCode:r.status,output:(r.stdout??'')+(r.stderr??'')}
 receipts.push(receipt)
 console.log(JSON.stringify(receipt))
}
writeFileSync(new URL('final-scope-check.json',import.meta.url),JSON.stringify(receipts,null,2)+'\n')
process.exitCode=receipts.some(r=>r.exitCode!==0)?1:0
