# Amazon Marketing Stream (AMS) — activation (AME.9)

AMS pushes **near-real-time hourly** ad performance (traffic + conversion) to an
AWS destination you own. It powers genuine intraday bidding + dayparting
(AME.10) — the market edge. Until activated, the cron/daily reports are the
fallback and the hourly table stays empty.

## What you provision (one-time, in your AWS account)

1. **A destination** Amazon can write to — either:
   - an **SQS** queue, or
   - a **Kinesis Firehose** delivery stream (→ S3/Redshift if you also want a lake).
2. **An IAM resource policy** granting the Amazon Ads AMS principal permission to
   `sqs:SendMessage` (or `firehose:PutRecord*`) to that destination. Amazon's
   AMS docs list the exact principal/account to trust per region (EU/NA/FE).
3. Note the destination **ARN** (e.g. `arn:aws:sqs:eu-west-1:<acct>:nexus-ams`).

## What you configure on Nexus

Set the env var on the API service (Railway):

```
NEXUS_AMS_DESTINATION_ARN=arn:aws:sqs:eu-west-1:<acct>:nexus-ams
```

## Activate the subscriptions

Once the ARN is set, create the subscriptions (sp-traffic + sp-conversion):

```
curl -X POST $API/api/advertising/marketing-stream/subscriptions \
  -H 'Content-Type: application/json' -d '{"allDatasets": true}'
```

- `GET  /api/advertising/marketing-stream/status` → `{configured, mode, hourlyRows, lastReportedAt}`
- `GET  /api/advertising/marketing-stream/subscriptions` → live list
- `POST /api/advertising/marketing-stream/subscriptions` → `{allDatasets:true}` or `{dataSetId, destinationArn?, notes?}`
- `DELETE /api/advertising/marketing-stream/subscriptions/:id`

## How messages reach Nexus

Point your destination's consumer (an SQS poller / Firehose http endpoint / Lambda)
at `POST /api/advertising/marketing-stream/ingest` with `{messages:[...]}`. The
`ingestMarketingStream` handler accumulates them into the performance tables. A
direct HTTPS-delivery destination can POST there straight away.

## Verify it's live

After ~1 hour of delivery: `status.hourlyRows > 0` and `lastReportedAt` is recent.
Then AME.10 (real dayparting) reads true hour×weekday conversion patterns.
