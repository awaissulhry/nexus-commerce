# PR.7 W0 copy evidence

Before column: repository baseline text at HEAD; after column: current saved source. The hard-delete adapter wording follows the explicit PR.7 no-escalation brief, which supersedes the proposal’s old adapter behaviour. No deletion was confirmed.

| Surface | Before | After | Test |
| --- | --- | --- | --- |
| products.hardDelete.body | Local rows + every dependent (channel listings, sync history, stock log, FBA shipment lines) are wiped. Pick how you want the channel side handled below — undoable on the local side only when you choose "Local-only". | The local product record and its dependent records are permanently deleted. There is no undo for the local deletion. | hardDelete.vitest.test.ts — exact key pin |
| products.hardDelete.preflightError | Pre-flight check failed: {error}. You can still delete, but channel-side state isn't visible. | The check failed: {error}. Permanent deletion is blocked. | hardDelete.vitest.test.ts — exact key pin |
| products.hardDelete.channelAction.unpublish.label | Unpublish (recommended) | End the listing on each channel | hardDelete.vitest.test.ts — exact key pin |
| products.hardDelete.channelAction.unpublish.body | Pause the offer on each channel — keeps the listing record so you can republish later. Amazon: discontinued; eBay: end listing; Shopify: status DRAFT. | Nexus asks each channel to stop selling, then deletes the local record either way. Amazon and eBay: the request is refused; the listing is not ended. Shopify: the request returns a visible failure; the store keeps selling it. WooCommerce and Etsy: nothing is sent. There is no relist from here. | hardDelete.vitest.test.ts — exact key pin |
| products.hardDelete.channelAction.delete.label | Delete on channel | Remove the listing from each channel | hardDelete.vitest.test.ts — exact key pin |
| products.hardDelete.channelAction.delete.body | Remove the listing from each channel's catalog where possible (Amazon SKU offer removed, Shopify product deleted). Republishing later means starting over. | Nexus asks each channel to remove the listing, then deletes the local record either way. Amazon: the seller offer is deleted; the ASIN survives. eBay: the listing is ended; a relist gets a new item number. Shopify: the request returns a visible failure; the product is not deleted. WooCommerce and Etsy: nothing is sent. | hardDelete.vitest.test.ts — exact key pin |
| products.hardDelete.channelAction.none.body | Wipe the local rows but leave the channel listings in place. Useful if you want to keep selling on Amazon/eBay/Shopify while cleaning up the local catalog. | The local product record and its dependent records are permanently deleted. Nothing is sent to any channel. Channel listings may keep selling. There is no undo for the local deletion. | hardDelete.vitest.test.ts — exact key pin |
| products.hardDelete.channelAction.note | (new) | Amazon and eBay refuse the first option; the second asks them to delete the seller offer or end the listing. Shopify returns a visible failure for either option. WooCommerce and Etsy receive nothing. The local record is deleted either way. | hardDelete.vitest.test.ts — exact key pin |
| products.hardDelete.submit.unpublish | Delete locally + unpublish | Delete locally and end on channel | hardDelete.vitest.test.ts — exact key pin |
| products.hardDelete.submit.delete | Delete locally + on channel | Delete locally and remove from channel | hardDelete.vitest.test.ts — exact key pin |
| Row readiness | Live · Already published on this channel | Listed · Our record holds a channel reference. Whether it is selling is on the presence line. | presence/copy.vitest.test.ts |
| Unlisted readiness | Not listed | No listing here · We hold no listing record for this coordinate. Nothing has been checked against the channel. | presence/copy.vitest.test.ts |
| Drawer status | raw listingStatus | DS listingStatusMeta, with case-normalised vocabulary and unknown-token explanation | presence/copy.vitest.test.ts; DS listingStatus.vitest.test.ts |
| Alias status absence | ?? 'NOT LISTED'; status.toLowerCase() | null · Listing status not reported; nullable title branch | presence/copy.vitest.test.ts |
| Excluded child id / parent id | Two divergent reasons | Excluded here. {id} still offers this variant on {label} until the listing is revised. No listing change has been sent, and stock updates for this record still go out. | API excluded-reason.vitest.test.ts |
| Excluded with no id | Two divergent reasons | Excluded from this listing. Nothing was ever sent for this variant. | API excluded-reason.vitest.test.ts |
| No listing row | No-row reason | No listing record on this coordinate. Tick it to create one as a draft. | API excluded-reason.vitest.test.ts |
| Offer mark | Pause / Activate; channel-effect promise | Mark paused / Mark active; per-channel exact sentences in channelActions.ts | channelActions.vitest.test.ts |
| Broadcast | Confirmation despite unavailable | Broadcast is not built. Nothing is sent on any row, live or not. | channelActions.vitest.test.ts |
| Held preflight | confirm + unavailable | none + unavailable | channelActions.vitest.test.ts |
| Permanent-delete gate | typed.trim().toUpperCase() === 'DELETE' | Successful complete preflight + exact selected SKU; no placeholder; server refusal blocks | hardDelete.vitest.test.ts |
| Listing-risk absence | never published to the channel | no marketplace id on this record | listingRisk.vitest.test.ts |
| Review mode | Channel-derived wording | Check before sending / Nothing is sent from here.; Review and synchronize… / Review and synchronize | presence/copy.vitest.test.ts |
| Saved-value check | Three names | Saved values checked | presence/copy.vitest.test.ts |

Hermetic baseline: **121 files passed; 1,692 passed, 13 skipped (1,705)**, exit **0**. The six brief failures were already repaired in the shared tree before PR.7; masterWrite asserts the current single-route contract and was retained. The first sandbox run failed on its loopback listener and is not the semantic baseline.

After W0 plus the independent wire parser work: **125 files passed; 1,755 passed, 13 skipped (1,768)**, exit **0**, including hardDelete.vitest.test.ts outside `_studio`. Both runs set `NEXT_PUBLIC_API_URL=http://127.0.0.1:1 PES3_API=http://127.0.0.1:1`.

The live Amazon-only test now uses `ctx.skip(reason)`; WooCommerce’s three assertions remain unchanged pending the Owner question recorded in the ledger.

Nothing committed; no marketplace write; no production write.
