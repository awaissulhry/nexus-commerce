-- P3.1 — Add CANCELLED value to OutboundSyncStatus enum
ALTER TYPE "OutboundSyncStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
