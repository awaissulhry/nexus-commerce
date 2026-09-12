# Acceptance results — 10 September 2026

Statuses apply to the complete numbered criterion in the supplied prompt. **Passed** is always qualified by its evidence boundary. **Failed** includes incomplete implementation. **Blocked by capability** identifies an actual unresolved/version capability boundary. **Not tested** is not a pass. No result below proves a production or development-store mutation.

| # | Status | Evidence and remaining boundary |
| --- | --- | --- |
| 1 | Blocked by capability | All 60 exact labels, eight groups, required title and two quantity headers pass registry tests and chooser inspection. Seven category keys remain undiscovered. See coverage.md and live-read-evidence.json. |
| 2 | Passed — fixture | Two parents and 15 variants. Collapse/expand preserved a dirty SKU; review revealed it after hiding the field. The parent count stayed two. |
| 3 | Passed — enabled operations | Shared contract, UI-command and API tests reject wrong owners, foreign products and product-row price writes. Publication cells are read-only and cannot write a variant publication. |
| 4 | Failed | False, null, zero, empty list, undefined/unavailable and inapplicable are represented separately in enabled editors and contract tests. Inherited provenance and every type's save/reload path are incomplete. |
| 5 | Not tested — complete criterion | Light/dark layouts checked at 1342/1440/1920 px, and mobile at 390 px, with no document horizontal overflow. Title pinning, full accessible headings and width persistence are implemented. Actual browser zoom and a systematic resized-column/scroll matrix remain untested. |
| 6 | Not tested — complete criterion | Keyboard inline editing, Tab, range fill preview and Undo passed browser checks. Paste command parsing/validation passed unit tests. Pointer dragging, nonadjacent gestures, native clipboard and pointer fill remain untested. |
| 7 | Passed — fixture | Hidden and collapsed dirty SKU persisted in the external draft and change review. Reload offered recovery; Restore retained it. Drafts are held outside virtualized renderers. |
| 8 | Passed — fixture | Six gallery items render five thumbnails plus +1 at the sampled width; media opens from its cell. See media-manager.png. |
| 9 | Not tested — pointer gesture | Explicit Move to position 1 produced [3,1,2,4,5,6], updated MOSS's strip and first preview, and saved/reloaded. A committed pointer drag was not exercised. |
| 10 | Passed — fixture and unit | Earlier/later/first/position actions use the stable-ID move operation. Space, arrow, Escape left the original gallery intact and announced cancellation. See media-mobile.png. |
| 11 | Passed — fixture and unit | Begin/end/same-position movement and duplicate/membership rejection pass shared tests. Reordering MOSS did not alter AIRMESH despite their shared asset ID. |
| 12 | Passed — mocked adapter/queue | Tests separately assert pre-submission checkpoint, accepted job, pending job, completed job and exact final order. Errors retain intent; uncertain requests do not blindly resubmit. No real Shopify reorder was sent. |
| 13 | Failed | Existing Files service upload tests pass, but this gallery has no connected multi-file upload workflow, retry/cancel queue or attachment lifecycle. |
| 14 | Failed | A staged multi-selection asset picker is not connected to this gallery. Existing library selection elsewhere is not counted as parity. |
| 15 | Failed | Detachment and affected-variant preview are not implemented. The gallery allows reorder only and cannot remove associations or globally delete files. |
| 16 | Failed | Inspection shows type, processing, alt text and full-size media. Filename/alt editing, focal metadata, transforms, usage preview and original/version recovery are not connected here. |
| 17 | Failed | No generation/suggestion workflow is implemented in this gallery. No generated content is automatically accepted; absence of the workflow is not counted as a pass. |
| 18 | Not tested — complete round-trip | Live discovery confirms page_reference and metaobject_reference respectively. Size Chart selection, Cancel and fixture save/sync/reload passed. Full Concise description development-store mutation round-trip is untested. |
| 19 | Passed — contract/service boundary | Existing ordered-reference service tests retain IDs and order; duplicate-label identity is preserved. Human-readable previews are hydrated in batches. A full audited multi-product picker browser round-trip remains untested. |
| 20 | Not tested — combined browser flow | Browser shared editor exposes three references and separate review/save. Existing service tests verify separate-copy behavior and lost-ack reconciliation. Duplicate-for-one-product plus parent-reference save was not exercised end to end. |
| 21 | Passed — preservation tests | An unresolved reference ID survives unrelated changes in UI-command tests. Read-only/deleted references have explicit unavailable previews; service tests reject newly selected missing references. All permission permutations remain untested. |
| 22 | Failed | Category assignment and applicability preview are not implemented. Seven definitions remain unresolved; category Size is a separate registry identity from variant rows. |
| 23 | Not tested — all round-trips | Live definitions preserve Rubik as text, Google as nullable boolean and boosts as a text list. Contract/editor tests preserve raw types and false/unset. Browser save/reload of all three values remains untested. |
| 24 | Blocked by capability | Connector stays at 2026-07; typed multiple barcodes require the verified 2026-10 schema and adapter upgrade. Barcodes remain read-only. Leading-zero SKU/code preservation is tested but is not multiple-barcode parity. |
| 25 | Failed | Decimal-safe base/compare-at price commands, zero/null distinction and exact comparisons pass tests. Unit-price measurement and cost editing remain read-only. |
| 26 | Failed | No Information inventory write is enabled. Item/location/state, authority, CAS, idempotency and order-concurrency integration are required before enabling it. |
| 27 | Failed | Status reads are separate from the read-only publication/scheduling registry entries. Store timezone is live verified. New status/publication/scheduling writes and variant support are not implemented/verified. |
| 28 | Failed | Full description HTML and SEO overrides have narrow adapter paths. Rich composition/sanitization and handle collision/redirect review remain incomplete; no real SEO/description mutation test was performed. |
| 29 | Failed | Revision conflicts, permissions, validation, interrupted native/media synchronization, lost acknowledgements and partial durable progress are covered by relevant service/browser tests. Full rate-limit/network/error matrix and actionable per-field partial results across every domain are incomplete. |
| 30 | Passed — mocked adapter/queue | Job acceptance and completion are separate. Exact media/native readback is required; mismatches produce unverified outcomes. See information-gateway and linked-products service tests, interrupted-sync.png. |
| 31 | Not tested — screen reader | Keyboard focus containment, focus restoration, meaningful control labels, grid indices and move announcements were inspected. A complete screen-reader session and all editor families remain untested. |
| 32 | Not tested — full performance targets | Synthetic 10,000 variants/61 columns, 40 keyboard samples: 34.3 ms p95 two-RAF proxy. 37 mounted row elements/216 cells at the sample. Actual paint, FPS, cached-media 200 ms, long-running memory and remote hydration targets remain unmeasured. |
| 33 | Not tested | No development-store mutation or storefront consumer verification. Existing theme files do not prove this feature's new edits render correctly. |
| 34 | Passed — handoff | README, coverage, JSON catalog, evidence receipts and this matrix separate implemented behavior, PIM additions, store discovery, API constraints and untested work. They explicitly decline full parity and accessibility certification. |

## Required next verification environment

Use an explicitly designated development store and products that can be mutated. Verify granted scopes and the configured write gate first. Record initial values and expected restore behavior, test one domain at a time, wait for asynchronous jobs and reread values before claiming completion. Production publication remains a separate decision. This is a handoff requirement, not a request to mutate the connected production store.
