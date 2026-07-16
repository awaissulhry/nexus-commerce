-- EPO1.3 (C4) — payment idempotency: client-minted key, unique; a double-submit
-- lands on the constraint and returns the first payment instead of double money.
ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
