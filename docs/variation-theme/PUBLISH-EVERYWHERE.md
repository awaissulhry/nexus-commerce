# Publishing on for every channel and market — state and plan (VTR, 2026-09-26)

The Owner, 2026-09-26: *"We must fix each and everything and switch on the publishing for every channel and market."*
This file is READ-ONLY research plus a plan. No switch, setting or production value was changed.

## 1. The switches today (production, read-only)

Each channel has one master switch plus a mode (`services/<channel>-publish-gate.service.ts`). Off = "gated": nothing is sent.

| Channel | Switch in production | Evidence |
|---|---|---|
| Amazon | **LIVE** | Railway `nexus-scheduler` boot log 2026-09-26 17:59:36 UTC: `PUBLISH MODES at boot — Amazon=live eBay=live Shopify=gated` (also every API boot until 08:27 UTC) |
| eBay | **LIVE** | same line |
| Shopify | **OFF** (gated) | same line; PCO PROGRESS 2026-09-25: enable/mode absent |
| Etsy | **OFF** (not logged) | `NEXUS_ENABLE_ETSY_PUBLISH` ships OFF (channel-connections PROGRESS P4.6); the boot line does not print Etsy |
| WooCommerce | no switch, no publisher | 0 connections; the Owner marked it for removal (channel-connections P7a, 2026-09-21) |

The PCO first live proofs (one Amazon listing, one eBay listing: read → preview → write → read back → restore) were prepared on
2026-09-25 and are still waiting for the Owner's per-run word (PCO PROGRESS "Production release verified").

## 2. What each channel can publish from the studio today (code + private copy `nexus_vtr_test`)

| Channel | Listings in Nexus (copy) | Works today | Refused or missing |
|---|---|---|---|
| Amazon | IT 13 roots (12 live) · DE 9 (6) · ES 3 (3) · FR 4 (4); many DE/ES/FR offers closed | change-only publish per market (PCO) | closed offers are skipped on purpose; 13 live families are blocked by data (variants that cannot be told apart) — the sheet now names them |
| eBay | IT 37 roots (31 live) · DE 1 draft (no category) | Trading listings, change-only | **8 live families use the eBay Inventory model → refused** ("Inventory publication is unavailable here"); on a live item the variation content (values, new variants) is refused because eBay couples it with price/stock writes |
| Shopify | 1 family (draft) | NEW products only | existing (linked) products refused ("change-only … not available yet"); the content read crashed on a never-saved family (FIXED locally in VTR step 0); value order is child-id order (VTR step 1) |
| Etsy | 1 family (draft) | — | studio says "Direct publishing to Etsy is not available yet" (`studio-publication.service.ts`); the Etsy write client exists (P4.6), the studio adapter does not |
| WooCommerce | 0 | — | whole channel |

## 3. Plan (each step: tests first, local proof on a private copy, the Owner's word before any live send or switch)

| Step | What | Who (lane) |
|---|---|---|
| P1 | Prove what is already on: the two prepared one-listing proofs (Amazon IT, eBay IT Trading) | PCO tools; the Owner's per-run word |
| P2 | Clear the data blockers the sheet now shows (collisions, missing values, deprecated themes) with the Information-sheet tools | VTR steps 1–3 |
| P3 | eBay: studio publish for Inventory-model listings (8 live families) and variation changes on live items | new publish lane (or VTR after step 3) |
| P4 | Shopify: change-only for existing products, product linking, value order (VTR step 1); then the switch ON + one-listing proof | publish lane + VTR step 1 |
| P5 | Etsy: the studio publish adapter (content + variations) on the P4.6 write client; then the switch ON + one-listing proof | publish lane (channel-connections owns the client) |
| P6 | WooCommerce: remove (as decided 2026-09-21) or build | the Owner decides |

Turning a switch on is a production setting on Railway plus a redeploy. It happens only on the Owner's word for that channel, and the
first send on each channel is ONE listing, read back and restorable (PCO §5).
