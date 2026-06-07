-- RR.1 — verbatim flat-file row snapshot for lossless grid round-trip
ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "flatFileSnapshot" JSONB;
