-- Rollback for 20260506_h14_channel_refund.
ALTER TABLE "Return"
  DROP COLUMN IF EXISTS "channelRefundId",
  DROP COLUMN IF EXISTS "channelRefundError",
  DROP COLUMN IF EXISTS "channelRefundedAt";
