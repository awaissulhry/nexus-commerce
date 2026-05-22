#!/usr/bin/env node
/**
 * RT.2 verifier — exercises the dlq-monitor poll path against the
 * configured AWS DLQ (read-only) and confirms the sync.dlq.threshold
 * event would fire.
 *
 * Reports:
 *   1. DLQ env wiring (queue URL + threshold + region)
 *   2. Live DLQ depth via SQS GetQueueAttributes
 *   3. Whether the threshold would trigger an alert right now
 *   4. Main queue depth for context
 *
 * Doesn't actually publish to the event bus — that needs the API
 * process. Run this from your laptop with AWS creds in .env to
 * confirm the SQS path is reachable before relying on the cron.
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const dlqUrl = process.env.AMAZON_SQS_DLQ_URL
const mainUrl = process.env.AMAZON_SQS_QUEUE_URL
const accessKey = process.env.AWS_ACCESS_KEY_ID
const secretKey = process.env.AWS_SECRET_ACCESS_KEY
const threshold = Number(process.env.NEXUS_DLQ_THRESHOLD ?? '1')

const maskUrl = (s) => (s ? s.replace(/\/\d{10,}/g, '/<accountId>') : null)

console.log('\n=== 1. DLQ env wiring ===')
console.log({
  AMAZON_SQS_DLQ_URL: maskUrl(dlqUrl) ?? '(unset — cron will be a no-op)',
  AMAZON_SQS_QUEUE_URL: maskUrl(mainUrl) ?? '(unset)',
  NEXUS_DLQ_THRESHOLD: threshold,
  AWS_ACCESS_KEY_ID: accessKey ? '(set)' : '(unset)',
})

if (!dlqUrl) {
  console.log(
    '\nDLQ URL not configured. The dlq-monitor cron will skip on boot.\nSet AMAZON_SQS_DLQ_URL once the DLQ is provisioned in AWS.',
  )
  process.exit(0)
}
if (!accessKey || !secretKey) {
  console.log('\nAWS credentials missing — cannot probe DLQ.')
  process.exit(1)
}

const { SQSClient, GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs')
const region =
  process.env.AWS_REGION ??
  dlqUrl.match(/sqs\.([^.]+)\.amazonaws\.com/)?.[1] ??
  'us-east-1'
const client = new SQSClient({
  region,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
})

async function depthOf(url) {
  try {
    const r = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'QueueArn'],
      }),
    )
    return {
      depth: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0),
      arn: r.Attributes?.QueueArn ?? null,
    }
  } catch (e) {
    return { depth: null, arn: null, error: e?.message ?? String(e) }
  }
}

console.log('\n=== 2. Live DLQ depth ===')
const dlq = await depthOf(dlqUrl)
console.log(dlq)

console.log('\n=== 3. Would the threshold trigger? ===')
if (dlq.depth === null) {
  console.log('Could not read DLQ depth (see error above) — cron tick would log + skip.')
} else if (dlq.depth >= threshold) {
  console.log(
    `YES — depth ${dlq.depth} ≥ threshold ${threshold}. Cron would emit sync.dlq.threshold.`,
  )
} else {
  console.log(
    `No — depth ${dlq.depth} < threshold ${threshold}. Banner stays hidden.`,
  )
}

if (mainUrl) {
  console.log('\n=== 4. Main queue depth (context) ===')
  console.log(await depthOf(mainUrl))
}
