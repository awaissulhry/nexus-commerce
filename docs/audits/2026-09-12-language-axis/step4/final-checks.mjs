import fs from 'node:fs'
import {spawnSync} from 'node:child_process'
const root='docs/audits/2026-09-12-language-axis/step4/'
const load=spawnSync('uptime',[],{encoding:'utf8'}).stdout
if(Number(load.match(/load averages?:\s*([\d.]+)/)?.[1]??Infinity)>8)throw new Error(load)
const scope=JSON.parse(fs.readFileSync(root+'scope.json'))
const files=scope.filter(f=>/\.tsx?$/.test(f)&&fs.existsSync(f)&&!f.startsWith('packages/'))
files.push('apps/api/src/services/pim/information-database.vitest.test.ts')
const r=spawnSync('node',['scripts/typecheck-scoped.mjs',...files],{encoding:'utf8',maxBuffer:10*1024*1024})
fs.writeFileSync(root+'final-types.log',(r.stdout??'')+(r.stderr??''))
fs.writeFileSync(root+'typecheck-receipt.json',JSON.stringify({at:new Date().toISOString(),load,files,exitCode:r.status},null,2)+'\n')
console.log(r.stdout);process.exitCode=r.status
