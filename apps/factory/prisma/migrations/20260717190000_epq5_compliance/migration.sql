-- EPQ.5 — Italy/EU compliance pass. Additive only; authored from `prisma
-- migrate diff --script` output and hand-shaped to plain ADD COLUMNs (the diff
-- proposes table rebuilds for column adds, which take a long write lock while
-- the Owner's server runs; end state verified identical against a scratch DB
-- with `migrate diff --exit-code`). NOT applied here — the merging session
-- runs `prisma migrate dev` after the Owner's dev server restarts (trap 6b).

-- AlterTable (EPQ.5 — Party tax posture + SDI routing + VIES proof)
ALTER TABLE "Party" ADD COLUMN "taxMode" TEXT;
ALTER TABLE "Party" ADD COLUMN "vatNumber" TEXT;
ALTER TABLE "Party" ADD COLUMN "codiceFiscale" TEXT;
ALTER TABLE "Party" ADD COLUMN "sdiCodice" TEXT;
ALTER TABLE "Party" ADD COLUMN "sdiPec" TEXT;
ALTER TABLE "Party" ADD COLUMN "viesRequestId" TEXT;
ALTER TABLE "Party" ADD COLUMN "viesCheckedAt" DATETIME;

-- AlterTable (EPQ.5 — Quote compliance snapshot: tax mode, natura code for
-- downstream EPF invoicing, deposit legal character, validity wording)
ALTER TABLE "Quote" ADD COLUMN "taxMode" TEXT;
ALTER TABLE "Quote" ADD COLUMN "naturaCode" TEXT;
ALTER TABLE "Quote" ADD COLUMN "depositKind" TEXT NOT NULL DEFAULT 'ACCONTO';
ALTER TABLE "Quote" ADD COLUMN "validityWording" TEXT NOT NULL DEFAULT 'REVOCABLE';

-- AlterTable (EPQ.5 — acceptance evidence bundle, frozen with the version)
ALTER TABLE "QuoteVersion" ADD COLUMN "evidenceJson" JSONB;

-- AlterTable (EPQ.5 — per-template bespoke flag; everything today is
-- made-to-measure, so the default is true and no backfill is needed)
ALTER TABLE "ProductTemplate" ADD COLUMN "bespoke" BOOLEAN NOT NULL DEFAULT true;
