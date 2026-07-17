/**
 * FS5 — rebuild the FTS5 search indexes. Needed exactly once after RESTORING
 * a snapshot: the four external-content indexes (conversation/message/quote/
 * order) key on implicit rowids, and VACUUM INTO (which produced the
 * snapshot) may renumber implicit rowids — so a restored file's FTS index can
 * point at the wrong rows. FTS5's 'rebuild' command re-derives each index
 * from its content table; party_fts is self-contained, so it is dropped to
 * empty and re-backfilled from Party/PartyEmail (same statement as the
 * fs5_fts migration). Safe to run any time (idempotent); takes the write
 * lock briefly (~4 s at the 1.4M-message harness volume).
 *
 * Run: npm run fts:rebuild -w @nexus/factory   (honors FACTORY_DATABASE_URL)
 */
import { prisma, factoryDbUrl } from "../src/lib/db";

const EXTERNAL_FTS = ["conversation_fts", "message_fts", "quote_fts", "order_fts"] as const;

async function main() {
  console.log(`[fts-rebuild] target: ${factoryDbUrl()}`);
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('conversation_fts', 'message_fts', 'party_fts', 'quote_fts', 'order_fts')`;
  if (tables.length !== 5) {
    console.error(
      `[fts-rebuild] found ${tables.length}/5 FTS tables — apply the fs5_fts migration first (npm run db:migrate).`,
    );
    process.exitCode = 1;
    return;
  }
  for (const t of EXTERNAL_FTS) {
    const t0 = Date.now();
    await prisma.$executeRawUnsafe(`INSERT INTO "${t}"("${t}") VALUES('rebuild')`);
    console.log(`[fts-rebuild] ${t}: rebuilt in ${Date.now() - t0} ms`);
  }
  const t0 = Date.now();
  await prisma.$executeRawUnsafe(`DELETE FROM "party_fts"`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "party_fts"(name, emails, party_id)
      SELECT p."name",
             (SELECT group_concat(pe."email", ' ') FROM "PartyEmail" pe WHERE pe."partyId" = p."id"),
             p."id"
      FROM "Party" p`);
  console.log(`[fts-rebuild] party_fts: re-backfilled in ${Date.now() - t0} ms`);
  for (const t of EXTERNAL_FTS) {
    await prisma.$executeRawUnsafe(`INSERT INTO "${t}"("${t}", rank) VALUES('integrity-check', 1)`);
  }
  console.log("[fts-rebuild] integrity-check passed on all external-content indexes — done");
}

main()
  .catch((err) => {
    console.error("[fts-rebuild] FAILED:", (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
