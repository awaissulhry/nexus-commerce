/** READ-ONLY: SQS queue policy + counts for the known notifications queue. */
await import('../src/db.js')
const { SQSClient, GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs')
const queueUrl = 'https://sqs.us-east-1.amazonaws.com/084164016829/nexus-sp-api-notifications'
const sqs = new SQSClient({ region: 'us-east-1' })
try {
  const attrs = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['Policy', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'LastModifiedTimestamp'],
  }))
  const a = attrs.Attributes ?? {}
  console.log(`messages=${a.ApproximateNumberOfMessages} inFlight=${a.ApproximateNumberOfMessagesNotVisible} lastModified=${a.LastModifiedTimestamp}`)
  if (a.Policy) {
    const pol = JSON.parse(a.Policy) as { Statement?: Array<Record<string, unknown>> }
    for (const s of pol.Statement ?? []) console.log('stmt:', JSON.stringify(s))
  } else {
    console.log('policy: NONE')
  }
} catch (err) {
  console.log(`GetQueueAttributes failed: ${err instanceof Error ? err.message : String(err)}`)
}
process.exit(0)
