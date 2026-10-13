-- Google Ads AAA (2026-10-13) — the type of each negative keyword list, and whether Google applies it to the whole
-- account. Additive only: two nullable columns, no data moved.
--
--   GoogleAdsNegativeList.listType           Google's shared set type: NEGATIVE_KEYWORDS (a list attached to campaigns)
--                                            or ACCOUNT_LEVEL_NEGATIVE_KEYWORDS (a list meant for the whole account).
--   GoogleAdsNegativeList.appliesToAccount   true when a customer_negative_criterion of the account points at the list
--                                            (Google applies it to the whole account), false when read and none does.
--
-- NULL in either = not read yet (rows stored before this release, or a read without the list's details).

-- AlterTable
ALTER TABLE "GoogleAdsNegativeList" ADD COLUMN "listType" TEXT,
ADD COLUMN "appliesToAccount" BOOLEAN;
