/** Parse the disposable sheet fixture's explicit target without loading any .env file. */
export function sheetFixtureDatabaseConfig(raw) {
  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const database = decodeURIComponent(url.pathname.slice(1))
    const port = Number(url.port || 5432)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(host)
      || !/^[A-Za-z0-9_-]*test[A-Za-z0-9_-]*$/.test(database) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error()
    // pg applies host/port query overrides to connectionString. Supply only the checked parameters,
    // including defaults, so neither the query nor PG* environment variables choose a different target.
    return { host, port, database, user: decodeURIComponent(url.username) || 'postgres', password: decodeURIComponent(url.password), ssl: false }
  } catch {
    throw new Error('A loopback test database is required for the sheet fixture')
  }
}
