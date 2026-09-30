/** This fixture may connect only to the lane's private PostgreSQL copy. Never load a repository .env. */
export function privateSheetDatabaseConfig(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error('Private sheet test database required') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      url.port !== '55530' || url.pathname !== '/nexus_pse_test') throw new Error('Private sheet test database required')
  // pg accepts query overrides such as ?host= and ?port=. Never forward the checked URL
  // as a connection string. Explicit targets also override PG* environment defaults.
  return { host: '127.0.0.1', port: 55530, database: 'nexus_pse_test',
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false }
}
