/** VT.F item A2 — the dock reorder's 200 arm on VX-TEST-3AX AMAZON·IT. LOCAL DB only. */
const API = 'http://127.0.0.1:8091'
const ID = 'cmtzci5kf0000njr9f8yhrsxm'
const Q = 'channel=AMAZON&market=IT&accountId=cmothu9bo0000nz01asw6wx8j'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const read = async () => {
  const res = await fetch(`${API}/api/products/${ID}/studio/projection?${Q}`)
  const j = await res.json()
  return { status: res.status, version: j.version, mapping: j.mapping, theme: j.theme?.value ?? null,
    collisions: j.collisions ? { unresolved: j.collisions.unresolved, summary: j.collisions.summary } : null }
}
const patch = async (payload) => {
  const res = await fetch(`${API}/api/products/${ID}/studio/projection?${Q}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'AMAZON', market: 'IT', accountId: 'cmothu9bo0000nz01asw6wx8j', ...payload }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, version: body?.version ?? null, error: body?.error ?? null, message: body?.message ?? null }
}

const before = await read()
console.log('BEFORE      ', JSON.stringify(before))

const A = [{ axisKey: 'Colore', target: 'color', order: 0 }, { axisKey: 'Taglia', target: 'special_size_type', order: 1 }, { axisKey: 'Fit Type', target: 'fit_type', order: 2 }]
const B = [{ axisKey: 'Fit Type', target: 'fit_type', order: 0 }, { axisKey: 'Colore', target: 'color', order: 1 }, { axisKey: 'Taglia', target: 'special_size_type', order: 2 }]

console.log('\nSTEP 1 request  mapping =', JSON.stringify(A))
const r1 = await patch({ expectedVersion: before.version, mapping: A })
console.log('STEP 1 response', JSON.stringify(r1))
await sleep(8000)
const a1 = await read(); console.log('STEP 1 read-back after 8s', JSON.stringify(a1))

console.log('\nSTEP 2 (THE ARM) reorder =', JSON.stringify(B.map((m) => m.axisKey)))
const r2 = await patch({ expectedVersion: a1.version, mapping: B })
console.log('STEP 2 response', JSON.stringify(r2))
await sleep(8000)
const a2 = await read(); console.log('STEP 2 read-back after 8s', JSON.stringify(a2))

console.log('\nSTEP 3 RESTORE mapping to all-null targets')
const r3 = await patch({ expectedVersion: a2.version, mapping: [] })
console.log('STEP 3 response', JSON.stringify(r3))
await sleep(8000)
const a3 = await read(); console.log('STEP 3 read-back after 8s', JSON.stringify(a3))

console.log('\nVERDICT')
console.log('  version walk       :', [before.version, a1.version, a2.version, a3.version].join(' → '))
console.log('  step2 order landed  :', JSON.stringify(a2.mapping.map((m) => m.axisKey)), '=== expected', JSON.stringify(B.map((m) => m.axisKey)), '→', JSON.stringify(a2.mapping.map((m) => m.axisKey)) === JSON.stringify(B.map((m) => m.axisKey)))
console.log('  targets survived    :', JSON.stringify(a2.mapping.map((m) => m.target)))
console.log('  collisions before/1/2/3:', before.collisions?.unresolved, a1.collisions?.unresolved, a2.collisions?.unresolved, a3.collisions?.unresolved)
console.log('  restored to BEFORE  : mapping targets all null =', a3.mapping.every((m) => m.target === null), '· summary equal =', a3.collisions?.summary === before.collisions?.summary)
