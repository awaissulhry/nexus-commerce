-- HB.8 — marketplace-code consistency sweep.
--
-- Canonicalize the `marketplace` column across all tables that use it
-- onto the 2-letter code form (IT/DE/FR/…), matching Order.marketplace.
--
-- Tables where the COLUMN NAME is `marketplaceId` (SettlementReport,
-- FbaReimbursement, FbaInventoryAdjustment, AmazonAdsProfile.profileId,
-- Marketplace.marketplaceId) are intentionally left as SP-API ids —
-- the column name makes the convention self-documenting.

-- Mapping helper expressed inline via CASE. Five tables, same map.
-- (Doing per-table UPDATE rather than building a temp lookup table —
-- the row counts are tiny.)

-- ── AmazonAdsDailyPerformance ──────────────────────────────────────
UPDATE "AmazonAdsDailyPerformance"
SET marketplace = CASE marketplace
  WHEN 'APJ6JRA9NG5V4' THEN 'IT'
  WHEN 'A1PA6795UKMFR9' THEN 'DE'
  WHEN 'A13V1IB3VIYZZH' THEN 'FR'
  WHEN 'A1RKKUPIHCS9HS' THEN 'ES'
  WHEN 'A1805IZSGTT6HS' THEN 'NL'
  WHEN 'A1F83G8C2ARO7P' THEN 'UK'
  WHEN 'A1C3SOZRARQ6R3' THEN 'PL'
  WHEN 'A2NODRKZP88ZB9' THEN 'SE'
  WHEN 'AMEN7PMS3EDWL'  THEN 'IE'
  WHEN 'ATVPDKIKX0DER' THEN 'US'
  ELSE marketplace
END
WHERE marketplace IN (
  'APJ6JRA9NG5V4','A1PA6795UKMFR9','A13V1IB3VIYZZH','A1RKKUPIHCS9HS',
  'A1805IZSGTT6HS','A1F83G8C2ARO7P','A1C3SOZRARQ6R3','A2NODRKZP88ZB9',
  'AMEN7PMS3EDWL','ATVPDKIKX0DER'
);

-- ── AmazonAdsSearchTerm ────────────────────────────────────────────
UPDATE "AmazonAdsSearchTerm"
SET marketplace = CASE marketplace
  WHEN 'APJ6JRA9NG5V4' THEN 'IT'
  WHEN 'A1PA6795UKMFR9' THEN 'DE'
  WHEN 'A13V1IB3VIYZZH' THEN 'FR'
  WHEN 'A1RKKUPIHCS9HS' THEN 'ES'
  WHEN 'A1805IZSGTT6HS' THEN 'NL'
  WHEN 'A1F83G8C2ARO7P' THEN 'UK'
  WHEN 'A1C3SOZRARQ6R3' THEN 'PL'
  WHEN 'A2NODRKZP88ZB9' THEN 'SE'
  WHEN 'AMEN7PMS3EDWL'  THEN 'IE'
  WHEN 'ATVPDKIKX0DER' THEN 'US'
  ELSE marketplace
END
WHERE marketplace IN (
  'APJ6JRA9NG5V4','A1PA6795UKMFR9','A13V1IB3VIYZZH','A1RKKUPIHCS9HS',
  'A1805IZSGTT6HS','A1F83G8C2ARO7P','A1C3SOZRARQ6R3','A2NODRKZP88ZB9',
  'AMEN7PMS3EDWL','ATVPDKIKX0DER'
);

-- ── AmazonAdsConnection ────────────────────────────────────────────
UPDATE "AmazonAdsConnection"
SET marketplace = CASE marketplace
  WHEN 'APJ6JRA9NG5V4' THEN 'IT'
  WHEN 'A1PA6795UKMFR9' THEN 'DE'
  WHEN 'A13V1IB3VIYZZH' THEN 'FR'
  WHEN 'A1RKKUPIHCS9HS' THEN 'ES'
  WHEN 'A1805IZSGTT6HS' THEN 'NL'
  WHEN 'A1F83G8C2ARO7P' THEN 'UK'
  WHEN 'A1C3SOZRARQ6R3' THEN 'PL'
  WHEN 'A2NODRKZP88ZB9' THEN 'SE'
  WHEN 'AMEN7PMS3EDWL'  THEN 'IE'
  WHEN 'ATVPDKIKX0DER' THEN 'US'
  ELSE marketplace
END
WHERE marketplace IN (
  'APJ6JRA9NG5V4','A1PA6795UKMFR9','A13V1IB3VIYZZH','A1RKKUPIHCS9HS',
  'A1805IZSGTT6HS','A1F83G8C2ARO7P','A1C3SOZRARQ6R3','A2NODRKZP88ZB9',
  'AMEN7PMS3EDWL','ATVPDKIKX0DER'
);

-- ── AmazonAdsBrandMetric ────────────────────────────────────────────
-- Currently 0 rows; idempotent UPDATE for forward-compat.
UPDATE "AmazonAdsBrandMetric"
SET marketplace = CASE marketplace
  WHEN 'APJ6JRA9NG5V4' THEN 'IT'
  WHEN 'A1PA6795UKMFR9' THEN 'DE'
  WHEN 'A13V1IB3VIYZZH' THEN 'FR'
  WHEN 'A1RKKUPIHCS9HS' THEN 'ES'
  WHEN 'A1805IZSGTT6HS' THEN 'NL'
  WHEN 'A1F83G8C2ARO7P' THEN 'UK'
  WHEN 'A1C3SOZRARQ6R3' THEN 'PL'
  WHEN 'A2NODRKZP88ZB9' THEN 'SE'
  WHEN 'AMEN7PMS3EDWL'  THEN 'IE'
  WHEN 'ATVPDKIKX0DER' THEN 'US'
  ELSE marketplace
END
WHERE marketplace IN (
  'APJ6JRA9NG5V4','A1PA6795UKMFR9','A13V1IB3VIYZZH','A1RKKUPIHCS9HS',
  'A1805IZSGTT6HS','A1F83G8C2ARO7P','A1C3SOZRARQ6R3','A2NODRKZP88ZB9',
  'AMEN7PMS3EDWL','ATVPDKIKX0DER'
);

-- ── APlusContent ────────────────────────────────────────────────────
-- 'AMAZON_IT' / 'AMAZON_DE' / ... → 'IT' / 'DE' / ...
UPDATE "APlusContent"
SET marketplace = UPPER(SUBSTRING(marketplace FROM 8))
WHERE marketplace LIKE 'AMAZON\_%' ESCAPE '\';

-- ── FbaRestockReport ────────────────────────────────────────────────
UPDATE "FbaRestockReport"
SET marketplace = CASE marketplace
  WHEN 'APJ6JRA9NG5V4' THEN 'IT'
  WHEN 'A1PA6795UKMFR9' THEN 'DE'
  WHEN 'A13V1IB3VIYZZH' THEN 'FR'
  WHEN 'A1RKKUPIHCS9HS' THEN 'ES'
  WHEN 'A1805IZSGTT6HS' THEN 'NL'
  WHEN 'A1F83G8C2ARO7P' THEN 'UK'
  WHEN 'A1C3SOZRARQ6R3' THEN 'PL'
  WHEN 'A2NODRKZP88ZB9' THEN 'SE'
  WHEN 'AMEN7PMS3EDWL'  THEN 'IE'
  WHEN 'ATVPDKIKX0DER' THEN 'US'
  ELSE marketplace
END
WHERE marketplace IN (
  'APJ6JRA9NG5V4','A1PA6795UKMFR9','A13V1IB3VIYZZH','A1RKKUPIHCS9HS',
  'A1805IZSGTT6HS','A1F83G8C2ARO7P','A1C3SOZRARQ6R3','A2NODRKZP88ZB9',
  'AMEN7PMS3EDWL','ATVPDKIKX0DER'
);

-- Drop the 2 'XX_INVALID' rows surfaced in HB.0 audit (data-quality bug
-- from an earlier writer that didn't normalize input).
DELETE FROM "FbaRestockReport" WHERE marketplace = 'XX_INVALID';

-- ── Marketplace ────────────────────────────────────────────────────
-- Add IE row (Xavia's SP-API auth includes Ireland via AMEN7PMS3EDWL
-- but the Marketplace table never had this row; M1 reported it as a
-- warning). Idempotent — ON CONFLICT DO NOTHING.
INSERT INTO "Marketplace" (
  id, channel, code, name, "marketplaceId", region, currency, language,
  "domainUrl", "isActive", "isParticipating", "participationStatus",
  "participationCheckedAt", "createdAt", "updatedAt"
)
VALUES (
  'mkpl_amazon_ie', 'AMAZON', 'IE', 'Amazon Ireland', 'AMEN7PMS3EDWL',
  'EU', 'EUR', 'en', 'amazon.ie', TRUE, TRUE, 'PARTICIPATING',
  NOW(), NOW(), NOW()
)
ON CONFLICT (channel, code) DO NOTHING;
