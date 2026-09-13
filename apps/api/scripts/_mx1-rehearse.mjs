/** MX.1 — the write/verb/revert rehearsal on the DISPOSABLE fixture only, through :8091. Every read-back waits ≥ 8 s. */
const BASE = 'http://localhost:8091', ROOT = 'cmtzz15s20001nje768z42poe', S = 'cmtzz15si0003nje7e8peoarx', M = 'cmtzz15st0007nje7orvv5sst'
const out = []
const log = (step, o) => { const line = `${new Date().toISOString().slice(11, 23)} ${step} ${JSON.stringify(o)}`; out.push(line); console.log(line) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const read = async () => (await fetch(`${BASE}/api/products/${ROOT}/studio/matrix`)).json()
const patch = async (cells) => { const r = await fetch(`${BASE}/api/products/${ROOT}/studio/matrix`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cells }) }); return { status: r.status, body: await r.json() } }
const verb = async (body) => { const r = await fetch(`${BASE}/api/products/${ROOT}/studio/matrix/verbs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
const revert = async (id) => { const r = await fetch(`${BASE}/api/products/${ROOT}/studio/matrix/verbs/${id}/revert`, { method: 'POST' }); return { status: r.status, body: await r.json() } }
const cell = (j, row, key) => j.rows.find((r) => r.id === row)?.cells[key]
const brief = (c) => c ? { v: c.version, mode: c.sync?.mode, kind: c.sync?.kind, via: c.sync?.via, intended: c.sync?.intended, held: c.sync?.held, fulf: c.fulfilment && `${c.fulfilment.method}/${c.fulfilment.source}/${c.fulfilment.guard}`, price: c.price && `${c.price.source}/${c.price.value}`, sale: c.sale, queue: c.queue?.state, wQty: c.writable?.syncQty, rQty: c.writeBlockedReason?.syncQty } : null
const readBack = async (label, checks) => { await wait(8500); const j = await read(); log(`READBACK ${label} (≥8.5s)`, checks(j)); return j }

let j = await read(); log('READ0', { rootVersion: j.version, S_EU: brief(cell(j, S, 'AMAZON:EU')), S_DE: brief(cell(j, S, 'AMAZON:DE')) })
const v0 = cell(j, S, 'AMAZON:EU').version

log('PREDICT A', 'pin S AMAZON:EU=7 @v1 → applied v2 expandedTo [AMAZON:IT, AMAZON:DE]; read-back S EU v2 mode PINNED held 7 kind PAUSED, S DE v2')
log('A pin', await patch([{ rowId: S, coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: v0 }]))
j = await readBack('A', (j) => ({ S_EU: brief(cell(j, S, 'AMAZON:EU')), S_DE: brief(cell(j, S, 'AMAZON:DE')), S_IT: brief(cell(j, S, 'AMAZON:IT')) }))

log('PREDICT B', 'same write @stale v1 → conflict carrying v2; nothing written')
log('B stale', await patch([{ rowId: S, coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 9, expectedVersion: v0 }]))
log('PREDICT C', 'parent syncQty → refused "Set on the variants — the parent has no listing of its own", v1')
log('C parent', await patch([{ rowId: ROOT, coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 1, expectedVersion: cell(j, ROOT, 'AMAZON:EU').version }]))
log('PREDICT D', 'pin S at 7 again @v2 → noop v2 (no version spent)')
log('D noop', await patch([{ rowId: S, coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: cell(j, S, 'AMAZON:EU').version }]))
j = await readBack('D', (j) => ({ S_EU_v: cell(j, S, 'AMAZON:EU').version, S_DE_v: cell(j, S, 'AMAZON:DE').version }))

log('PREDICT E', 'price S AMAZON:IT 45 @v2 → applied v3 (IT row only; DE stays v2); read-back IT price override/45, EU cell v3')
log('E price', await patch([{ rowId: S, coordinateKey: 'AMAZON:IT', cell: 'price', value: 45, expectedVersion: cell(j, S, 'AMAZON:IT').version }]))
j = await readBack('E', (j) => ({ S_IT: brief(cell(j, S, 'AMAZON:IT')), S_DE_v: cell(j, S, 'AMAZON:DE').version, S_EU_v: cell(j, S, 'AMAZON:EU').version }))

log('PREDICT F', 'sale S AMAZON:IT {40, 2026-09-14→2026-09-20} @v3 → applied v4; read-back sale carried; then a windowless {39} → refused "A sale needs a start and an end date…" v4')
log('F sale', await patch([{ rowId: S, coordinateKey: 'AMAZON:IT', cell: 'salePrice', value: { value: 40, start: '2026-09-14', end: '2026-09-20' }, expectedVersion: cell(j, S, 'AMAZON:IT').version }]))
j = await readBack('F', (j) => ({ S_IT: brief(cell(j, S, 'AMAZON:IT')) }))
log('F windowless', await patch([{ rowId: S, coordinateKey: 'AMAZON:IT', cell: 'salePrice', value: { value: 39 }, expectedVersion: cell(j, S, 'AMAZON:IT').version }]))

log('PREDICT G', 'fulfilment S AMAZON:EU FBA @v4 → applied v5 expandedTo IT/DE; read-back FBA/set/FBA, kind FBA_EXCLUDED, syncQty held "Amazon-managed"; then FBM @v5 → applied v6, read-back FBM/set/FBM kind PAUSED, product flag back to FBM')
log('G fba', await patch([{ rowId: S, coordinateKey: 'AMAZON:EU', cell: 'fulfilment', value: 'FBA', expectedVersion: cell(j, S, 'AMAZON:EU').version }]))
j = await readBack('G-fba', (j) => ({ S_EU: brief(cell(j, S, 'AMAZON:EU')), S_DE_v: cell(j, S, 'AMAZON:DE').version }))
log('G fbm', await patch([{ rowId: S, coordinateKey: 'AMAZON:EU', cell: 'fulfilment', value: 'FBM', expectedVersion: cell(j, S, 'AMAZON:EU').version }]))
j = await readBack('G-fbm', (j) => ({ S_EU: brief(cell(j, S, 'AMAZON:EU')), S_DE_v: cell(j, S, 'AMAZON:DE').version }))

log('PREDICT H', 'preview adjust-prices −10% on S,M AMAZON:IT → 2 changes S 45→40.5, M 50→45 (note Set here), confirm=confirm, simulated=false; commit with the carried preview → applied 2; read-back S 40.5 override, M 45 override; revert → S 45 override, M master/50, op REVERTED')
const targets = [{ rowId: S, coordinateKey: 'AMAZON:IT' }, { rowId: M, coordinateKey: 'AMAZON:IT' }]
const pv = await verb({ params: { verb: 'adjust-prices', percent: -10 }, targets, commit: false })
log('H preview', { status: pv.status, changes: pv.body.changes?.map((c) => `${c.sku} ${c.fromLabel}→${c.toLabel} ${c.note ?? ''}`), refusals: pv.body.refusals, confirm: pv.body.confirm, simulated: pv.body.simulated, notices: pv.body.notices })
const cm = await verb({ params: { verb: 'adjust-prices' }, targets: pv.body.changes.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey })), commit: true, preview: pv.body })
log('H commit', { status: cm.status, operation: cm.body.operation && { id: cm.body.operation.id, applied: cm.body.operation.applied, refused: cm.body.operation.refused, before: cm.body.operation.before?.length }, results: cm.body.results })
j = await readBack('H-commit', (j) => ({ S_IT: brief(cell(j, S, 'AMAZON:IT')), M_IT: brief(cell(j, M, 'AMAZON:IT')) }))
const rv = await revert(cm.body.operation.id)
log('H revert', { status: rv.status, applied: rv.body.operation?.applied, refused: rv.body.operation?.refused, results: rv.body.results })
j = await readBack('H-revert', (j) => ({ S_IT: brief(cell(j, S, 'AMAZON:IT')), M_IT: brief(cell(j, M, 'AMAZON:IT')) }))
log('H revert again', await revert(cm.body.operation.id))

log('PREDICT I', 'resume-sync S AMAZON:EU (pinned 7, paused) → preview 1 change "Paused (listing) · Pinned → Pinned 7"; commit applied; read-back kind PINNED via null intended 7; pause-sync → read-back PAUSED')
const rp = await verb({ params: { verb: 'resume-sync' }, targets: [{ rowId: S, coordinateKey: 'AMAZON:EU' }], commit: false })
log('I resume preview', { changes: rp.body.changes?.map((c) => `${c.fromLabel}→${c.toLabel} ${c.note ?? ''}`), refusals: rp.body.refusals, notices: rp.body.notices })
const rc = await verb({ params: { verb: 'resume-sync' }, targets: rp.body.changes.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey })), commit: true, preview: rp.body })
log('I resume commit', { status: rc.status, results: rc.body.results, op: rc.body.operation?.id })
j = await readBack('I-resume', (j) => ({ S_EU: brief(cell(j, S, 'AMAZON:EU')), S_DE_v: cell(j, S, 'AMAZON:DE').version }))
const pp = await verb({ params: { verb: 'pause-sync' }, targets: [{ rowId: S, coordinateKey: 'AMAZON:EU' }], commit: false })
const pc = await verb({ params: { verb: 'pause-sync' }, targets: pp.body.changes.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey })), commit: true, preview: pp.body })
log('I pause commit', { status: pc.status, results: pc.body.results })
j = await readBack('I-pause', (j) => ({ S_EU: brief(cell(j, S, 'AMAZON:EU')) }))

log('PREDICT J', 'restore by VALUE: syncMode FOLLOW on S EU → applied (quantity follows the pool = 10 written by the FOLLOW primitive); price S IT → null → applied (master/50); sale clear → applied; read-back matches READ0 shape except versions')
log('J follow', await patch([{ rowId: S, coordinateKey: 'AMAZON:EU', cell: 'syncMode', value: 'FOLLOW', expectedVersion: cell(j, S, 'AMAZON:EU').version }]))
j = await readBack('J-follow', (j) => ({ S_EU: brief(cell(j, S, 'AMAZON:EU')), S_DE_v: cell(j, S, 'AMAZON:DE').version }))
log('J price clear', await patch([{ rowId: S, coordinateKey: 'AMAZON:IT', cell: 'price', value: null, expectedVersion: cell(j, S, 'AMAZON:IT').version }]))
j = await readBack('J-price', (j) => ({ S_IT: brief(cell(j, S, 'AMAZON:IT')) }))
log('J sale clear', await patch([{ rowId: S, coordinateKey: 'AMAZON:IT', cell: 'salePrice', value: { value: null, start: null, end: null }, expectedVersion: cell(j, S, 'AMAZON:IT').version }]))
j = await readBack('J-sale', (j) => ({ S_IT: brief(cell(j, S, 'AMAZON:IT')), S_EU: brief(cell(j, S, 'AMAZON:EU')), M_IT: brief(cell(j, M, 'AMAZON:IT')) }))
require('fs').writeFileSync('/private/tmp/claude-501/-Users-awais-nexus-commerce/d4423145-bc2c-4a4b-8cdc-3b27e091a396/scratchpad/mx1/rehearsal.log', out.join('\n') + '\n')
console.log('DONE')
