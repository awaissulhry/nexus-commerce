# VP.F functionality matrix — 2026-09-12

GALE-JACKET, signed-in `awaissulhry`, local Docker `nexus_development`. Writes used the announced XAVIA fixtures only. Each database result below comes from a delayed read-back, not merely a mutation response. The two original XXS rows were not corrected.

`Screen` means an actual interaction in the signed-in browser. `Injected` means the named unit/integration suite exercised the handler with controlled inputs; it does not claim a live mutation. `Held` means the default explicitly requires a disabled control with its reason. Repeated row controls are grouped by implementation and their measured instance count.

Endpoint keys, with `p = /api/products/:id/studio`:

| Key | Endpoint |
|---|---|
| F | `GET p/family?market=&locale=` |
| S | `GET p/sheet?scope=&channel=&market=&locale=&accountId=` |
| A | `GET/PATCH p/variation-axes` |
| G | `POST p/family/generate` (`dryRun` then reviewed `previewToken`) |
| P | `GET/PATCH p/projection?channel=&market=&locale=&accountId=&aliasKey=` |
| I | `PATCH p/projection/children` on that exact coordinate |
| B | `PATCH /api/products/bulk` through `masterWrite` / `commitChannelRow` |
| T | `p/variants/import`: `GET template`, `POST diff`, `POST jobs/:jobId/apply`, `GET jobs/:jobId`, `POST jobs/:jobId/revert` |
| C | `GET /api/pim/relationship-choices` |
| Attach | `POST /api/pim/attach-to-parent` |
| Add | `POST /api/catalog/products/:id/children` |
| Unlink | `POST /api/amazon/pim/unlink-child` |
| Move | `POST /api/pim/reparent` |
| Delete | `GET /api/products/:childId/all-listings`, then guarded `DELETE /api/catalog/products/:id/children/:childId` |
| Demote | `POST /api/pim/demote-parent` |
| Promote | `POST /api/pim/promote-to-parent` |

| # | Scope / control | Behavior | Endpoint | Verification | Result |
|---:|---|---|---|---|---|
| 1 | Master / Colore and Taglia axis chips | Open Manage shared axes | A GET | Screen: both chips open the same dialog, 2 axes | Verified |
| 2 | Master / axis chip grips | Persist shared axis order | A PATCH | Screen drag + SQL parent56→57 Taglia/Colore; keyboard dialog restore57→58 Colore/Taglia | Verified; original order restored |
| 3 | Master / Add axis | Open dialog focused on attribute picker | A GET | Screen: focused `Add variation axis` | Verified |
| 4 | Axes dialog / attribute picker | Add chosen axis to draft | None until Save | Screen: remove Taglia, re-add `Size (Taglia)` | Verified; no mutation |
| 5 | Axes dialog / Remove, each axis | Remove axis from draft, preserve stored values until Save | None until Save | Screen removal/re-add; API `family-variation-axes` suite covers retained values | Verified |
| 6 | Axes dialog / up/down controls | Reorder draft, boundaries disabled | None until Save | Screen: Color up restored original order; first/last boundary controls disabled | Verified |
| 7 | Axes dialog / Save axes | CAS update of shared definition | A PATCH | Delayed `shared-axis-order-restored-readback.json`, Product58 | Verified |
| 8 | Axes dialog / Cancel and close | Discard draft; guard unsaved navigation | None | Screen Cancel; shared navigation guard and family tests | Verified |
| 9 | Master / Generate combinations button | Open generated-family preview | G dryRun | Screen: 560×510.5 dialog, 18 existing/0 new at restored baseline | Verified |
| 10 | Generate / each axis value input | Update dry-run plan | G dryRun | Screen fixture value `VPF SECOND`; generate plan/API transaction suites | Verified |
| 11 | Generate / SKU pattern | Recalculate planned SKUs; reject invalid/duplicate plans | G dryRun | Screen fixture SKU prefix; `generatePlan`, `family-generate` suites | Verified |
| 12 | Generate / Create variants | Create reviewed missing combinations as DRAFT, excluded everywhere | G apply | SQL: exactly2 SECOND children,0 listings; parent55→56; `generate-token-readback.json` | Verified; fixtures later unlinked |
| 13 | Generate / Cancel and close | Close without creating | None | Screen baseline Create0 disabled; Cancel closes | Verified |
| 14 | Master / Add variant menu | Offer Add child, Generate combinations…, Attach existing… | None | Screen opened all3 entries | Verified |
| 15 | Add variant / Add child | Collect SKU/axes, confirm, create child | Add | Screen + `add-child-readback.json`: DRAFT,0 listings, both axis stores match | Verified; fixture later unlinked |
| 16 | Add child / input fields, Add, Cancel | Validate draft, then use shared family action | Add | Screen fixture creation; `addVariation`/`familyActions` suites | Verified |
| 17 | Add variant / Generate combinations… | Same Generate dialog and implementation | G | Screen dialog opened from menu and button | Verified |
| 18 | Add variant / Attach existing… | Pick standalone product, confirm exact ID | C, Attach | Screen + delayed `attach-readback.json`, Giallo fixture2→3; later unlinked3→4 | Verified |
| 19 | Product picker / search, result, choose, Cancel | Search eligible products; carry selected ID into confirmation | C | Screen fixture search/attach; `familyActions` tests preserve confirmed IDs and cancel without writes | Verified |
| 20 | Both / Find | Filter displayed rows by SKU/name | None | Screen VPF and XXS filters; filtered selection2; source row-filter tests | Verified |
| 21 | Master / Excluded somewhere20 | Filter variants excluded on ≥1 connected coordinate | None | Screen20 children; toggle restores21 rows | Verified |
| 22 | Master / Missing axis values0 | Filter missing shared-axis rows | None | Screen0 rows; toggle/filter change restores family | Verified |
| 23 | Master / Duplicate combinations2 | Show variants in duplicate coordinate groups | None | Screen4 child rows in2 pairs; coverage tests | Verified |
| 24 | eBay / Excluded0 | Filter excluded children, retain listing parent | None | Screen parent only,0 children | Verified |
| 25 | eBay / Pinned values2 | Filter variants with ≥1 semantic difference | None | Screen parent+2 XXS children; pin/reset read-backs2→3→2 | Verified |
| 26 | eBay / Mapping errors0 | Open mapping to resolve target issues | None | Screen opens dock even at0; counts/labels tested | Verified |
| 27 | Both / Customise | Open shared column preferences from current grid state | None | Screen both scopes; shared column-state adapter | Verified |
| 28 | Customise / column visibility checkboxes | Apply visibility without changing data | None | Screen master WooCommerce hidden; eBay Colore hidden; restored | Verified |
| 29 | Customise / pin and ordering controls | Apply shared column order/lock preferences | None | Screen master Taglia pinned before Colore and retained on reopen; column-state adapter tests | Verified; reset restored |
| 30 | Customise / Apply, Reset, Cancel, close | Apply draft, restore defaults, or discard | None | Screen Apply/reopen/Reset in both scopes; shared DS behavior | Verified |
| 31 | Both / Export | Download editable variants template for current coordinate | T template | HTTP200/200,22 CSV lines each; eBay UI download | Verified |
| 32 | Both / Import | Open shared import drawer using variants transport | None | Screen Import with axis/inclusion template hint; no fixture banner | Verified |
| 33 | Import / file upload/dropzone | Upload file and calculate stored dry-run | T diff | Screen file chooser;1 changed/2 unchanged/1 pinned fixture preview | Verified |
| 34 | Import / Blank cells Ignore and Clear | Choose explicit blank-cell policy for preview | T diff on upload | Screen both descriptions/selection; import diff tests cover null/empty handling | Verified |
| 35 | Import / Download template | Download same file as Export | T template | Screen click; shared download callback; saved200 template evidence | Verified |
| 36 | Import / Apply changes | Apply stored reviewed diff | T apply/poll | `import-fixed-apply-readback.json`: listing7→8, inherited→Rosa VPF, Product2 unchanged | Verified |
| 37 | Import / Revert | Restore prior stored intent for applied cells only | T revert/poll | `import-fixed-revert-readback.json`: listing8→9, Colore override absent again | Verified |
| 38 | Import / Start over, Close, diff/outcome expansion | Reset/close review or expand bounded result lists | None | Shared import diff/job suites; live close and job flow | Verified by shared tests; large-result expansion not live-triggered |
| 39 | Both / More | Open shared overflow menu | None | Screen both menus | Verified |
| 40 | Both More / Saved views | Explain fixed column set | None | Screen disabled item; no inline toolbar note | Held as designed |
| 41 | Both More / Reload | Re-read exact current coordinate | F/P | Screen reload; parity probe confirms account/market/locale | Verified |
| 42 | eBay More / Preflight | Open Information's alias check | S | Screen21 rows/20 Image URLs issues; no provider request | Verified |
| 43 | Preflight / check and close controls | Reuse Information check and close modal | S | Screen check results; same AliasPublishControl implementation | Verified |
| 44 | eBay More / Add listing alias | Explain unavailable alias creation | None | Screen disabled reason matches split control | Held as instructed |
| 45 | Master More / Attach existing and Add child | Same registry actions as Add variant | C/Attach/Add | Shared registry; live Add variant rehearsals above | Verified |
| 46 | Master More / Promote to parent | Refuse already-parent GALE | Promote if eligible | Screen disabled reason; injected familyActions permission/role/confirmed-ID tests | Held on GALE |
| 47 | Master More / Demote | Confirm exact20 children and typed parent SKU | Demote after confirmation | Screen20-child confirmation, Confirm disabled until phrase; Cancel; injected force/ID tests | Verified without real-product mutation |
| 48 | Both / header selection checkbox | Select filtered rows only | None | Screen filtered2 and all21; inclusion unchanged; headerY226 unchanged | Verified |
| 49 | Both / parent and20 child selection checkboxes | Select rows independently of inclusion | None |43px before P/C identity on21/21 rows in each state; Space selects1 | Verified |
| 50 | Selection / Clear | Clear row selection | None | Screen0 selected; same BulkActionBar | Verified |
| 51 | Selection and row menu / Unlink | Confirm selected children, preserve axis values/listings | Unlink | Screen fixture unlink, delayed SQL parentIdnull; shared action tests | Verified |
| 52 | Selection and row menu / Move to another parent | Choose one parent and confirm one child | C/Move | Injected familyActions tests: one-at-a-time, role/permission/confirmed-ID behavior | Verified by injection; no live real-product move |
| 53 | Selection and row menu / Delete child | Read listing ownership before delete confirmation | Delete | Screen original XS refusal for live listing; injected no-listing delete and stale-selection cases | Verified without real-product deletion |
| 54 | Both / every identity row ⋯ | Show registry verbs with role/permission reasons | None until action | Screen parent/child menus; shared familyActions43 tests | Verified |
| 55 | Master / 40 shared-axis cells | Edit through one master writer, preserving the push-readable store | B | Fixture colour edit; scalar+nested variations+legacy all Rosso VPF; Product1→2 | Verified representative write + shared writer tests |
| 56 | Master / child inclusion checkboxes, each connected coordinate | Change that coordinate's inclusion | I | Same projection transport as eBay; live eBay fixture checkbox rehearsal; API account/market/CAS tests | Verified representative write; no real-child bulk toggles |
| 57 | eBay /20 inclusion checkboxes | Include/exclude child on selected listing | I | Delayed fixture listing state, excluded/unpublished/syncPaused retained | Verified |
| 58 | eBay /40 mapped-axis cells | Edit using Information column metadata and options | B | Screen16-option select; Blu/reset SQL5→6→7; exact column metadata parity | Verified representative write + routing tests |
| 59 | eBay / inherited link and pinned reset controls | Edit inherited value, or reset differing override | B | Pin/reset SQL1→2→3 and5→6→7; shared Product unchanged;2 semantic pinned rows | Verified |
| 60 | Parent axis/Included cells | Display em dash; no edit/checkbox | None | Screen both states | Verified |
| 61 | Both / column headers, menu, sort/resize | Shared AG Grid header interactions | None | Shared engine/column adapter tests; widths recorded per column; standalone editor gate awaits auth | Engine tests pass; browser gate pending |
| 62 | eBay / Edit mapping | Open420px frame track | P GET already loaded | Screen420 track/419 inner; grid shrinks; no vertical dock overflow | Verified |
| 63 | Mapping / specific target selectors | Preserve locked existing live axes and explain why | P PATCH if unlocked | Screen2 disabled controls with ItemID-specific reason; projection mapping tests | Held on live GALE axes |
| 64 | Mapping / specific drag grips and arrow keys | Reorder buyer-facing axis draft | None until Save | Screen pointer swap, keyboard inverse, live region; Save disabled after inverse | Verified |
| 65 | Mapping / Add a specific | Add an unmapped shared axis, respect limit | P PATCH on Save | Screen disabled because2/2 shared axes already mapped; projection-limit tests | Held with reason |
| 66 | Mapping / Order values | Open current channel-specific value order | None | Screen Colore2/Taglia10 values inclXXS | Verified |
| 67 | Order values / all grips, Use this order, Cancel, close | Reorder draft and transfer it back to mapping | None until Save | Screen pointer/keyboard; inverse+Use leaves Save disabled; SQL value-order rehearsal previously restored | Verified |
| 68 | Mapping / One listing radio | Keep all included variants in one listing | P PATCH on Save | Screen selected20/250; split contract tests | Verified |
| 69 | Mapping / One listing per axis radio | Describe split counts and hold until alias creation works | None while held | Screen2 listings10+10; reason supplied; disabled | Held as instructed |
| 70 | Mapping / Save mapping | Save mapping and presentation order atomically with CAS | P PATCH | Listing14→15→16→17; axis and value order read-backs; original orders restored | Verified |
| 71 | Mapping / Cancel and X | Close draft without saving | None | Screen close; reopen baseline; no additional SQL version | Verified |
| 72 | Frame / scope chips | Switch exact scope using shared studio mechanism | F/P/S and scope-readiness | Screen master↔eBay;5-coordinate parity; shared reader | Verified |
| 73 | Frame / Account, Market, content language | Use shared coordinate selectors; no implicit account fallback | Shared frame readers | Screen explicit eBay account selection; switching to Shopify clears account and chooses GLOBAL; account-navigation.json; resolver tests | Verified current coordinate, channel switch and injected ambiguity cases |
| 74 | Frame / save state and main scope action | Use Information strings and behavior | Shared frame route/control | Screen `Saved HH:mm`/`Choose listing destinations`; eBay `Nexus draft autosave`/`Review listing information` | Verified shared vocabulary; no publish action invoked |
| 75 | Navigation / expand and close | Toggle224px drawer beneath56px top bar | None | Screen224×844; both gestures | Verified |
| 76 | Navigation / Information and Variants | Navigate while preserving coordinate | S/F/P | Screen both surfaces, actual completeness comparison | Verified |
| 77 | Navigation / Relationships | Render approved placeholder | None | Screen verbatim §9 placeholder | Verified |
| 78 | Navigation / Media, Needs attention, Performance, Activity | Open corresponding existing studio surfaces | Existing media/diagnostics/analytics/activity readers | Screen visits saved in navigation-controls.json | Verified |
| 79 | Navigation / channel Listing information, eBay Description themes, Shopify Product family, Return to Products | Use approved route destinations | Existing destination readers | Screen: all channel listing pages, Description themes, Product family, Return to Products; channel-navigation-controls.json | Verified |

The complete raw control inventories, including dimensions, disabled states and accessible labels, are in `after-{master,ebay,mapping,generate,navigation}.json`. The API/Studio suites pass; the full standalone census, editor and layout runs remain blocked by missing test authentication. This matrix does not certify those unrun browser checks.
