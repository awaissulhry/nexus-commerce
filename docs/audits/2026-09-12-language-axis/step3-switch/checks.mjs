import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const commands = [
 ['guard', 'npm', ['test','--prefix','apps/api','--','src/services/pim/market-languages-guard.vitest.test.ts']],
 ['shared', 'npm', ['test','--prefix','packages/shared','--','product-media.vitest.test.ts']],
 ['shared-types', 'node_modules/.bin/tsc', ['packages/shared/content-language.ts','packages/shared/product-media.ts','--noEmit','--skipLibCheck','--target','es2022','--module','nodenext','--moduleResolution','nodenext','--strict','--types','node','--typeRoots','node_modules/@types']],
 ['api-types', 'node', ['docs/audits/2026-09-12-language-axis/step3-switch/typecheck.mjs']],
]
const receipts = []
for (const [name, cmd, args] of commands) {
 const load = spawnSync('uptime', [], { encoding: 'utf8' }).stdout
 const match = load.match(/load averages?:\s*([\d.]+)/)
 if (!match || Number(match[1]) > 8) throw new Error(`Load gate refuses ${name}: ${load}`)
 const startedAt = new Date().toISOString()
 const result = spawnSync(cmd, args, { encoding:'utf8', maxBuffer:10*1024*1024 })
 const output = (result.stdout ?? '')+(result.stderr ?? '')
 const receipt = { name, cmd, args, startedAt, finishedAt:new Date().toISOString(), load, exitCode:result.status, output }
 receipts.push(receipt)
 writeFileSync(new URL('checks.json',import.meta.url),JSON.stringify(receipts,null,2)+'\n')
 if (name==='guard') { const start=output.indexOf('{\n  "guard"'), end=output.indexOf('\n}',start)+2; if(start>=0)writeFileSync(new URL('guard-output.json',import.meta.url),output.slice(start,end)+'\n') }
 console.log(JSON.stringify({name,exitCode:result.status,summary:output.split('\n').filter(line=>/Test Files|Tests |clean in|error\(s\)/.test(line))}))
 if (result.status!==0) { console.error(output); process.exitCode=1; break }
}
