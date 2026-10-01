/** This fixture may connect only to the lane's private PostgreSQL copy. Never load a repository .env. */
// Exactly these private copies on the private container: the lane database and the final combined round's copy.
const PRIVATE_DATABASES = new Set(['nexus_pse_test', 'nexus_pse_today_03_test'])

export function privateSheetDatabaseConfig(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error('Private sheet test database required') }
  const database = url.pathname.slice(1)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      url.port !== '55530' || !PRIVATE_DATABASES.has(database)) throw new Error('Private sheet test database required')
  // pg accepts query overrides such as ?host= and ?port=. Never forward the checked URL
  // as a connection string. Explicit targets also override PG* environment defaults.
  return { host: '127.0.0.1', port: 55530, database,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false }
}
