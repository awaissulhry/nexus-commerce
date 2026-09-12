import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const require = createRequire('/tmp/nexus-impact-verification/package.json')
const { check } = require('@shopify/theme-check-node')
const JSZip = (await import('jszip')).default
const { readFileSync } = await import('node:fs')
const archive = await JSZip.loadAsync(readFileSync(process.argv[2]))
const root = '/tmp/nexus-impact-original'
for (const [name, file] of Object.entries(archive.files)) { if (file.dir) continue; const target = resolve(root, name); if (!target.startsWith(root + '/')) throw Error('Unsafe zip'); mkdirSync(resolve(target, '..'), {recursive:true}); writeFileSync(target, await file.async('nodebuffer')) }
const offenses = await check(root)
writeFileSync('output/shopify-impact-2026-09-08/original-theme-check.json', JSON.stringify(offenses,null,2))
console.log(JSON.stringify({ total: offenses.length, errors: offenses.filter(o => o.severity === 0).map(o => ({ file:o.uri, check:o.check, message:o.message })) },null,2))
