/** VT.F2 — R-VT-13's live arm: an order-only change on a DRAFT Amazon coordinate. LOCAL DB only. */
const API = 'http://127.0.0.1:8091'
const ID = 'cmtzoenko0000nju8dbbrx22h'
const Q = 'channel=AMAZON&market=IT&accountId=cmothu9bo0000nz01asw6wx8j'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = async () => {
  const res = await fetch(`${API}/api/products/${ID}/studio/projection?${Q}`)
  const j = await res.json()
  return { status: res.status, version: j.version,
    order: (j.mapping ?? []).map((m) => m.axisKey), targets: (j.mapping ?? []).map((m) => m.target),
    orderBlock: { writableHere: j.order?.writableHere, reason: j.order?.reason },
    collisions: j.collisions ? j.collisions.unresolved : null }
}
const patch = async (payload) => {
  const res = await fetch(`${API}/api/products/${ID}/studio/projection?${Q}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'AMAZON', market: 'IT', accountId: 'cmothu9bo0000nz01asw6wx8j', ...payload }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, version: body?.version ?? null, error: body?.error ?? null, message: body?.message ?? null }
}
const A = [{ axisKey: 'Colore', target: 'color', order: 0 }, { axisKey: 'Taglia', target: 'size', order: 1 }, { axisKey: 'Fit Type', target: 'style', order: 2 }]
const B = [{ axisKey: 'Fit Type', target: 'style', order: 0 }, { axisKey: 'Colore', target: 'color', order: 1 }, { axisKey: 'Taglia', target: 'size', order: 2 }]

const before = await read(); console.log('BEFORE        ', JSON.stringify(before))
const r1 = await patch({ expectedVersion: before.version, mapping: A })
console.log('STEP 1 PATCH  ', JSON.stringify(r1))
await sleep(8000)
const a1 = await read(); console.log('STEP 1 @8s    ', JSON.stringify(a1))
const r2 = await patch({ expectedVersion: a1.version, mapping: B })
console.log('STEP 2 PATCH (THE ARM, order-only)', JSON.stringify(r2))
await sleep(8000)
const a2 = await read(); console.log('STEP 2 @8s    ', JSON.stringify(a2))
console.log('VERDICT order stored:', JSON.stringify(a2.order), '=== expected', JSON.stringify(B.map(m => m.axisKey)), '→', JSON.stringify(a2.order) === JSON.stringify(B.map(m => m.axisKey)))
console.log('VERDICT targets    :', JSON.stringify(a2.targets))
console.log('VERDICT versions   :', [before.version, a1.version, a2.version].join(' → '))
