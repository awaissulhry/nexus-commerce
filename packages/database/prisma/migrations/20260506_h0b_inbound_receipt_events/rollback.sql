-- ROLLBACK for 20260506_h0b_inbound_receipt_events
--
-- Drop the InboundReceipt table. The cached
-- InboundShipmentItem.quantityReceived column stays as-is — it was
-- maintained throughout the H.0b era as the cumulative sum, so its
-- value is correct without the event log.
--
-- Code rollback: redeploy a commit older than H.0b. The receive
-- route in pre-H.0b code reads/writes quantityReceived directly and
-- ignores the (now-deleted) event log. Production stock data stays
-- consistent because the cached column remained accurate throughout.

BEGIN;

DROP TABLE IF EXISTS "InboundReceipt";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20260506_h0b_inbound_receipt_events';

COMMIT;
