-- FS5 — FTS5 search substrate (S-13). Hand-authored raw SQL: virtual tables
-- are not Prisma-modelable, so nothing here appears in schema.prisma; the
-- tables are instead declared externally-managed in prisma.config.ts
-- (`tables.external` + `experimental.externalTables`) so `prisma migrate
-- dev/diff` never proposes dropping them (verified: without that config the
-- diff emits DROP TABLE for every _fts table). Migrations replay fine on a
-- fresh DB (setup.ts → migrate deploy). NOT applied by the authoring session —
-- the merging session runs `prisma migrate dev` after the Owner's dev server
-- restarts, per PLAYBOOK trap 6b.
--
-- Design per table (FS-FC-PROPOSAL §2 FS5):
--   · conversation_fts / message_fts / quote_fts / order_fts — EXTERNAL
--     CONTENT (content='<Table>'): the searchable text lives once, in the
--     source table; FTS stores only the inverted index, keyed on the source
--     row's implicit rowid. Sync = the AFTER INSERT/UPDATE OF/DELETE triggers
--     below (the FTS5-documented pattern; the special INSERT .. VALUES('delete',…)
--     form is how external-content indexes retract old terms).
--   · party_fts — SELF-CONTAINED (regular) FTS5 table denormalizing
--     Party.name + all PartyEmail.email rows into one row per party,
--     maintained by triggers on BOTH tables. Deliberately NOT strict
--     contentless (content=''): a contentless table cannot return the
--     party_id column back to the query layer and cannot DELETE by it —
--     the duplicated text (names + emails) is a few hundred KB at design
--     volume, a fair trade for a VACUUM-proof, id-addressable index.
--
-- Tokenizer: unicode61 with remove_diacritics 2 — "moda" matches "Modà"
-- (Italian names/subjects are full of diacritics). Prefix search is served
-- by the term index directly (queries use "tok"*); no prefix= indexes are
-- declared — ⌘K volume does not justify their space cost.
--
-- RESTORE CAVEAT (S-15 companion): the four external-content indexes key on
-- implicit rowids, and VACUUM (hence a restored `VACUUM INTO` snapshot) may
-- renumber implicit rowids. The live DB is never VACUUMed in place, so the
-- running index is always consistent — but AFTER RESTORING A SNAPSHOT run
-- `npm run -w @nexus/factory fts:rebuild` (scripts/fts-rebuild.ts), or the
-- SQL in docs/factory/FS5-RETENTION.md, to rebuild the indexes. party_fts is
-- rowid-independent and survives restore untouched.

-- ── conversations: subject ───────────────────────────────────────

CREATE VIRTUAL TABLE "conversation_fts" USING fts5(
  subject,
  content='Conversation',
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO "conversation_fts"(rowid, subject)
  SELECT rowid, "subject" FROM "Conversation";

CREATE TRIGGER "conversation_fts_ai" AFTER INSERT ON "Conversation" BEGIN
  INSERT INTO "conversation_fts"(rowid, subject) VALUES (new.rowid, new."subject");
END;

CREATE TRIGGER "conversation_fts_au" AFTER UPDATE OF "subject" ON "Conversation" BEGIN
  INSERT INTO "conversation_fts"("conversation_fts", rowid, subject) VALUES ('delete', old.rowid, old."subject");
  INSERT INTO "conversation_fts"(rowid, subject) VALUES (new.rowid, new."subject");
END;

CREATE TRIGGER "conversation_fts_ad" AFTER DELETE ON "Conversation" BEGIN
  INSERT INTO "conversation_fts"("conversation_fts", rowid, subject) VALUES ('delete', old.rowid, old."subject");
END;

-- ── messages: snippet + bodyText (bodyHtml is a render artifact; the plain
--    part carries the words). Cascade deletes fire the delete trigger per
--    child row, so a conversation delete retracts its messages too. ─────────

CREATE VIRTUAL TABLE "message_fts" USING fts5(
  snippet,
  bodyText,
  content='Message',
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO "message_fts"(rowid, snippet, bodyText)
  SELECT rowid, "snippet", "bodyText" FROM "Message";

CREATE TRIGGER "message_fts_ai" AFTER INSERT ON "Message" BEGIN
  INSERT INTO "message_fts"(rowid, snippet, bodyText) VALUES (new.rowid, new."snippet", new."bodyText");
END;

CREATE TRIGGER "message_fts_au" AFTER UPDATE OF "snippet", "bodyText" ON "Message" BEGIN
  INSERT INTO "message_fts"("message_fts", rowid, snippet, bodyText) VALUES ('delete', old.rowid, old."snippet", old."bodyText");
  INSERT INTO "message_fts"(rowid, snippet, bodyText) VALUES (new.rowid, new."snippet", new."bodyText");
END;

CREATE TRIGGER "message_fts_ad" AFTER DELETE ON "Message" BEGIN
  INSERT INTO "message_fts"("message_fts", rowid, snippet, bodyText) VALUES ('delete', old.rowid, old."snippet", old."bodyText");
END;

-- ── quotes: number ───────────────────────────────────────────────

CREATE VIRTUAL TABLE "quote_fts" USING fts5(
  number,
  content='Quote',
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO "quote_fts"(rowid, number)
  SELECT rowid, "number" FROM "Quote";

CREATE TRIGGER "quote_fts_ai" AFTER INSERT ON "Quote" BEGIN
  INSERT INTO "quote_fts"(rowid, number) VALUES (new.rowid, new."number");
END;

CREATE TRIGGER "quote_fts_au" AFTER UPDATE OF "number" ON "Quote" BEGIN
  INSERT INTO "quote_fts"("quote_fts", rowid, number) VALUES ('delete', old.rowid, old."number");
  INSERT INTO "quote_fts"(rowid, number) VALUES (new.rowid, new."number");
END;

CREATE TRIGGER "quote_fts_ad" AFTER DELETE ON "Quote" BEGIN
  INSERT INTO "quote_fts"("quote_fts", rowid, number) VALUES ('delete', old.rowid, old."number");
END;

-- ── orders: number ───────────────────────────────────────────────

CREATE VIRTUAL TABLE "order_fts" USING fts5(
  number,
  content='Order',
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO "order_fts"(rowid, number)
  SELECT rowid, "number" FROM "Order";

CREATE TRIGGER "order_fts_ai" AFTER INSERT ON "Order" BEGIN
  INSERT INTO "order_fts"(rowid, number) VALUES (new.rowid, new."number");
END;

CREATE TRIGGER "order_fts_au" AFTER UPDATE OF "number" ON "Order" BEGIN
  INSERT INTO "order_fts"("order_fts", rowid, number) VALUES ('delete', old.rowid, old."number");
  INSERT INTO "order_fts"(rowid, number) VALUES (new.rowid, new."number");
END;

CREATE TRIGGER "order_fts_ad" AFTER DELETE ON "Order" BEGIN
  INSERT INTO "order_fts"("order_fts", rowid, number) VALUES ('delete', old.rowid, old."number");
END;

-- ── parties: name + emails, one denormalized row per party ───────
-- Rebuild-the-row triggers: every mutation on either side deletes the
-- party's row and re-derives it from the current truth. Convergent under
-- cascade ordering too: whichever of (email cascade, party delete) fires
-- last leaves the correct end state — no row for a deleted party.

CREATE VIRTUAL TABLE "party_fts" USING fts5(
  name,
  emails,
  party_id UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO "party_fts"(name, emails, party_id)
  SELECT p."name",
         (SELECT group_concat(pe."email", ' ') FROM "PartyEmail" pe WHERE pe."partyId" = p."id"),
         p."id"
  FROM "Party" p;

CREATE TRIGGER "party_fts_ai" AFTER INSERT ON "Party" BEGIN
  INSERT INTO "party_fts"(name, emails, party_id)
    SELECT new."name",
           (SELECT group_concat(pe."email", ' ') FROM "PartyEmail" pe WHERE pe."partyId" = new."id"),
           new."id";
END;

CREATE TRIGGER "party_fts_au" AFTER UPDATE OF "name" ON "Party" BEGIN
  DELETE FROM "party_fts" WHERE party_id = old."id";
  INSERT INTO "party_fts"(name, emails, party_id)
    SELECT new."name",
           (SELECT group_concat(pe."email", ' ') FROM "PartyEmail" pe WHERE pe."partyId" = new."id"),
           new."id";
END;

CREATE TRIGGER "party_fts_ad" AFTER DELETE ON "Party" BEGIN
  DELETE FROM "party_fts" WHERE party_id = old."id";
END;

CREATE TRIGGER "party_fts_email_ai" AFTER INSERT ON "PartyEmail" BEGIN
  DELETE FROM "party_fts" WHERE party_id = new."partyId";
  INSERT INTO "party_fts"(name, emails, party_id)
    SELECT p."name",
           (SELECT group_concat(pe."email", ' ') FROM "PartyEmail" pe WHERE pe."partyId" = p."id"),
           p."id"
    FROM "Party" p WHERE p."id" = new."partyId";
END;

CREATE TRIGGER "party_fts_email_au" AFTER UPDATE OF "email", "partyId" ON "PartyEmail" BEGIN
  DELETE FROM "party_fts" WHERE party_id IN (old."partyId", new."partyId");
  INSERT INTO "party_fts"(name, emails, party_id)
    SELECT p."name",
           (SELECT group_concat(pe."email", ' ') FROM "PartyEmail" pe WHERE pe."partyId" = p."id"),
           p."id"
    FROM "Party" p WHERE p."id" IN (old."partyId", new."partyId");
END;

CREATE TRIGGER "party_fts_email_ad" AFTER DELETE ON "PartyEmail" BEGIN
  DELETE FROM "party_fts" WHERE party_id = old."partyId";
  INSERT INTO "party_fts"(name, emails, party_id)
    SELECT p."name",
           (SELECT group_concat(pe."email", ' ') FROM "PartyEmail" pe WHERE pe."partyId" = p."id"),
           p."id"
    FROM "Party" p WHERE p."id" = old."partyId";
END;
