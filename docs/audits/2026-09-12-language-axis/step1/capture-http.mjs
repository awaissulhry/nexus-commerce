/** Read-only HTTP comparison on the existing local XAVIA/GALE family. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
const phase = process.argv[2]
assert.ok(['before', 'after'].includes(phase))
const baseline = JSON.parse(await readFile(new URL('./local-before.json', import.meta.url)))
assert.ok(baseline.family.ids.length > 0)
const rows = []
for (const id of baseline.family.ids) {
  const response = await fetch(`http://127.0.0.1:8091/api/products/${id}/global`, { signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200, `Global GET failed for ${id}: ${response.status}`)
  const body = await response.json()
  assert.equal(body.productId, id)
  rows.push({ id, status: response.status, languages: Object.keys(body.locales), fields: Object.fromEntries(Object.entries(body.locales).flatMap(([language, values]) => Object.entries(values).map(([field, value]) => [`${language}.${field}`, createHash('sha256').update(JSON.stringify(value)).digest('hex')]))), other: createHash('sha256').update(JSON.stringify({ ...body, locales: undefined })).digest('hex') })
}
const result = { at: new Date().toISOString(), phase, endpoint: 'http://127.0.0.1:8091/api/products/:id/global', familyRows: rows.length, rows }
if (phase === 'after') {
  const before = JSON.parse(await readFile(new URL('./http-before.json', import.meta.url)))
  result.differences = rows.flatMap(row => {
    const prior = before.rows.find(value => value.id === row.id)
    assert.ok(prior)
    return [...new Set([...Object.keys(prior.fields), ...Object.keys(row.fields)])].filter(field => prior.fields[field] !== row.fields[field]).map(field => ({ id: row.id, field, before: prior.fields[field] ?? null, after: row.fields[field] ?? null }))
  })
  assert.ok(rows.every(row => before.rows.find(prior => prior.id === row.id).other === row.other), 'Unrelated global fields changed.')
}
await writeFile(new URL(`./http-${phase}.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ phase, at: result.at, familyRows: rows.length, differences: result.differences }, null, 2))
