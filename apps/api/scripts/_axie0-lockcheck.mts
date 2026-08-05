const { default: p } = await import('../src/db.js')
const rows = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT l.pid, a.state, a.application_name, a.query_start::text AS started,
          left(a.query, 60) AS q
     FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory'`)
console.log('HOLDERS', JSON.stringify(rows, null, 1))
await p.$disconnect()
