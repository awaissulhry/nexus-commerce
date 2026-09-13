/** VT.F2 — step 4: `reset: true` clears the coordinate's override, then the state for reading (c). */
const API = 'http://127.0.0.1:8091'
const ID = 'cmtzoenko0000nju8dbbrx22h'
const Q = 'channel=AMAZON&market=IT&accountId=cmothu9bo0000nz01asw6wx8j'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = async () => {
  const r = await fetch(`${API}/api/products/${ID}/studio/projection?${Q}`); const j = await r.json()
  return { status: r.status, version: j.version, order: (j.mapping ?? []).map(m => m.axisKey), targets: (j.mapping ?? []).map(m => m.target), theme: j.theme?.value ?? null, dropped: j.dropped ?? null, collisions: j.collisions?.unresolved ?? null }
}
const patch = async (payload) => {
  const r = await fetch(`${API}/api/products/${ID}/studio/projection?${Q}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'AMAZON', market: 'IT', accountId: 'cmothu9bo0000nz01asw6wx8j', ...payload }) })
  const b = await r.json().catch(() => null)
  return { status: r.status, version: b?.version ?? null, error: b?.error ?? null, message: b?.message ?? null }
}
const b0 = await read(); console.log('BEFORE RESET ', JSON.stringify(b0))
console.log('RESET        ', JSON.stringify(await patch({ expectedVersion: b0.version, reset: true })))
await sleep(8000)
const a0 = await read(); console.log('RESET @8s    ', JSON.stringify(a0))
