/**
 * AX-IE.0 / E4 — READ ONLY. Score the OLD name-regex against Amazon's real
 * targetingType, now that the settings sync has populated it from v3.
 *
 * Old exporter: isAuto = /\bauto|close match|loose match|substitute|complement/i
 * applied to the campaign NAME.
 */
const { default: p } = await import('../src/db.js')
const rows = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT
    count(*)::bigint                                                        AS scored,
    count(*) FILTER (WHERE regex_auto AND "targetingType" = 'MANUAL')::bigint AS wrong_said_auto,
    count(*) FILTER (WHERE NOT regex_auto AND "targetingType" = 'AUTO')::bigint AS wrong_said_manual,
    count(*) FILTER (WHERE (regex_auto AND "targetingType" = 'AUTO')
                        OR (NOT regex_auto AND "targetingType" = 'MANUAL'))::bigint AS correct
  FROM (
    SELECT "targetingType",
           (name ~* '\\yauto|close match|loose match|substitute|complement') AS regex_auto
    FROM "Campaign" WHERE "targetingType" IS NOT NULL) x`)
console.log('E4_SCORE', JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))

const ex = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT name, "targetingType" AS truth,
         CASE WHEN (name ~* '\\yauto|close match|loose match|substitute|complement')
              THEN 'auto' ELSE 'manual' END AS old_export
  FROM "Campaign"
  WHERE "targetingType" IS NOT NULL
    AND ((name ~* '\\yauto|close match|loose match|substitute|complement') AND "targetingType" = 'MANUAL'
      OR NOT (name ~* '\\yauto|close match|loose match|substitute|complement') AND "targetingType" = 'AUTO')
  ORDER BY name LIMIT 8`)
console.log('E4_EXAMPLES', JSON.stringify(ex, null, 1))
await p.$disconnect()
