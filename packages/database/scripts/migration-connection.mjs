/** Migration credentials never flow back into the runtime connection. */
export function migrationConnection(env = process.env) {
  if (env.MIGRATION_DATABASE_URL !== undefined && !env.MIGRATION_DATABASE_URL.trim()) {
    throw new Error('MIGRATION_DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (env.NODE_ENV === 'production' && !env.MIGRATION_DATABASE_URL) {
    throw new Error('MIGRATION_DATABASE_URL is required for production migrations')
  }
  const value = env.MIGRATION_DATABASE_URL || env.DATABASE_URL
  if (!value) throw new Error('Migration PostgreSQL connection is not set')
  let url
  try { url = new URL(value) } catch { throw new Error('Migration connection must be a valid PostgreSQL URL') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Migration connection must be a valid PostgreSQL URL')
  }
  // Advisory migration locks require a direct session. Change only Neon's
  // endpoint hostname; a password, database or query may also contain '-pooler'.
  if (url.hostname.endsWith('.neon.tech')) {
    url.hostname = url.hostname.replace(/-pooler(?=\.)/, '')
  }
  return url.toString()
}
