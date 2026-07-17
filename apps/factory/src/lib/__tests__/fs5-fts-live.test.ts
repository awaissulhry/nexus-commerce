/**
 * FS5 — the FTS substrate proven against a REAL FTS5 database: an in-memory
 * better-sqlite3 file gets minimal base tables, then the ACTUAL fs5_fts
 * migration SQL (read from prisma/migrations — so the shipped file itself is
 * under test: virtual tables, backfills, every trigger), then the ACTUAL
 * FTS_SQL grammar strings with their bound-parameter shapes. No Prisma, no
 * shared DB, no live file — playbook rule 5 honored.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMatchQuery, FTS_SQL } from "../search-fts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, "..", "..", "..", "prisma", "migrations", "20260717230000_fs5_fts", "migration.sql");

let db: Database.Database;

// Minimal shapes of the six base tables the migration touches — TEXT ids with
// implicit rowids, exactly like the Prisma-generated DDL.
const BASE_DDL = `
  CREATE TABLE "Party" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);
  CREATE TABLE "PartyEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    CONSTRAINT "PartyEmail_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party" ("id") ON DELETE CASCADE
  );
  CREATE TABLE "Conversation" ("id" TEXT NOT NULL PRIMARY KEY, "subject" TEXT);
  CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "snippet" TEXT,
    "bodyText" TEXT,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE
  );
  CREATE TABLE "Quote" ("id" TEXT NOT NULL PRIMARY KEY, "number" TEXT NOT NULL, "partyId" TEXT);
  CREATE TABLE "Order" ("id" TEXT NOT NULL PRIMARY KEY, "number" TEXT NOT NULL, "partyId" TEXT);
`;

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(BASE_DDL);
  // pre-migration rows prove the in-migration backfill INSERTs
  db.prepare(`INSERT INTO "Party" ("id", "name") VALUES ('p0', 'Backfilled Cliente')`).run();
  db.prepare(`INSERT INTO "Conversation" ("id", "subject") VALUES ('c0', 'Backfilled subject riparazione')`).run();
  db.exec(fs.readFileSync(MIGRATION, "utf8"));
});
afterAll(() => db.close());

const idsVia = (sql: string, q: string, ...limits: number[]): string[] => {
  const match = buildMatchQuery(q);
  if (!match) return [];
  return db
    .prepare(sql)
    .all(match, ...limits)
    .map((r) => (r as { id: string }).id);
};

describe("fs5_fts migration on a real FTS5 database", () => {
  it("backfills rows that existed before the migration", () => {
    expect(idsVia(FTS_SQL.conversationIds, "riparazione", 6)).toEqual(["c0"]);
    expect(idsVia(FTS_SQL.partyIds, "backfilled", 6)).toEqual(["p0"]);
  });

  it("indexes new rows through the insert triggers (all five tables)", () => {
    db.prepare(`INSERT INTO "Party" ("id", "name") VALUES ('p1', 'Modà Racing')`).run();
    db.prepare(`INSERT INTO "PartyEmail" ("id", "partyId", "email") VALUES ('pe1', 'p1', 'orders@modaracing.it')`).run();
    db.prepare(`INSERT INTO "Conversation" ("id", "subject") VALUES ('c1', 'Preventivo tuta canguro')`).run();
    db.prepare(
      `INSERT INTO "Message" ("id", "conversationId", "snippet", "bodyText") VALUES ('m1', 'c1', 'vorrei un preventivo', 'tuta in pelle canguro con airbag integrato')`,
    ).run();
    db.prepare(`INSERT INTO "Quote" ("id", "number", "partyId") VALUES ('q1', 'Q-2026-0042', 'p1')`).run();
    db.prepare(`INSERT INTO "Order" ("id", "number", "partyId") VALUES ('o1', 'ORD-214', 'p1')`).run();

    expect(idsVia(FTS_SQL.conversationIds, "canguro", 6)).toEqual(["c1"]);
    expect(idsVia(FTS_SQL.messageConversationIds, "airbag", 24, 6)).toEqual(["c1"]);
    expect(idsVia(FTS_SQL.quoteIds, "0042", 6)).toEqual(["q1"]);
    expect(idsVia(FTS_SQL.orderIds, "ORD-214", 6)).toEqual(["o1"]);
    expect(idsVia(FTS_SQL.partyIds, "Racing", 6)).toEqual(["p1"]);
  });

  it("matches parties by email tokens (the denormalized emails column)", () => {
    expect(idsVia(FTS_SQL.partyIds, "modaracing", 6)).toEqual(["p1"]);
  });

  it("is diacritics-insensitive via unicode61 remove_diacritics 2", () => {
    expect(idsVia(FTS_SQL.partyIds, "moda", 6)).toEqual(["p1"]); // query "moda" → row "Modà"
    db.prepare(`INSERT INTO "Conversation" ("id", "subject") VALUES ('c2', 'Qualita della pelle')`).run();
    expect(idsVia(FTS_SQL.conversationIds, "qualità", 6)).toEqual(["c2"]); // query has the accent, row does not
  });

  it("prefix-searches partial tokens", () => {
    expect(idsVia(FTS_SQL.conversationIds, "cang", 6)).toEqual(["c1"]);
    expect(idsVia(FTS_SQL.quoteIds, "Q 20", 6)).toEqual(["q1"]);
  });

  it("retracts old terms on UPDATE (external content 'delete' + reinsert)", () => {
    db.prepare(`UPDATE "Conversation" SET "subject" = 'Ordine confermato giacca' WHERE "id" = 'c1'`).run();
    expect(idsVia(FTS_SQL.conversationIds, "canguro", 6)).toEqual([]);
    expect(idsVia(FTS_SQL.conversationIds, "giacca", 6)).toEqual(["c1"]);
    db.prepare(`UPDATE "Conversation" SET "subject" = 'Preventivo tuta canguro' WHERE "id" = 'c1'`).run();
  });

  it("rebuilds the party row when its name or emails change", () => {
    db.prepare(`UPDATE "Party" SET "name" = 'Bertet Cuir' WHERE "id" = 'p1'`).run();
    expect(idsVia(FTS_SQL.partyIds, "bertet", 6)).toEqual(["p1"]);
    expect(idsVia(FTS_SQL.partyIds, "Racing", 6)).toEqual([]); // old name gone
    expect(idsVia(FTS_SQL.partyIds, "modaracing", 6)).toEqual(["p1"]); // emails survive the rename
    db.prepare(`DELETE FROM "PartyEmail" WHERE "id" = 'pe1'`).run();
    expect(idsVia(FTS_SQL.partyIds, "modaracing", 6)).toEqual([]);
    expect(idsVia(FTS_SQL.partyIds, "bertet", 6)).toEqual(["p1"]); // name survives the email delete
  });

  it("retracts on DELETE, including FK-cascaded message deletes", () => {
    expect(idsVia(FTS_SQL.messageConversationIds, "airbag", 24, 6)).toEqual(["c1"]);
    db.prepare(`DELETE FROM "Conversation" WHERE "id" = 'c1'`).run();
    expect(idsVia(FTS_SQL.conversationIds, "canguro", 6)).toEqual([]);
    expect(idsVia(FTS_SQL.messageConversationIds, "airbag", 24, 6)).toEqual([]); // cascade fired message_fts_ad
    db.prepare(`DELETE FROM "Party" WHERE "id" = 'p1'`).run();
    expect(idsVia(FTS_SQL.partyIds, "bertet", 6)).toEqual([]);
  });

  it("keeps every external-content index consistent (FTS5 integrity-check)", () => {
    for (const t of ["conversation_fts", "message_fts", "quote_fts", "order_fts"]) {
      expect(() => db.exec(`INSERT INTO "${t}"("${t}", rank) VALUES('integrity-check', 1)`)).not.toThrow();
    }
  });

  it("never throws on hostile ⌘K input (every operator neutralized or dropped)", () => {
    const hostile = ['"', '""', "*", "(", ")", ":", "^", "-", "AND", "OR", "NOT", "NEAR", 'a"b', "col:val", "star*", "{brace}", "près-de"];
    for (const input of hostile) {
      const match = buildMatchQuery(input);
      if (match === null) continue; // punctuation-only inputs are dropped pre-SQL
      expect(() => db.prepare(FTS_SQL.conversationIds).all(match, 6)).not.toThrow();
    }
  });

  it("clamps result sets through the bound LIMIT parameter", () => {
    for (let i = 0; i < 10; i++) {
      db.prepare(`INSERT INTO "Conversation" ("id", "subject") VALUES ('cl${i}', 'limite prova ${i}')`).run();
    }
    expect(idsVia(FTS_SQL.conversationIds, "limite", 6)).toHaveLength(6);
    expect(idsVia(FTS_SQL.conversationIds, "limite", 3)).toHaveLength(3);
  });
});
