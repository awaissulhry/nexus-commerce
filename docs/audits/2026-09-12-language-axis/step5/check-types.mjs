import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const load=spawnSync('uptime',[],{encoding:'utf8'}).stdout
if(Number(load.match(/load averages?:\s*([\d.]+)/)?.[1])>8)throw new Error('Load over 8')
const files=JSON.parse(fs.readFileSync(new URL('scope.json',import.meta.url))).filter(f=>/\.tsx?$/.test(f)&&!f.endsWith('/index.ts')&&fs.existsSync(f))
const r=spawnSync(process.execPath,['scripts/typecheck-scoped.mjs',...files],{encoding:'utf8',maxBuffer:10e6})
fs.writeFileSync(new URL('types.log',import.meta.url),r.stdout+r.stderr);fs.writeFileSync(new URL('types.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),load,files,exitCode:r.status},null,2)+'\n');console.log(r.stdout+r.stderr);process.exit(r.status??1)
