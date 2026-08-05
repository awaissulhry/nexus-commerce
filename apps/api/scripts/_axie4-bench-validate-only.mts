/** Validate-only, fresh process, file already on disk — the honest memory number. */
import { readFileSync, statSync } from 'node:fs'
import { validateBulksheet } from '../src/services/advertising/bulksheet/import-validate.js'
const path = process.argv[2]!
const rssBefore = process.memoryUsage().rss
const buf = readFileSync(path)
let peak = 0
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 50)
const t = Date.now()
const res = await validateBulksheet(buf)
const ms = Date.now() - t
clearInterval(timer)
peak = Math.max(peak, process.memoryUsage().rss)
console.log(`file        ${(statSync(path).size/1024/1024).toFixed(1)} MB`)
console.log(`rows        ${res.counts.total.toLocaleString()}  errors=${res.counts.errors.toLocaleString()}`)
console.log(`elapsed     ${(ms/1000).toFixed(2)}s  (${Math.round(res.counts.total/ms*1000).toLocaleString()} rows/sec)`)
console.log(`RSS before  ${(rssBefore/1024/1024).toFixed(0)} MB`)
console.log(`RSS peak    ${(peak/1024/1024).toFixed(0)} MB`)
console.log(`RSS delta   ${((peak-rssBefore)/1024/1024).toFixed(0)} MB`)
