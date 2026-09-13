import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const load = spawnSync('uptime',[],{encoding:'utf8'}).stdout
if (Number(load.match(/load averages?:\s*([\d.]+)/)?.[1] ?? Infinity)>8) throw new Error(load)
const here = new URL('.', import.meta.url)
const previous = JSON.parse(readFileSync(new URL('final-api-tests.json',here)))
const files = [...new Set(previous.testResults.map(row=>row.name))]
const startedAt = new Date().toISOString()
const result = spawnSync('npm',['test','--prefix','apps/api','--',...files,'--reporter=default','--reporter=json','--outputFile.json=../../docs/audits/2026-09-12-language-axis/step3-switch/final-api-tests.json'],{encoding:'utf8',maxBuffer:10*1024*1024})
const output = (result.stdout??'')+(result.stderr??'')
writeFileSync(new URL('final-api-tests.log',here),output)
writeFileSync(new URL('final-api-test-command.json',here),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),files,load,exitCode:result.status},null,2)+'\n')
console.log(JSON.stringify({exitCode:result.status,summary:output.split('\n').filter(line=>/Test Files|Tests |FAIL|Error:/.test(line))}))
process.exitCode=result.status??1
