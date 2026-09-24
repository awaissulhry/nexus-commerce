-- CFI-6 (R-CFI-1, 2026-09-25) — a price recorded from the channel's OWN file (an Amazon template / our eBay workbook)
-- through the one price door in record-only mode: nothing is sent. Additive only: one enum value; no existing row changes.
ALTER TYPE "PriceChangeSource" ADD VALUE IF NOT EXISTS 'CHANNEL_FILE_IMPORT';
