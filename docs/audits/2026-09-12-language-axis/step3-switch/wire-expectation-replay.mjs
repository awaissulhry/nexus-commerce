/** Offline replay of the one captured comparator error. No database, environment or provider access. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { projectCellValue } from './shadow-runtime.mjs'
const sha = value => createHash('sha256').update(value).digest('hex')
const read = name => readFile(new URL(name, import.meta.url))
const json = async name => JSON.parse(await read(name))
const write = (name, value) => writeFile(new URL(name, import.meta.url), JSON.stringify(value,null,2)+'\n')
const report = await json('measured-production-shadow.json')
const details = JSON.parse(gunzipSync(await read('measured-production-diffs.json.gz')))
const before = await json('before.json')
const projector = 'apps/api/src/services/pim/sheet-values.ts'
assert.equal(await readFile(projector,'utf8'), before[projector].content, 'The established wire projector must be byte-identical to pre-switch.')
const applicationFiles = report.build.files.filter(row=>/^(apps|packages)\//.test(row.file))
for (const row of applicationFiles) assert.equal(sha(await readFile(row.file)), row.sha256, `Application reader changed after measurement: ${row.file}`)
assert.equal(report.totalCompared, 1171843)
assert.equal(report.totalDiffs, 1)
assert.equal(details.diffs.length, 1)
assert.equal(report.acceptedReceipt.expected, 14033)
assert.equal(report.acceptedReceipt.checked, 14033)
assert.deepEqual(report.acceptedReceipt.missing, [])
assert.deepEqual(report.acceptedReceipt.diffs, [])
const row = details.diffs[0]
assert.equal(row.reader, 'sheet-wire'); assert.equal(row.field, 'bulletPoints'); assert.equal(row.language, 'it')
assert.equal(row.sku, 'GALE-JACKET-BLACK-MEN-XL'); assert.equal(row.expected.value.length, 5); assert.equal(row.expected.value[3], '')
const expectedWire = projectCellValue({ shape:'list' }, row.expected.value)
assert.deepEqual(row.actual.value, expectedWire)
assert.equal(row.actual.language, row.expected.language)
assert.equal(projectCellValue({ shape:'list' }, row.expected.value.filter((_, i)=>i!==0)).length, 3, 'A non-empty loss must still differ.')
assert.notDeepEqual(row.actual.value, projectCellValue({ shape:'list' }, row.expected.value.filter((_, i)=>i!==0)))
assert.deepEqual(projectCellValue({ shape:'list' }, ['A','','C']), ['A','C'])
assert.equal(projectCellValue({ slot:{ index:2, of:'bulletPoints' } }, ['A','','C']), null)
const counts = report.counts.map(count => count.reader===row.reader && count.field===row.field && count.language===row.language ? {...count, valueDiffs:count.valueDiffs-1,diffs:count.diffs-1}:count)
assert.equal(counts.reduce((n,row)=>n+row.diffs,0),0)
const receipt = { at:new Date().toISOString(), method:'Offline replay of captured observation against byte-identical pre-switch wire projector; no production rerun',
 originalSnapshot:report.transaction.snapshot_at, originalGate:report.gate, originalDiffs:report.totalDiffs,
 inputSha256:{report:sha(await read('measured-production-shadow.json')),details:sha(await read('measured-production-diffs.json.gz')),projector:sha(await readFile(projector))},
 applicationReaderHashesUnchanged:applicationFiles.length, reader:row.reader, sku:row.sku, field:row.field, language:row.language,
 rawAcceptedSlots:5, projectedWireItems:4, omittedSlot:'4 (empty string)', valueOrLanguageChanges:0, correctedDiffs:0, totalCompared:report.totalCompared,
 positiveControls:{nonEmptyLossRejected:true,emptySlotRetainsNull:true,listProjectionUnchanged:true}, gate:'PASS — accepted next values with unchanged sheet wire projection', counts }
await write('wire-expectation-replay.json',receipt)
await write('verified-counts-by-field-language.json',counts)
console.log(JSON.stringify({...receipt,counts:undefined},null,2))
