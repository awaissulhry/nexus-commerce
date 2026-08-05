/** RT.3 — destination recycle attempt 2: try DELETE via both region endpoints. */
await import('../src/db.js')
const { amazonSpApiClient } = await import('../src/clients/amazon-sp-api.client.js')
const token = await amazonSpApiClient.getGrantlessToken('sellingpartnerapi::notifications')
const DEST = '3b1a4686-709b-4ea1-958f-072efb231ef2'
const SQS_ARN = 'arn:aws:sqs:us-east-1:084164016829:nexus-sp-api-notifications'

const call = async (slug: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`https://sellingpartnerapi-${slug}.amazon.com${path}`, {
    method,
    headers: { 'x-amz-access-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, text: text.slice(0, 250) }
}

for (const slug of ['na', 'eu', 'fe']) {
  const del = await call(slug, 'DELETE', `/notifications/v1/destinations/${DEST}`)
  console.log(`DELETE via ${slug}: HTTP ${del.status} ${del.text}`)
  if (del.status === 200 || del.status === 204) break
}

const list = await call('eu', 'GET', '/notifications/v1/destinations')
console.log(`destinations after: ${list.text}`)

const created = await call('eu', 'POST', '/notifications/v1/destinations', {
  name: 'nexus-sp-api-notifications',
  resourceSpecification: { sqs: { arn: SQS_ARN } },
})
console.log(`CREATE via eu: HTTP ${created.status} ${created.text}`)
process.exit(0)
