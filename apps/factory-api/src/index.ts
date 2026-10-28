import { buildApp } from './core/app'
import { loadFactoryEnv } from './env'

// The env loader runs first: it refuses a wrong environment before anything opens a connection.
const env = loadFactoryEnv()
const app = buildApp({ logger: { level: env.FACTORY_ENV === 'test' ? 'warn' : 'info' } })

try {
  await app.listen({ host: env.FACTORY_HOST, port: env.FACTORY_PORT })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
