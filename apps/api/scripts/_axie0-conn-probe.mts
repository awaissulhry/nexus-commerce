const { default: p } = await import('../src/db.js')
const rows = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT "profileId", marketplace, region, mode, "isActive",
          "createdAt"::text AS created, "updatedAt"::text AS updated,
          "lastVerifiedAt"::text AS verified, "writesEnabledAt"::text AS writes,
          ("credentialsEncrypted" IS NOT NULL) AS has_creds
   FROM "AmazonAdsConnection" ORDER BY "createdAt"`)
console.log(JSON.stringify(rows, null, 2))
await p.$disconnect()
