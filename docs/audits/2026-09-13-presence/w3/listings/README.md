# PR.8 Listings — staged, not mounted

P-TOOLBAR is complete; see ../toolbar/README.md. Listings is not complete and has no passing browser or completion gate.

Required gate state at 2026-09-13T19:25Z:

- W2-WIRE DONE: consumed.
- W2-DS DONE: consumed, 19:14:23Z.
- W2-READ and W3-API: absent. PR.1 stopped on the missing both-database schema receipt; PR.5 has a separate expanded production workspace/backfill/index/RLS prerequisite question. PR.8 does not own that operation.

Prepared code is at `/private/tmp/nexus-pr8-presence/w3/`: model.ts, cells.tsx and model.vitest.test.tsx. No app source imports it. The pure model covers five-level keys, explicit null accounts and empty aliases, market/account filtering, exact selection rejoin, listing-versus-product version drift, missing dimensions, stale-read boundaries and the intersection of available local verbs. Cells compose the DS PresenceMark, AsOf, Pill, InfoTip and EmptyState and consume PR.7's canonical staged meta module.

Node-only react-dom/server contract run: 10 tests, 8 passed, 2 failed. Both remaining failures prove the shared PresenceMark currently renders `<span class="nds-as-of">not checked</span>` where this surface requires `never`. The complete actual failure log is staged-contract-tests.log. The proposed PR.6-owned fix is to pass kind="event" to the existing AsOf within PresenceMark; no local duplicate timestamp or edited DS source. Initial scratch runner mixed repository React19 with web React18; it now resolves the web's React18 pair, and those harness failures are eliminated. A guessed “listed” fact label was corrected to canonical “selling”; the substantive timestamp assertions remain red.

The server now pins archive-alias / restore-alias IDs. PR.7's prepared meta includes their labels, explicit external-ID review, the verify/default note, missing-dimension copy, and a shared display-only freshness clock. These are prepared contracts, not mounted data. Nav requests remain exact: Listings after mounted Matrix under THIS PRODUCT, first in each channel group; master navigation must use the same single studioChannelViewPatch and scope-change guard as normal/native channel navigation. Types, tab host and navigation changes wait for their handoff and prerequisite gates.

A separate verify contract conflict is posted for the Owner and PR.1/6/7: verify is a channel READ with reach=channel and reversal=null. The mutation registry refuses both fields together. Recommendation: a typed read distinction through the registry, preserving every mutation reach/reversal guard and all channel-write holds. No fake undo or local reach was substituted, no direct action bypass added, and no verify call made. The brief explicitly says to stop for non-local reach; no such verb is wired before that decision.

No Listings grid, confirmation, writer or channel request is mounted. No database mutation, production operation, channel write, commit or Wave4 work. No W3-SURFACE or PR.8 AT-WAVE-4 line is claimed.
