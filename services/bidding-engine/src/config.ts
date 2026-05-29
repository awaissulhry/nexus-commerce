import 'dotenv/config'

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env: ${name}`)
  return v
}
function num(name: string, fallback: number): number {
  const v = process.env[name]
  const n = v == null ? NaN : Number(v)
  return Number.isFinite(n) ? n : fallback
}

export type AdsRegion = 'NA' | 'EU' | 'FE'
const ADS_HOST: Record<AdsRegion, string> = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
}

const region = (process.env.AMAZON_ADS_REGION as AdsRegion) || 'EU'

export const config = {
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  queueName: process.env.BIDDING_QUEUE || 'bidding-writes',

  primary: {
    baseUrl: (process.env.PRIMARY_API_URL || '').replace(/\/$/, ''),
    token: process.env.PRIMARY_API_TOKEN || '',
  },

  amazon: {
    region,
    adsHost: ADS_HOST[region],
    lwaClientId: process.env.AMAZON_LWA_CLIENT_ID || '',
    lwaClientSecret: process.env.AMAZON_LWA_CLIENT_SECRET || '',
    refreshToken: process.env.AMAZON_ADS_REFRESH_TOKEN || '',
  },

  worker: {
    concurrency: num('WORKER_CONCURRENCY', 4),
    bucketCapacity: num('PROFILE_BUCKET_CAPACITY', 10),
    bucketRefillPerSec: num('PROFILE_BUCKET_REFILL_PER_SEC', 8),
    dryRun: process.env.BIDDING_DRY_RUN !== '0',
  },

  httpPort: num('HTTP_PORT', 8081),
  logLevel: process.env.LOG_LEVEL || 'info',

  /** Throws early if the service is configured to actually write but is missing creds. */
  assertWritable(): void {
    if (this.worker.dryRun) return
    req('AMAZON_LWA_CLIENT_ID'); req('AMAZON_LWA_CLIENT_SECRET'); req('AMAZON_ADS_REFRESH_TOKEN')
    if (!this.primary.baseUrl) throw new Error('PRIMARY_API_URL required for live mode')
  },
}
