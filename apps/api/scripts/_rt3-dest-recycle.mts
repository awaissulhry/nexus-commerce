/**
 * RT.3 — recycle the SP-API notifications DESTINATION (grantless ops only).
 *
 * Everything in the pipe verifies correct (subs → dest → queue policy) yet
 * ZERO messages have ever arrived for ANY type — the destination registration
 * is defunct. Deleting + recreating it re-validates SendMessage NOW and
 * re-registers delivery. The deployed boot self-heal then finds every
 * subscription pointing at the OLD destinationId ('foreign') and
 * deletes+recreates them against the new one on next boot.
 *
 * Grantless deleteDestination/createDestination — no seller token needed.
 */
await import('../src/db.js')
const { amazonSpApiClient } = await import('../src/clients/amazon-sp-api.client.js')

const SCOPE = 'sellingpartnerapi::notifications'
const SLUG = 'eu'
const SQS_ARN = 'arn:aws:sqs:us-east-1:084164016829:nexus-sp-api-notifications'
const token = await amazonSpApiClient.getGrantlessToken(SCOPE)

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`https://sellingpartnerapi-${SLUG}.amazon.com${path}`, {
    method,
    headers: { 'x-amz-access-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const list = await call('GET', '/notifications/v1/destinations')
const dests = (list.body?.payload ?? []) as Array<{ destinationId: string; name?: string; resource?: { sqs?: { arn?: string } } }>
console.log(`destinations before: ${dests.length}`)
for (const d of dests) {
  console.log(`  deleting ${d.destinationId} (${d.name}, ${d.resource?.sqs?.arn})`)
  const del = await call('DELETE', `/notifications/v1/destinations/${d.destinationId}`)
  console.log(`    → HTTP ${del.status}`)
}

const created = await call('POST', '/notifications/v1/destinations', {
  name: 'nexus-sp-api-notifications',
  resourceSpecification: { sqs: { arn: SQS_ARN } },
})
console.log(`create new destination → HTTP ${created.status}`)
console.log(JSON.stringify(created.body?.payload ?? created.body).slice(0, 300))
process.exit(0)
