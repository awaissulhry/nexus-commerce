/** AX-ZD.4 — delete the false-positive rows the first live run produced.
 *  Every one is `ourValue IS NULL`, i.e. a column filling in for the first time,
 *  which the fixed diffFields no longer reports at all. */
const { default: p } = await import('../src/db.js')
const before = await p.adDrift.count()
const r = await p.adDrift.deleteMany({ where: { ourValue: null } })
const after = await p.adDrift.count()
console.log(`CLEARED before=${before} deleted=${r.count} after=${after}`)
await p.$disconnect()
