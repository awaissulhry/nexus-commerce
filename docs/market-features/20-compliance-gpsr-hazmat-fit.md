# 20 — COMPLIANCE: GPSR/EU checklist, hazmat, PPE + protector rows, certificates, channel×cert matrix, Amazon FIT/COMPATIBILITY

## 1. What it is (operator terms)

Xavia sells motorcycle gear from Italy into EU Amazon and eBay. Three separate legal obligations
land on the same product record. (a) **GPSR/DSA** (mandatory since Dec 2024): every EU listing must
name a registered manufacturer contact and an EU Responsible Person, and either attest "no safety
documentation needed" or attach a safety document in the marketplace's language — Amazon suppresses
the listing otherwise. (b) **PPE Directive 2016/425 + EN 17092/EN 1621**: a jacket is Cat I/II/III,
carries a garment class (AAA…C), a Notified Body, a Declaration of Conformity, and a *list of impact
protectors* (zone × standard × level) — one row per armour piece. (c) **ADR/IATA dangerous goods**
for the accessories range (chain lube, aerosols, airbag gas canisters): a flag, a UN hazard class,
a UN number. On top sit **certificates as documents** — CE, EN 13595, EN 22.05, REACH, RoHS, WEEE,
ATEX — each with an issuing body, a number, a file and an **expiry date**, and expiry is the thing
that bites: a CE certificate that lapsed last month makes every EU listing non-compliant while the
sheet still says 100% ready. The operator touches this rarely (onboarding a new SKU, a cert renewal,
a supplier change) but the cost of getting it wrong is a suppressed listing or a fine, so it must be
*visible without being asked for* rather than parked behind a tab nobody opens. Separately, **fit /
compatibility** is a merchandising question, not a legal one: for apparel it is sizes, department,
fit type, material, CE protection; for parts it is which motorcycles the part fits.

## 2. Old UI — inventory

### 2.1 The `Compliance` tab — `tabs/ComplianceTab.tsx` (904 lines, one file)

Entry: 17-key canonical tab strip (`_shared/useTabPrefs.ts:61`, parity 1.10) →
`ProductEditClient.tsx:67` (import), `:1393-1401` (mount, `topTab === 'compliance'`, gets the whole
`product` object plus `discardSignal` / `onDirtyChange`).

Five stacked sections:

| section | file:line | shape | persistence |
|---|---|---|---|
| PPE category (Cat I/II/III + None) | `:521-587` | 4 radio cards with descriptions, `labelIt` for the IT locale (`:87-106`) | dirty → explicit **Save** |
| Protective equipment (CE/PPE) | `:589-653` | garment class `Listbox` (EN 17092, `:120-126`), DoC URL, Notified Body number + name; **protector rows** `:636-648` — a `grid-cols-[1fr_1fr_auto_auto]` repeater of zone / standard / level `Listbox`es + a delete `IconButton`, add/remove/update at `:510-513` | same Save |
| Hazmat | `:655-709` | a checkbox that *reveals* class + UN number text inputs | same Save |
| Save bar | `:711-720` | appears only when `dirtyRef.current > 0` | `PATCH /api/products/bulk`, `If-Match: product.version` (`:423-430`) |
| Certificates | `:722-859` | `AddCertForm` (`:198-310`, 8 fields, two DS `DateField`s), a collapsible row list with a status `Badge` (`CertStatusBadge` `:166-188`), file link, delete | **persists immediately**, no dirty tracking (header `:13-15`) |
| Channel×certificate matrix | `:861-901` | 4 hardcoded rows built at `:483-508` (Amazon EU / eBay IT-DE-FR-ES / EN 13595 body protection / REACH) each with `requirements[]`, a met/unmet glyph and per-cert badges | read-only, derived client-side from `certTypeSet` (`:478`) |

Server round-trips: `GET /api/products/:id/certificates` (`:388`), `POST` (`:215`),
`DELETE .../certificates/:certId` (`:461`), `PATCH /api/products/bulk` (`:423`). The **PATCH** path is
the same one the studio's `SheetWriter` already uses (`design-system/grid/editors/sheetWriter.ts:334`,
`:572` — `expectedVersion` per row).

Browser-local / never persisted: `expandedCerts` Set (`:322`), the 8-field dirty count
(`:341-363`), and **`hazmatEnabled`** (`:326-328`) — a UI-only boolean *derived* from
`hazmatClass || hazmatUnNumber`; unchecking clears both (`:669-675`).

### 2.2 Amazon cockpit cards

`AmazonCockpit.tsx:58-59` (imports), `:798-814` (mounts). Both read-only; both edit by jumping to the
"classic" field editor (`handleJumpTo('classic')`) — a link-out D9 removed.

- **`compliance/ComplianceCard.tsx`** (164 lines): a 5-item checklist over
  `listing.platformAttributes.attributes` (Amazon flat-file shape), required = country of origin +
  GPSR, optional = manufacturer / battery / hazmat; a `n/2 required` pill (`:98-107`).
- **`fit/FitCompatibilityCard.tsx`** (146 lines): adaptive — `detectMode` (`:49-56`) returns
  `fitment` if any vehicle attribute is present or the product type contains one of 10 substrings
  (`FITMENT_HINTS`, `:47`), else `sizeFit`. Rows at `:73-87`. Sizes fall back to a **count** of
  variants when `variationTheme` contains the substring `'size'` (`:68-71`).

### 2.3 What is DEAD in the old tree

- **The card's GPSR row reads three keys that exist nowhere.** `ComplianceCard.tsx:56-62` tries
  `gpsr_safety_attestation`, `eu_responsible_person`, `responsible_person_address`,
  `manufacturer_contact_information`. The last three "exist in ZERO of the 72 live cached schema
  definitions" — measured, and written into
  `services/compliance-resolver.service.ts:226-233` (UFX P6e). The **real** keys are
  `gpsr_manufacturer_reference` and `dsa_responsible_party_address`, and the card reads neither. So
  the card's GPSR verdict rests on one live key out of four. **CODE-READ.**
- **The hazmat row reads dead keys too.** `:80` tries `dangerous_goods_regulations`, `hazmat`,
  `ghs_classification_class`; each appears in exactly **one** file in the repo (its own).
  The live keys are `supplier_declared_dg_hz_regulation` (10 files) and `ghs_chemical_h_code`
  (`_studio/sheet/views.ts:124`). **CODE-READ.**
- **The whole fitment arm of `FitCompatibilityCard` is reading dead keys**: `compatible_vehicle`,
  `part_finder`, `compliance_certification`, `ce_certification`, `protective_equipment_use` each
  appear in one file — their own. The real eBay Motors fitment lives elsewhere (§3.6). **CODE-READ.**
- **Country of origin is read from the wrong store**: the card reads it out of the listing's
  attribute bag, never from `Product.countryOfOrigin` — which is where the master value and the
  compliance resolver both live — so a filled master row can read "Missing". **CODE-READ.**

## 3. Backend that exists

### 3.1 Routes

| method + path | file:line | notes |
|---|---|---|
| `GET /api/products/:id/certificates` | `routes/product-certificates.routes.ts:31` | `orderBy createdAt desc` |
| `POST /api/products/:id/certificates` | `:58` | validates `certType` against 8 values (`:25-27`), 201 |
| `PATCH /api/products/:id/certificates/:certId` | `:106` | partial |
| `DELETE /api/products/:id/certificates/:certId` | `:141` | hard delete, **no audit-log write** |
| `PATCH /api/products/bulk` | `routes/products.routes.ts` — validators `:1800` (countryOfOrigin ISO-2), `:1809` (ppeCategory), `:1822` (garmentClass), `:1833` (impactProtectors array) | the studio's own write path |
| `GET /api/listing-wizard/:id/compliance-status` | `routes/listing-wizard.routes.ts:4707-4896` | the channel×cert matrix, per (platform, marketplace); **wizard-scoped**, so unusable from the studio as-is |
| `PATCH /api/ebay/cockpit/compatibility` | `routes/ebay-cockpit.routes.ts:1516-1576` | eBay Motors fitment sub-table, `{universal, fitments[{year,make,model,submodel}]}`, capped 1000, into `platformAttributes.compatibility` |

Registered: `index.ts:146` + `:794` (`prefix: '/api'`).

### 3.2 Prisma

- `model ProductCertificate` — `packages/database/prisma/schema.prisma:12649-12674`:
  `certType`, `certNumber`, `standard`, `issuingBody`, `issuedAt`, `expiresAt`, `fileUrl`, `notes`;
  indexes `[productId]`, `[productId, certType]`, **`[expiresAt]`** (the expiry sweep is already
  indexed). No unique constraint on `(productId, certType)`.
- `Product` compliance columns — `schema.prisma:377-398`: `hsCode`, `countryOfOrigin`,
  `ppeCategory`, `hazmatClass`, `hazmatUnNumber`, `garmentClass`, `notifiedBodyNumber`,
  `notifiedBodyName`, `declarationOfConformityUrl`, **`impactProtectors Json?`**, `certificates[]`.
- Migrations already applied: `20260506_h16_compliance`, `20260510_w7_1_compliance_certificates`.

### 3.3 The canonical resolver — `services/compliance-resolver.service.ts` (483 lines)

Pure and unit-tested (`compliance-resolver.vitest.test.ts`): `buildCompliancePayload:111`,
`evaluateCompliance:155`, `complianceBlockers:210`, `buildAmazonComplianceColumns:239`,
`COMPLIANCE_MEDIA_BY_MARKETPLACE:264`, `buildAmazonComplianceMediaColumns:285`,
`buildComplianceMediaFill:312`, `buildSafetyStatements:339`, `buildDangerousGoodsStatement:363`,
`buildShopifyComplianceMetafields:383`; DB wrappers `getBrandCompliance:417`,
`resolveComplianceById:436`, `resolveComplianceForSkus:460`.

Rules (`:166-206`): PPE Cat II/III on EU + no CE cert ⇒ **block**; CE expired ⇒ **block**; CE within
90 days ⇒ warn; missing DoC on CE-marked PPE ⇒ warn; REACH expired on EU ⇒ warn; dangerous goods on
Amazon ⇒ warn (separate Seller-Central upload); missing HS code / country of origin cross-border ⇒
warn; EU without a Responsible Person ⇒ warn. The RP comes from the single `BrandSettings` row
(`:417-433`) — **account-level, not per product**.

### 3.4 Readiness (the studio's only compliance today)

`services/pim/readiness.service.ts:198-203` delegates to
`checkGpsrCompliance` (`services/listing-preflight.service.ts:362-460`), **warnings only**, bounded
by the scope's real column set (`readiness.service.ts:158`) and honest about partial coverage in its
own header (`:39-50`). `GPSR_EU_MARKETPLACES` = **8** codes (`listing-preflight.service.ts:308`:
ES FR BE NL DE IT SE PL) — 🔴 `readiness.service.ts:14-16` says "**NINE** of the twenty active
Marketplace rows", then lists eight. The set is 8. **CODE-READ.**

### 3.5 Channel calls and safety gates

- **Amazon flat-file submit** (untouchable area): `routes/amazon-flat-file.routes.ts:446`
  (`resolveComplianceForSkus`), `:589-593` fills the compliance columns **non-clobbering** (operator
  value wins, `:592`), `:599-600` the `compliance_media` triple; preflight preview at `:761`, `:791-798`.
- **eBay publish**: `routes/ebay-cockpit.routes.ts:1154` resolves, `:1158-1169` **blocks 422** on a
  blocking issue — but only `if (getEbayPublishMode() === 'live')`, and the gate defaults to
  `'dry-run'` (`services/ebay-publish-gate.service.ts:40-46`). `overrideCompliance:true` bypasses
  with a log line (`:1161-1168`). GPSR container + `productSafety` statements sent at `:1200-1210`.
- **Shopify**: `services/outbound-sync.service.ts:1914-1915` → `compliance` namespace metafields.
- **eBay adapter statements**: `services/listing-wizard/ebay-publish.adapter.ts:203-204`.

### 3.6 Jobs

`jobs/cert-expiry-alert.job.ts` — `'40 6 * * *'` UTC, horizon `NEXUS_CERT_EXPIRY_HORIZON_DAYS`
(default 90), opt-out `NEXUS_ENABLE_CERT_EXPIRY_ALERT_CRON=0`, started at `index.ts:264`. Counts
expired/expiring + a top-5 sample into the cron observability log. **Observability-only**:
`getCertExpiryAlertStatus()` (`:101`) has **zero consumers in `src`** — grep finds only its own
definition and the built `.d.ts`. The "operator's morning dashboard" in its header does not exist.

### 3.7 Permissions

`product-certificates.routes.ts` declares **no `preHandler`**. The global manifest maps it by prefix:
`RW(F.productsView, F.productsEdit, pfx('/api/products'))` —
`lib/auth/permissions-manifest.ts:412`. So `products:view` reads certificates and **`products:edit`
can delete one**, with no audit row. There is no compliance-specific permission in the manifest.

## 4. Studio today

**Nothing.** `grep -rniE 'gpsr|complian|hazmat|ppe|certificat'` across
`apps/web/src/app/products/[id]/edit/_studio/**` returns zero substantive hits.

What *does* exist, and a correction to the parity row:

- 🔴 **Parity 6.41's "PPE category and the hazmat flag/class/UN number … appear as sheet columns" is
  not what the code does.** Master sheet columns come from the field registry
  (`services/pim/sheet-columns.service.ts:213-215` `BuildSheetColumnsInput.fields`, filled at
  `:897-898` from `getAvailableFields`), and `services/pim/field-registry.service.ts` contains **no
  compliance master field at all** — `UNIVERSAL/PRICING/INVENTORY/IDENTIFIER/PHYSICAL` at
  `:63-123`, composed at `:257-261`; no `ppeCategory`, `hazmatClass`, `hazmatUnNumber`,
  `garmentClass`, `notifiedBody*`, `declarationOfConformityUrl`, `hsCode`, `countryOfOrigin`.
  What is on the sheet is **Amazon's own schema attributes** (`supplier_declared_dg_hz_regulation`,
  `gpsr_safety_attestation`, `dsa_responsible_party_address`, `country_of_origin`,
  `safety_data_sheet_url`, `ghs_chemical_h_code`, `batteries_*`) with `storage:
  'categoryAttributes'` and `writeField: 'attr_*'` — **a different store from the `Product` columns
  the resolver and the publish gate read.** Only four Amazon attributes carry a `masterKey`
  (`services/pim/channel-specs/amazon.ts:45-50`: `item_name`, `product_description`,
  `bullet_point`, `generic_keyword`), so none of the compliance keys joins to its master twin.
  **CODE-READ.**
- The **Logistics** view preset already gathers the compliance keys —
  `_studio/sheet/views.ts:150-155` matching `LOGISTICS_KEYS` (`:122-129`), described as "Stock,
  dimensions **and compliance**". There is no `Compliance` preset.
- **Essentials rule 4** already forces the GPSR pair on screen when readiness flags it —
  `views.ts:219-222`, ruling **#173** (`docs/pes-claims.md:18396-18426`, measured
  `dsa_responsible_party_address` + `gpsr_safety_attestation` flagged on 104 of 120 rows).
- View-chip registry: `_studio/contracts.tsx:236` (`useRegisterViewChip`); producers
  `_studio/sheet/channel/viewChips.ts:111-149` (3 chips) and `master/MasterSheet.tsx:753` (1).
  The honest-count rule (`viewChips.ts:8-15`, `_studio/viewChips.ts:37-52`) — `null` ≠ `0` — binds
  any chip I add.
- Drawer: 4 panes, `drawer/RecordDrawer.tsx:59` (`TabId`), `:471-484` (tab list), `:568-624`
  (render); `panes/ListingsPane.tsx` is the precedent for a read-only depth pane that declares no
  verbs of its own (`:1-19`, `:41-42`). Reads go through `drawer/useStudioRead.ts` (last-request-wins,
  abort, 30s deadline, **404/501 ⇒ `unavailable` not `error`**, `:33-35`).

### Parity rows and rulings that bind this feature

| row | status in `docs/pes-parity-audit.md` |
|---|---|
| 3.27 ComplianceCard | `:149` 🔁 — "GPSR/EU fields are ordinary columns and appear in readiness — measured: the 42 eBay·IT warnings ARE the GPSR pair" |
| 3.28 FitCompatibilityCard | `:150` 🕳 — "no fit/compatibility surface" |
| 6.41 PPE + protectors + hazmat | `:410` 🕳 (scalar half 🔁, split deliberately) |
| 6.42 Certificate CRUD | `:411` 🕳 — "document management, not attribute editing … needs a surface decision rather than a column" |
| 6.43 Channel×cert matrix | `:412` 🕳 — "Depends on 6.42" |

🔴 **3.27's evidence has since been retracted in the ledger.** The 42 eBay warnings were
`requiredBy: ['Amazon · DE']` **leaking onto the eBay scope** — `docs/pes-claims.md:15830-15836` —
and after BE-1 landed, "the coordinate returns eBay's 35 columns and the GPSR/DSA pair that produced
the 42 is gone with it — the 42 was entirely Amazon's `requiredBy` leaking"
(`docs/pes-claims.md:15092-15094`). So GPSR readiness reaches **master and Amazon scopes only**; the
eBay scope has no GPSR coverage at all today. 3.27 should be re-marked. **MEASURED-IN-DOC.**

Rulings:
- **#173** (`:18396`) — Essentials rule 4; the GPSR pair is its worked example.
- **#448** (`:10058-10064`) — on master DE, `dsa_responsible_party_address [1979..2139]` and
  `gpsr_safety_attestation [2139..2269]` are **permanently covered by the 520px drawer**, "the exact
  fields #173's view exists to surface".
- **#472** (`:9559-9575`) — the §9.2 tail ordering mitigates but does not fix it: "the GPSR and DSA
  fields … sit inside the permanently covered zone".
- **#449** (`:10032-10057`) — a declared column with no cell is "NEVER ATTEMPTABLE"; master's 102
  declared columns serve 21 cells, and the missing set names the GPSR pair (`:10036`). RULING: the
  row carries a cell for **every** declared column, empty ones included, each with its own
  `writable` / reason. Any compliance column I add inherits this.
- **#489** (`:9156-9165`) — length caps are displayed and **not enforced**; the worked example is
  `attr_ceCertification` at 5,000 chars written straight into `overrideData`.
- **AM.1 §A.3a** (`docs/2026-09-04-channel-attribute-model-design.md:161-169`, approved 2026-09-05)
  — no exclusions; the compliance compounds become columns and "the column reads and writes **the
  same store that surface uses**"; the spec carries `ownedBy?: 'images'|'pricing'|'inventory'|
  'compliance'` (`:111`) named in the tooltip. 🔴 **`ownedBy` has zero occurrences in the codebase**
  — spec only, unbuilt. Amazon's compliance shapes per that doc (`:38`, `:153-155`):
  `gpsr_manufacturer_reference` single-valued, `hazmat` and `compliance_media` **measure**
  (value+unit), `ghs` **compound**, `supplier_declared_dg_hz_regulation` an **unbounded list**
  (max 1000) ⇒ one chip-list column.

## 5. Defects and slowness

1. **A 904-line component with five unrelated concerns and no test.** `ComplianceTab.tsx`: 12
   `useState` + 8 `useRef` originals, two different save contracts in one panel, three hardcoded
   vocabularies (`:87-133`), and no test file anywhere for it. **CODE-READ.**
2. **A read waterfall on every open.** The page loader fetches `/api/products/:id`
   (`edit/edit-data.ts:38`), whose handler is a bare `findUnique` with no `include`
   (`routes/products.routes.ts:404`), so certificates need a second round trip after mount
   (`ComplianceTab.tsx:385-396`). **CODE-READ.**
3. **A needless refetch.** `loadCerts` re-runs on every `discardSignal` change
   (`ComplianceTab.tsx:396`) although certificates persist immediately and Discard cannot affect
   them. **CODE-READ.**
4. **FOUR copies of the compliance rules, already diverged.** `evaluateCompliance`
   (`compliance-resolver.service.ts:155`), the wizard endpoint's inline `buildIssues`
   (`listing-wizard.routes.ts:4764-4844`), `ComplianceTab.tsx:483-508`'s `channelReqs`, and
   `ComplianceCard.tsx:45-82`'s item list. The resolver's own header claims the endpoint is "kept in
   lock-step" (`:87`, `:152`) — it is not: the endpoint has **no** `gpsr_responsible_person_missing`
   and **no** `doc_missing` check. And the tab's matrix takes no marketplace at all, so "Amazon EU"
   is one undifferentiated row across nine markets. A banked "lock-step" claim that went false —
   `reference_a_banked_rule_can_go_false`. **CODE-READ.**
5. **Two EU definitions for one regulation.** `EU_MARKETS` = 17 codes
   (`compliance-resolver.service.ts:88`) vs `GPSR_EU_MARKETPLACES` = 8
   (`listing-preflight.service.ts:308`). A product on AT or IE is "EU" to the CE/DoC rules and
   invisible to the GPSR check. **CODE-READ.**
6. **Three stores for CE data, none reconciled.** (i) the `ProductCertificate` row — the only one
   the publish gate reads; (ii) `attr_ceCertification`, a live writable OUTERWEAR column
   (`field-registry.service.ts:214`, exercised through the real write path in ruling #489 and #494);
   (iii) `Product.notifiedBodyNumber` / `garmentClass`. An operator typing a CE number into the
   sheet cell satisfies nothing the gate checks. **CODE-READ + MEASURED-IN-DOC.**
7. **`country_of_origin` and the hazmat/GPSR keys have two stores that silently disagree.** The
   sheet cell writes `attr_*` into the attribute bag / `overrideData`; the resolver reads the
   `Product` column; the flat-file submit fill is deliberately non-clobbering
   (`amazon-flat-file.routes.ts:592`), so **the bag wins and the master column is never sent**.
   No `masterKey` links them (`channel-specs/amazon.ts:45-50`). **CODE-READ.**
8. **The only BLOCK-severity compliance rule in the codebase is effectively unreachable.** The
   studio's publish preview computes verdicts from readiness alone
   (`services/pim/sheet-publish.service.ts:81-93`) and never calls `complianceBlockers`; the one
   caller that does is gated on `getEbayPublishMode() === 'live'`
   (`ebay-cockpit.routes.ts:1158`) while the gate defaults to `dry-run`
   (`ebay-publish-gate.service.ts:42`). An expired CE certificate blocks nothing today.
   **CODE-READ.**
9. **Which CE certificate the gate reads is unspecified.** `certificates.find(c => c.certType ===
   'CE')` (`compliance-resolver.service.ts:117`) takes the first; `resolveComplianceById`'s
   `certificates` select has **no `orderBy`** (`:446-448`) and there is no unique constraint on
   `(productId, certType)`. Two CE rows — a lapsed one and its renewal — and the verdict depends on
   row order. **CODE-READ.**
10. **The expiry cron talks to nobody.** `getCertExpiryAlertStatus()`
    (`jobs/cert-expiry-alert.job.ts:101`) has zero consumers; the 90-day horizon is a **third**
    copy of the number that also lives at `ComplianceTab.tsx:140` and
    `compliance-resolver.service.ts:173`. **CODE-READ.**
11. **No file handling.** `fileUrl` and `declarationOfConformityUrl` are free-text; the POST/PATCH
    route validates neither scheme nor reachability (`product-certificates.routes.ts:76-88`,
    `:119-135`), while the GPSR media check *does* require `https://` and a
    pdf/jpg/png extension (`listing-preflight.service.ts:435-439`). A cert the operator "attached"
    can be an `http://` link that Amazon refuses. **CODE-READ.**
12. **`hazmatEnabled` is unrepresentable state.** UI-only, derived (`ComplianceTab.tsx:326-328`) and
    it clears both fields when unticked (`:669-675`), so "this is dangerous goods, class TBD" cannot
    be stored — and the flag itself never reaches the database. **CODE-READ.**
13. **Certificate deletion is unaudited and ungated beyond `products:edit`**
    (`product-certificates.routes.ts:141-154`, `permissions-manifest.ts:412`) — a legal document
    disappears with no trace, on the same permission as editing a price. **CODE-READ.**
14. **The `impactProtectors` validator accepts anything.** `products.routes.ts:1841-1847` stringifies
    `zone`/`standard`/`level` with no check against the three EN standards or two levels the UI
    offers (`ComplianceTab.tsx:127-133`), so a paste writes junk that
    `buildSafetyStatements` (`compliance-resolver.service.ts:339-357`) will happily print onto an
    eBay `productSafety` container. **CODE-READ.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Primary: H1 (cells) for every scalar + H7 (a new drawer pane) for the two sub-tables.**
Mirrors: **H6** (a `Compliance` view preset + a `GPSR missing (n)` view chip), **H2** (a
`Certificates` status column on master), **H9** (an Errors & Sync group for expiry), **H11**
(the Responsible Person stays in Brand Settings).

**H1 — the scalars are already the sheet's job, and nine of them are missing from it.** PPE
category, garment class, Notified Body number/name, DoC URL, hazmat class, UN number, HS code and
country of origin are single-valued fields on one product; a radio-card stack and two text inputs
are a form built for one record, and the studio edits twenty-one at once. Nine SKUs needing Cat II
set is nine cells and a fill-drag, not nine tab visits. This is not a new mechanism: it needs those
nine `FieldDefinition` entries added to `field-registry.service.ts` (they are already writable —
`master-field-gate.ts:60-71` — and already validated — `products.routes.ts:1800-1848`), plus the
`masterKey` links that make Amazon's `country_of_origin` / `supplier_declared_dg_hz_regulation` /
`gpsr_safety_attestation` cells **write the master column instead of the attribute bag** (AM.1
§A.3a's own rule: "the column reads and writes the same store that surface uses"). Defects 6 and 7
close as a consequence, and #449's "a cell for every declared column" is honoured.

**H7 — protector rows and certificates are not cells, and forcing them into cells would lie.** A
protector list is 0–6 ordered triples; a certificate is a document with an issuing body, a number, a
file and an expiry. Neither has a scalar cell shape, and AM.1's four shapes (scalar / list / measure
/ compound) deliberately do not include "a table inside a cell". They are per-**product** (not per
variation, not per coordinate) and rarely edited, which is exactly the drawer's brief: depth,
non-modal, sheet stays live. A **fifth drawer pane, `Compliance`**, holds two DS `DataGrid`
sub-tables — Protectors (zone · standard · level · remove) and Certificates (type · number ·
issuing body · expiry `Pill` Valid/Expiring/Expired · file link · remove) — plus a compact
channel×certificate strip. `ListingsPane` is the precedent (`panes/ListingsPane.tsx:1-19`): read
detail lives in a pane, verbs come from the registry.

**H6 — a `Compliance` preset and a `GPSR missing (n)` chip, because this is the failure the sheet
must not hide.** The `Logistics` preset already sweeps these keys (`views.ts:150-155`) but bundles
them with stock and dimensions, and its own description says "and compliance" — a tell that the
concern is riding along rather than owned. A `Compliance` preset (rule-shaped, matching
`storage`/`group`/key, never a key list — `views.ts:18-24`) plus a view chip whose cells are exactly
the rows the resolver flags gives the operator the two-click path #173 was designed for. And it
answers **#448/#472 for free**: the chip *filters and jumps to cells*, so the GPSR pair being stuck
in the drawer-covered trailing band stops mattering for the one path that matters.

**H2 — one derived `Certificates` column on master**, `3 valid · CE exp 12/03/26`, filterable, with
the expiry tone. This is the only compliance fact that is a *count of documents* rather than a
value, so it belongs in the status-column vocabulary (buy-box, A+ state, sync state) and not in a
cell. It is also the surface the cron finally reports to (defect 10).

**H9 — expiry is a queue, not a per-row footnote.** Certificates expiring across the catalogue is
exactly the Errors & Sync console's shape: grouped by cause, rows jump to the sheet or drawer. The
cron already computes the set with an index for it (`schema.prisma:12673`).

**H11 — the EU Responsible Person is account-level and stays in Brand Settings**
(`compliance-resolver.service.ts:417-433` reads the single row). The studio must *say so* rather than
offer a per-product field: the resolver's own warning already names the destination ("set it in
Brand Settings", `:203`). Putting an RP field on a product would create a fifth store.

**Fit / compatibility: H1 only, and 3.28 is mostly 🗳 OWNER.** Every row of the Amazon card is a
plain schema attribute (`size`, `department_name`, `fit_type`, `outer_material_type`, `make`,
`model`, `vehicle_year`) — under AM.1 those are already columns on the Amazon scope, so the card is
a read-only re-render of cells the sheet shows better. Its two pieces of *logic* are both broken:
`detectMode` guesses from a product-type substring (`:47-56`) and the size row counts variants from a
localised `variationTheme` label (`:68-71`) — the exact trap ruling #711 fixed in `views.ts:177-192`
("an axis is what the CONTRACT says it is, never a substring of a localised label"). I recommend
**dropping the card** and covering the need with a `Fit & sizing` view preset. The real
fitment sub-table is **eBay Motors** (`PATCH /api/ebay/cockpit/compatibility`,
`ebay-cockpit.routes.ts:1516`, `{universal, fitments[]}` capped at 1000, plus a 478-line
`ebay-cockpit/cards/CompatibilityCard.tsx`) — that is a different feature with a different channel
and a different store, and it needs its own H7 pane owned by whoever holds the eBay cockpit rows.
Flagging the boundary rather than absorbing it.

### 6.2 What the sheet shows at rest, per scope

| scope | columns | marks | chip |
|---|---|---|---|
| **master** | the 9 scalar compliance columns (new registry entries), grouped `Compliance`; **`Certificates` status column** (H2, read-only: `n valid`, next expiry, tone from the 90-day rule) | per-cell provenance as any master cell; the `Certificates` column is non-interactive ⇒ it belongs in the §9.2 tail (#472) | `Compliance (n)` — rows with a blocking or warning compliance issue |
| **Amazon · IT/DE/…** | the same 9 (now `masterKey`-linked, so 🔗 inherited / ✎ pinned works) + Amazon's own `gpsr_safety_attestation`, `dsa_responsible_party_address`, `supplier_declared_dg_hz_regulation` (chip-list), `safety_data_sheet_url`, `ghs_chemical_h_code`, `compliance_media__*` | ⚠ on every cell the GPSR check flags (already live via `readiness.service.ts:198-203`) | `GPSR missing (n)` on the 8 GPSR markets; **absent, not zero,** elsewhere |
| **eBay · IT/DE/…** | the master 9 only (eBay declares no GPSR aspects) | — | 🔴 no GPSR chip until eBay's own product-safety fields are specced; the chip must be **absent**, never `(0)` — `viewChips.ts:8-15` |
| **Shopify (GLOBAL)** | the master 9 | — | absent |

Nothing about certificates or protectors is drawn in a cell. The `Certificates` column is the only
hint they exist, and its tooltip says where they live: "3 certificates · CE expires 12 Mar 2026 —
open the record's Compliance pane".

### 6.3 The interaction, step by step

**Editing a scalar** — unchanged from every other cell: type or Enter to edit, autosave through the
one `SheetWriter` (`PATCH /api/products/bulk` with `expectedVersion`), fill-drag works, ⌘Z works.
PPE category and garment class are `strict` selects, so they get the D18 popover editor. No new
mechanism, no new save contract.

**Opening the pane** — `open-record` from the identity cell / Enter on identity (layout §5.5), then
the `Compliance` tab in the drawer's `Tabs`. The pane fetches through `useStudioRead` (deadline,
abort, 404/501 ⇒ "not shipped yet" rather than an error). Sheet stays live behind it.

**Adding a protector** (COLLECT → RUN, no preflight — it is a local edit, not an operation):
`Add protector` appends a row to the DS `DataGrid`; three `Listbox`es (zone / standard / level);
on change the pane writes the **whole array** as one cell edit —
`{field: 'impactProtectors', value: [...]}` through the same `SheetWriter`, same
`expectedVersion`, same autosave indicator. Repaints: the pane's table, the row's readiness pill if
the DoC/PPE rules move, the `Compliance` chip count. 🔴 It needs the nav guard
(`reference_autosave_still_needs_a_nav_guard`) and a debounce, because a `Listbox` change fires per
keystroke of type-ahead.

**Adding a certificate** (COLLECT → RUN): `Add certificate` opens an inline form in the pane
(DS `Field` + `Input` + `Listbox` + two `DateField`s + `FileDropzone` if an upload endpoint is ever
built; a URL `Input` until then). `POST /api/products/:id/certificates` — persists immediately,
which is the **existing** contract for this data and worth keeping deliberately: a legal document is
either filed or not, and a dirty-tracked draft certificate is a worse lie than an immediate write.
The pane must *say* "saved" distinctly from the sheet's autosave, because the two are different
mechanisms and the parity audit already flags the split (`docs/pes-parity-audit.md:493`).

**Deleting a certificate** — 🔴 this one is an **H3 ROW verb** in the action registry, not a pane
button, because a verb must never live only in the drawer (channel-ops research §3.2) and because
deletion of a legal document earns a preflight. `delete-certificate` declares
`preflight` returning an `ActionImpact` whose `consequences` name what breaks — "CE is the
certificate the EU publish gate reads; deleting it will block Amazon IT, DE, FR, ES" (computable
from `complianceBlockers` with the cert removed) — and `ActionConfirm` takes the level from that
impact, never a fixed flag (`design-system/grid/actions/registry.ts:84-99`, `:197-204`).

**Keyboard**: the pane is a normal drawer pane — Tab through the sub-table, Escape returns focus to
the sheet cell that opened the record (`drawer/revealCell.ts` already owns the anchor). With the
drawer open the sheet keeps its own focus and the reveal inset applies; the compliance cells are the
#448 worked example, so the chip-jump path (which scrolls the cell into view *before* the drawer
opens) is the one to prefer over opening the record from those cells.

### 6.4 Per-scope rules

- **Master vs channel.** The 9 scalars are `scope: 'global'` — they live on the parent and every
  variation inherits (a jacket's PPE category does not vary by size), so a variation row shows 🔗
  and pinning one is possible but unusual. **Protectors and certificates are product-level and
  parent-only**: the pane on a child row must show the parent's set, read-only, with "Compliance is
  held on the family record" — inventing a per-variation certificate list would create rows nothing
  reads.
- **Alias bands.** Compliance is a property of the *product*, not of a listing alias, so the pane
  is identical for every alias in a band and the band carries no compliance verb. An alias's
  publish preflight, however, must show the blockers (§6.5).
- **Market channels vs single-store.** The GPSR chip and the `compliance_media` columns exist only
  on the 8 GPSR markets (`listing-preflight.service.ts:308`); on IE/UK and every non-EU coordinate
  they are **absent with a reason in the tooltip**, never a green zero. Shopify is `GLOBAL` and gets
  the metafield summary (`outbound-sync.service.ts:1914`), so its scope shows the master 9 and a
  note that the compliance metafields are derived at sync, not editable per-market.
- **Per product type.** PPE/garment/protector fields are meaningless on a chain lube and hazmat is
  meaningless on a jacket. They must be `requiredIfRelevant` at most, and **never** pushed into
  Essentials by rule 3 on a type that does not use them — otherwise every accessory row grows seven
  empty required cells, which is #173's rule firing backwards.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance**: once the 9 scalars are real registry fields with `masterKey` links, they inherit
  the existing 🔗 / ✎ / ⚠ / ✦ vocabulary with no new marks. The **protector array and the
  certificate rows have no provenance** — they are single-store product data with no channel
  override — and the pane must not draw a provenance chip that would imply otherwise.
- **Autosave**: scalars and the protector array go through the one `SheetWriter` with
  `expectedVersion`; certificates keep their immediate-persist endpoint. Two contracts, both named
  on screen.
- **Readiness**: 🔴 the honest gap. `readiness.service.ts` today runs **only**
  `checkGpsrCompliance`, over flat-file column ids, warnings only. The CE / DoC / REACH / hazmat /
  HS-code rules in `evaluateCompliance` — including the **only two `block`s in the codebase** — do
  not reach it. The fix is one server change: `readiness.service.ts` calls `evaluateCompliance`
  alongside `checkGpsrCompliance` and maps `block → error`, `warn → warn`. Then the sheet's chip,
  the row pill, the drawer and the publish preview all inherit it, per the programme's one-definition
  rule. Its inputs are the `Product` columns + certificate rows, which are per product and not per
  row, so they must be resolved **once per family** and shared — not per row (that is what made the
  old per-product surfaces unusable at sheet scale, `readiness.service.ts:71-75`).
- **Publish**: with the above, `previewPublish` (`sheet-publish.service.ts:81-93`) starts refusing a
  row whose CE certificate is missing or expired, with the field named — which is the behaviour the
  eBay route already intends but cannot reach in `dry-run`. Publish stays explicit, per channel,
  preflight-first, mode from the server. The `overrideCompliance` escape hatch
  (`ebay-cockpit.routes.ts:1161`) should surface as a *typed* confirmation in the preflight, not a
  silent parameter.

### 6.6 ASCII mockup — the drawer's Compliance pane

```
┌ GALE Pro Racing Suit · GALE-KAN-PRO ─────────────────── ✕ ┐
│ Record · History · Compare · Listings · [Compliance]      │
├───────────────────────────────────────────────────────────┤
│ ⚠ Amazon IT · DE · FR · ES would refuse this row          │
│   CE certificate expired 12 Mar 2026 · PPE Cat III        │
├─ IMPACT PROTECTORS (EN 1621) ───────────── [+ Add] ───────┤
│ zone      standard          level                         │
│ shoulder  EN 1621-1 (limb)  1                          ⌫  │
│ back      EN 1621-2 (back)  2                          ⌫  │
│ elbow     — set standard —  —                          ⌫  │
├─ CERTIFICATES ──────────────────────────── [+ Add] ───────┤
│ type      number     body        expiry      status       │
│ CE        TÜV-12345  TÜV Rhein.  12/03/26   ● Expired  ↗ ⌫│
│ EN 13595  RIC-889    Ricotest    04/11/26   ◐ 61d left ↗ ⌫│
│ REACH     —          —           —          ○ No expiry ⌫ │
├─ WHAT EACH CHANNEL NEEDS ─────────────────────────────────┤
│ Amazon · IT   CE                      ✗ expired          │
│ eBay · IT     CE                      ✗ expired          │
│ Body prot.    CE + EN 13595           ✗ CE expired       │
│ REACH (SVHC)  REACH                   ✓ filed            │
├───────────────────────────────────────────────────────────┤
│ PPE category, garment class, Notified Body, hazmat class  │
│ and country of origin are cells on the sheet →            │
└───────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused unchanged**

- `PATCH /api/products/bulk` — the 9 scalars **and** `impactProtectors` are already in
  `ALLOWED_MASTER_FIELDS` (`master-field-gate.ts:60-71`) with validators
  (`products.routes.ts:1800-1848`). The protector sub-table needs **no new endpoint**. (PES.5 to
  confirm; PES.2/PES.4 consume.)
- `GET / POST / PATCH / DELETE /api/products/:id/certificates` — usable as-is
  (`product-certificates.routes.ts`). PES.4 consumes.
- `compliance-resolver.service.ts`'s pure functions — already unit-tested; no change to their logic.

**Server changes (PES.5)**

1. **Nine `FieldDefinition` entries** in `field-registry.service.ts` (category `compliance` →
   a new `Compliance` group in `SHEET_GROUP_ORDER`, `sheet-columns.service.ts:253`). Additive.
2. **`masterKey` links** in `channel-specs/amazon.ts:45-50` for `country_of_origin`,
   `supplier_declared_dg_hz_regulation`, `gpsr_safety_attestation`,
   `dsa_responsible_party_address`, `safety_data_sheet_url` — so those cells write the master column
   rather than the attribute bag. 🔴 This changes where an existing cell writes; it needs a
   migration story for values already sitting in `categoryAttributes` / `overrideData`, and a
   producer-and-consumer-in-one-write landing (`feedback_producer_and_consumer_land_together`).
3. **`evaluateCompliance` into `readiness.service.ts`** — `block → error`, `warn → warn`, resolved
   once per family. This is what makes the block reachable and what feeds the chip.
4. **A per-product, per-coordinate compliance status endpoint** to replace the wizard-only one —
   `GET /api/products/:id/compliance-status?market=IT` returning the same `perChannel` shape
   `listing-wizard.routes.ts:4846-4894` already defines, but computed by `evaluateCompliance` so the
   fourth copy of the rules is deleted rather than duplicated a fifth time.
5. **Additive schema**: a unique index on `(productId, certType)` — or, if multiple certs of one
   type are legitimate (a renewal filed before the old one lapses, which is normal), an explicit
   `orderBy: { expiresAt: 'desc' }` in `resolveComplianceById` plus a "current cert" rule stated in
   one place. **This is a data question, not a UI one — §9 Q3.**
6. **Audit rows** on certificate create/patch/delete (defect 13).
7. Optional, later: an upload endpoint so `fileUrl` can be a stored file rather than a typed URL;
   until then validate `https://` + pdf/jpg/png on write, matching what the GPSR check already
   demands (`listing-preflight.service.ts:435-439`).

**Client (lanes)**

- **PES.2** (grid substrate): the `Compliance` view preset rule + the H2 `Certificates` status
  column renderer; the chip is registered by whichever scope produces it, via the existing registry.
- **PES.3** (channel sheet): the GPSR chip producer per coordinate, **absent** off the 8 GPSR
  markets; consumes the new columns with no channel-specific code.
- **PES.4** (drawer): the `Compliance` pane, the two `DataGrid` sub-tables, the channel strip, and
  the `delete-certificate` verb declaration (registry + row menu + ⋯ + selection bar + pane).
- **PES.1** (frame): nothing — the chip registry and pane host already exist.
- **PES.6** (mapping) / **PES.7** (images) / **PES.8** (AI): nothing. 🔴 No AI on this surface: a
  generated CE certificate number is the worst possible output, and ruling #13 keeps AI dark anyway.

**DS**: `DataGrid` covers both sub-tables (`size: 'xs'`, `emptyState`, `numeric`, `rowProps`,
`renderExpanded` all exist). Known gaps to work around, from `.claude/DS-GAPS.md:133`, `:136`:
`DataGrid` has **no `loading` state**, and `Column.numeric` right-aligns cells but not the header.
**No new DS component is needed.**

## 8. Risks and traps

- 🔴 **Local dev writes the production database** (`reference_local_dev_hits_prod_api`). Every
  certificate created while testing this pane is a real row on a real product, and every protector
  array written replaces a real one. Probes stay inside the fixture family, and a delete rehearsal
  needs a `certId` the session itself created.
- 🔴 **Re-pointing a cell's store (change 2) is a write-path change on live listings.** Values
  already in `overrideData` / `categoryAttributes` become unread the moment the `masterKey` lands —
  the exact shape of the `amazon_title → overrideData.amazon_title` silent no-op
  (`channel-field-map.ts:6-11`). Producer and consumer must land together, and the migration must be
  measured, not assumed.
- 🔴 **Making the CE rule an `error` starts blocking publishes that go out today.** Blast radius is
  unmeasured: it depends on how many products carry `ppeCategory` Cat II/III with a missing or
  lapsed CE row. That number must be read before the rule flips — and the flip is the Owner's call,
  not a lane's (§9 Q1).
- **The GPSR chip must be absent, not zero, off the 8 GPSR markets** and on eBay — `count: 0` there
  states "we checked, nothing missing" on the strength of not having checked
  (`_studio/viewChips.ts:37-52`, `feedback_100_percent_honest_ui`).
- **Untouchable**: the flat-file editors own the submit-time compliance fill
  (`amazon-flat-file.routes.ts:583-602`). Nothing here edits inside them; the non-clobbering rule
  there is *why* change 2 needs care, not something to change.
- **Publish gates**: Amazon mode from `getAmazonPublishMode()`, eBay from `getEbayPublishMode()`,
  never env (`project_master_sheet_gds4`). eBay is preview-only, so a compliance block there is
  currently untestable end-to-end — say so rather than claiming it works.
- **Not this feature**: eBay Motors fitment (`PATCH /api/ebay/cockpit/compatibility`), the images
  tab's Product-Safety GPSR image slots (`images-workspace.routes.ts:343`), and the eBay cockpit's
  `CompatibilityCard`. Flagged for their owners.
- **`grep` cannot see a DB column** (`reference_grep_cannot_see_a_db_column`): every claim above
  about *which* store a value sits in is read from code, not from data. The two-store claims (6, 7)
  deserve one prod read each before anyone acts on them.

## 9. Open questions for the Owner (3)

1. **Should an expired or missing CE certificate BLOCK a publish from the studio, or only warn?**
   The code already says `block` (`compliance-resolver.service.ts:170-172`) and no studio path
   applies it. *Recommendation: yes, block — with the blast radius measured first and an explicit,
   audited override in the preflight confirm (the `overrideCompliance` path already exists at
   `ebay-cockpit.routes.ts:1161`). A rule written as a block and enforced as nothing is the worst of
   the three options.*
2. **Does the Amazon FIT/COMPATIBILITY card come back (3.28), or is it 🗳 dropped?** Every row of
   it is a schema attribute that is already a column, and both its pieces of logic are the
   localised-label trap #711 removed. *Recommendation: drop the card; cover the need with a `Fit &
   sizing` view preset. The real fitment table is eBay Motors and belongs to that lane.*
3. **Can a product hold two certificates of the same type?** A renewal filed before the old one
   lapses is normal practice, but today the gate reads an arbitrary one
   (`compliance-resolver.service.ts:117` + no `orderBy` at `:446`).
   *Recommendation: allow several, and define "current" as the one with the latest `expiresAt`
   (nulls last) in ONE place — the pane, the status column and the gate then cannot disagree.*

## 10. Effort and dependencies

| piece | lane | effort | depends on |
|---|---|---|---|
| 9 registry `FieldDefinition`s + `Compliance` group | PES.5 | **S** | — (writes + validators already exist) |
| `masterKey` links + store migration | PES.5 | **M** | Q1-adjacent; needs a prod read of the two stores first |
| `evaluateCompliance` into readiness (family-scoped resolve) | PES.5 | **M** | the registry fields; **Owner Q1** for `block` vs `warn` |
| `GET /api/products/:id/compliance-status` (kills copy #2 and #4) | PES.5 | **S–M** | `evaluateCompliance` |
| `Compliance` view preset + `Certificates` status column | PES.2 | **S** | the registry fields |
| `GPSR missing (n)` chip producer | PES.3 | **S** | readiness carrying the issues |
| Drawer `Compliance` pane + 2 `DataGrid` sub-tables + channel strip | PES.4 | **M–L** | the status endpoint; cert CRUD (exists) |
| `delete-certificate` registry verb with a real preflight | PES.4 | **S** | `complianceBlockers` reachable from the API |
| Audit rows + `https` validation on cert files | PES.5 | **S** | — |
| `(productId, certType)` decision + index or `orderBy` | PES.5 | **S** | **Owner Q3** |
| Errors & Sync expiry group (H9) + cron reporting to it | PES.5 + PES.1 | **M** | the status endpoint; `getCertExpiryAlertStatus` gaining a consumer |

Cross-feature: shares the readiness pipeline with every other feature that flags a row, so the
`evaluateCompliance` merge should land **once**, before the chip and the pane. Shares the H2 status
column vocabulary with buy-box / A+ / sync-state features. Independent of images, mapping and AI.
