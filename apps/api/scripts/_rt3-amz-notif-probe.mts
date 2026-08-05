/** READ-ONLY: SP-API notifications ground truth — destinations, subscriptions, queue policy. */
await import('../src/db.js') // env bootstrap
const { amazonSpApiClient } = await import('../src/clients/amazon-sp-api.client.js')
const { NEXUS_SP_API_NOTIFICATION_TYPES } = await import('../src/services/amazon-notifications-boot.service.js')

const SCOPE = 'sellingpartnerapi::notifications'
const token = await amazonSpApiClient.getGrantlessToken(SCOPE)

const listDest = async (slug: string) => {
  const res = await fetch(`https://sellingpartnerapi-${slug}.amazon.com/notifications/v1/destinations`, {
    headers: { 'x-amz-access-token': token },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, payload: (body as { payload?: unknown[] }).payload ?? [] }
}

console.log('== 1. Destinations (grantless) ==')
let sqsArn: string | null = null
for (const slug of ['eu', 'na']) {
  const d = await listDest(slug)
  console.log(`  [${slug}] HTTP ${d.status} — ${ (d.payload as unknown[]).length } destination(s)`)
  for (const dest of d.payload as Array<{ destinationId?: string; name?: string; resource?: { sqs?: { arn?: string } } }>) {
    console.log(`    id=${dest.destinationId} name=${dest.name} sqsArn=${dest.resource?.sqs?.arn}`)
    if (dest.resource?.sqs?.arn) sqsArn = dest.resource.sqs.arn
  }
}

console.log('== 2. Subscriptions (seller token, EU endpoint via client) ==')
for (const t of NEXUS_SP_API_NOTIFICATION_TYPES) {
  try {
    const r = await amazonSpApiClient.request<{ payload?: { subscriptionId?: string; destinationId?: string; payloadVersion?: string } }>(
      'GET',
      `/notifications/v1/subscriptions/${t}`,
    )
    console.log(`  ${t}: subId=${r?.payload?.subscriptionId} destId=${r?.payload?.destinationId}`)
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    console.log(`  ${t}: ${m.slice(0, 110)}`)
  }
}

console.log('== 3. SQS queue attributes ==')
if (!sqsArn) {
  console.log('  no SQS destination found — nothing to inspect')
} else {
  const [, , , region, account, name] = sqsArn.split(':')
  const queueUrl = `https://sqs.${region}.amazonaws.com/${account}/${name}`
  console.log(`  arn=${sqsArn}`)
  console.log(`  url=${queueUrl}`)
  const { SQSClient, GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs')
  const sqs = new SQSClient({ region })
  try {
    const attrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['Policy', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'LastModifiedTimestamp'],
    }))
    const a = attrs.Attributes ?? {}
    console.log(`  messages=${a.ApproximateNumberOfMessages} inFlight=${a.ApproximateNumberOfMessagesNotVisible}`)
    if (a.Policy) {
      const pol = JSON.parse(a.Policy) as { Statement?: Array<{ Effect?: string; Principal?: unknown; Action?: unknown; Condition?: unknown }> }
      console.log(`  policy statements: ${pol.Statement?.length ?? 0}`)
      for (const s of pol.Statement ?? []) {
        console.log(`    effect=${s.Effect} principal=${JSON.stringify(s.Principal)} action=${JSON.stringify(s.Action)} condition=${JSON.stringify(s.Condition ?? null)}`)
      }
    } else {
      console.log('  policy: NONE — SP-API deliveries have no permission to SendMessage!')
    }
  } catch (err) {
    console.log(`  GetQueueAttributes failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
process.exit(0)
