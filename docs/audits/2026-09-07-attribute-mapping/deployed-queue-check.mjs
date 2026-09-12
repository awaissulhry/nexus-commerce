/** Read-only Railway configuration/health check. Never prints credential values. */
import { execFile as callback } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
const execFile = promisify(callback)
const report = { checkedAt: new Date().toISOString(), deploymentWrites: 0, endpoints: [] }
let stage = 'configuration'
try {
  const { stdout } = await execFile('railway', ['variable', 'list', '--service', '3c2d76ee-6aae-4869-a240-12c69654b691', '--environment', '5b64d0c0-db90-48c8-b834-75fb3d6ef926', '--project', 'f0b308ff-70c0-446e-a66c-735ba90dc73e', '--json'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  const variables = JSON.parse(stdout)
  const domain = variables.RAILWAY_PUBLIC_DOMAIN
  report.publicDomainConfigured = Boolean(domain)
  report.redisConfigured = Boolean(variables.REDIS_URL || variables.REDIS_HOST)
  if (!domain || !/^[\w.-]+$/.test(domain)) throw new Error('No public API domain is configured')
  report.endpoint = `https://${domain}/api/health`
  const candidates = [domain]
  const { stdout: statusText } = await execFile('railway', ['status', '--json'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  const status = JSON.parse(statusText)
  for (const environment of status.environments?.edges ?? []) {
    if (environment.node.id !== '5b64d0c0-db90-48c8-b834-75fb3d6ef926') continue
    for (const service of environment.node.serviceInstances?.edges ?? []) {
      if (service.node.serviceId !== '3c2d76ee-6aae-4869-a240-12c69654b691') continue
      for (const entry of service.node.domains?.serviceDomains ?? []) if (/^[\w.-]+$/.test(entry.domain)) candidates.push(entry.domain)
    }
  }
  stage = 'health-request'
  for (const host of [...new Set(candidates)]) {
    const endpoint = `https://${host}/api/health`
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) })
      const body = await response.json()
      report.endpoints.push({ endpoint, httpStatus: response.status, status: body.status })
      if (!response.ok) continue
      Object.assign(report, { endpoint, httpStatus: response.status, status: body.status, queueWorkers: body.queueWorkers, dispatchPath: body.dispatchPath, services: body.services,
        queueHealthy: body.queueWorkers === 'enabled' && body.services?.redis === 'connected' })
      break
    } catch (error) { report.endpoints.push({ endpoint, errorType: error?.name, errorCode: error?.cause?.code }) }
  }
  if (!report.queueHealthy) process.exitCode = 1
} catch (error) { report.error = 'Unable to verify deployed queue health; private command output withheld'; report.failedStage = stage; report.errorType = error?.name; report.errorCode = error?.cause?.code; process.exitCode = 1 }
await writeFile('/tmp/nexus-deployed-queue-health.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
