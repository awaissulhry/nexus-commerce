/** VT.F2 — the state for reading (c): a real 2-segment Amazon theme on the 3-axis fixture → `⚠ 1 dropped`. */
const API = 'http://127.0.0.1:8091'
const ID = 'cmtzoenko0000nju8dbbrx22h'
const Q = 'channel=AMAZON&market=IT&accountId=cmothu9bo0000nz01asw6wx8j'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = async () => {
  const r = await fetch(`${API}/api/products/${ID}/studio/projection?${Q}`); const j = await r.json()
  return { status: r.status, version: j.version, theme: j.theme?.value ?? null,
    axes: (j.mapping ?? []).map(m => [m.axisKey, m.target]), dropped: j.dropped ?? null,
    collisions: j.collisions ? { unresolved: j.collisions.unresolved, summary: j.collisions.summary } : null }
}
const b = await read(); console.log('BEFORE', JSON.stringify(b))
const res = await fetch(`${API}/api/products/${ID}/studio/projection?${Q}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ channel: 'AMAZON', market: 'IT', accountId: 'cmothu9bo0000nz01asw6wx8j', expectedVersion: b.version,
    theme: 'COLOR/SIZE', mapping: [{ axisKey: 'Colore', target: 'color', order: 0 }, { axisKey: 'Taglia', target: 'size', order: 1 }] }) })
console.log('PATCH', res.status, JSON.stringify(await res.json().catch(() => null)).slice(0, 240))
await sleep(8000)
console.log('AFTER @8s', JSON.stringify(await read()))
