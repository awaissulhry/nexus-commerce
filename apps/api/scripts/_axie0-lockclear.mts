const { default: p } = await import('../src/db.js')
const rows = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT l.pid, l.objid, a.state, a.application_name,
          (now() - a.state_change)::text AS idle_for, left(a.query, 60) AS q
     FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory'`)
console.log('HOLDERS', JSON.stringify(rows, null, 1))
for (const r of rows) {
  // Only ever terminate an IDLE holder of Prisma's migration advisory lock.
  if (r.state === 'idle') {
    const out = await p.$queryRawUnsafe(`SELECT pg_terminate_backend(${Number(r.pid)}) AS killed`)
    console.log('TERMINATED', r.pid, JSON.stringify(out))
  } else {
    console.log('LEFT ALONE (not idle)', r.pid, r.state)
  }
}
await p.$disconnect()
