import { randomUUID } from 'node:crypto'
import { openFactoryDatabase } from '@nexus/factory-db'
import { callerFor } from '../../../core/command'
import { loadFactoryEnv } from '../../../env'
import { activeTenants, systemContext } from '../../outbox/system'
import { processFiles } from '../service'
import { putSeedFileBytes } from './seed-bytes'

/**
 * `npm run seed:files -w @nexus/factory-api` (B-W2b-F59): after `npm run seed -w @nexus/factory-db`, puts the bytes of every
 * seeded file in this stack's store (seed-bytes.ts), for every active tenant, through the process's files runtime: the FAKE
 * R2 account's local folder (FACTORY_LOCAL_FILES_DIR, else the default folder named after FACTORY_QUEUE_PREFIX). The same
 * apps/factory-api settings as the API's (FACTORY_DATABASE_URL, FACTORY_REDIS_URL for the gateway's limits, …), so it fills
 * the folder the API reads. FACTORY_ENV local or test only: staging and production have no seed and no local folder.
 */

function refuse(message: string): never {
  console.error(`seed:files: ${message}`)
  process.exit(1)
}

const env = (() => {
  try {
    return loadFactoryEnv()
  } catch (error) {
    return refuse((error as Error).message)
  }
})()
if (env.FACTORY_ENV !== 'local' && env.FACTORY_ENV !== 'test') refuse(`FACTORY_ENV=${env.FACTORY_ENV}: the seeded files' bytes go to a local test server's store only.`)

const database = await openFactoryDatabase({ connectionString: env.FACTORY_DATABASE_URL, pool: { max: 2 } })
try {
  const files = processFiles()
  if (!files.local) refuse('this process has no local file store.')
  for (const tenantId of await activeTenants(database)) {
    const outcome = await putSeedFileBytes(files, callerFor(database, systemContext(tenantId, `seed-files-${randomUUID()}`)))
    console.log(`seed:files: tenant ${tenantId}: ${outcome.written} file(s) and ${outcome.thumbnails} stripped cop(ies) put in ${files.local.root}; ${outcome.notSeeded} other file(s) left alone`)
  }
} catch (error) {
  console.error(`seed:files: ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  await database.close()
}
process.exit(process.exitCode ?? 0)
