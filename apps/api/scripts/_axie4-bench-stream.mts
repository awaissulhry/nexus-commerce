/** Streaming validate — the memory number that decides whether 100k is honest. */
import { statSync } from 'node:fs'
import { validateBulksheetStreaming } from '../src/services/advertising/bulksheet/import-validate.js'
const path = process.argv[2]!
const rssBefore = process.memoryUsage().rss
let peak = 0
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 50)
let staged = 0
const t = Date.now()
const res = await validateBulksheetStreaming(path, async (batch) => { staged += batch.length })
const ms = Date.now() - t
clearInterval(timer); peak = Math.max(peak, process.memoryUsage().rss)
console.log(`file        ${(statSync(path).size/1024/1024).toFixed(1)} MB`)
console.log(`rows        ${res.counts.total.toLocaleString()}  staged=${staged.toLocaleString()}  errors=${res.counts.errors.toLocaleString()}`)
console.log(`counts      ${JSON.stringify(res.counts)}`)
console.log(`issues      ${res.issues.length.toLocaleString()} truncated=${res.issuesTruncated}`)
console.log(`first issue ${res.issues[0]?.cellAddress} — ${res.issues[0]?.message}`)
console.log(`structural  ${res.structuralError ?? '(none)'}`)
console.log(`elapsed     ${(ms/1000).toFixed(2)}s  (${Math.round(res.counts.total/ms*1000).toLocaleString()} rows/sec)`)
console.log(`RSS peak    ${(peak/1024/1024).toFixed(0)} MB   delta ${((peak-rssBefore)/1024/1024).toFixed(0)} MB`)
