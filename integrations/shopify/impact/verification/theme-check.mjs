import { createRequire } from 'node:module'
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const require = createRequire('/tmp/nexus-impact-verification/package.json')
const { check } = require('@shopify/theme-check-node')
const output = resolve(process.argv[2] ?? 'output/shopify-impact-2026-09-08')
const theme = resolve(output, 'theme')
const offenses = await check(theme)
writeFileSync(resolve(output, 'theme-check.json'), JSON.stringify(offenses, null, 2))
const changed = new Set(JSON.parse(readFileSync(resolve(output, 'changes.json'))).changes.map(c => c.file))
const relevant = offenses.filter(o => changed.has(o.uri.replace(`file://${theme}/`, '')))
console.log(JSON.stringify({ total: offenses.length, changedFiles: relevant.map(o => ({ file: o.uri.replace(`file://${theme}/`, ''), check: o.check, message: o.message, severity: o.severity, start: o.start })) }, null, 2))
