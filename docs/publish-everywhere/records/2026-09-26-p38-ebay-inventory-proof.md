# P3.8 eBay Inventory proof — PASS (2026-09-26, production, one listing)

Owner's word in the PE session after the exact change was shown (proposal digest `60db1716…`; ids stay in the private records).
Run on `nexus-worker` with `docs/publish-everywhere/tools/ebay-inventory-proof.mts`, through the real change-only sender
(`studio-publication-ebay-inventory.ts`). Listing: normal-knee-slider · eBay IT · 8 variants · group key = parent SKU.

| Step | Result |
|---|---|
| Journal (reason `publish-proof`) before the PUT | written |
| Group PUT: description + one hidden HTML comment | eBay stored group matches; **the buyer listing (GetItem) showed the comment at once** (36,092 bytes); sender verified |
| Restore PUT: the exact original group | stored group matches; listing back to 36,036 bytes, no comment; sender verified |
| Re-read after 60 s | group = original; listing clean |

**Finding:** a change-only `inventory_item_group` PUT updates the live listing by itself — no `publish_by_inventory_item_group`
call is needed for group content. Title, pictures, aspects, variants, variesBy, offers, price and stock were not touched.

An earlier attempt (digest `296f7fa6…`) stopped before any write: the size items had changed since preparation, so the
revision no longer matched. Nothing was sent; the proof was prepared again and run at once.
