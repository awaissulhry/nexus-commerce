# Account access — 2026-09-07

The local product/mapping environment can now access the existing Amazon seller and both active eBay accounts. No additional credentials or sign-in were needed. The live receipt is [account-access-live.json](account-access-live.json).

## Cause and repair

Local and deployed API configuration used the same database but different credential encryption keys. Local decryption failed for both eBay grants and the stored eBay/Amazon app secrets, while the deployed API continued recording successful heartbeats. The deployed key decrypted all four records successfully.

After privately comparing the existing Railway configuration and verifying live identities, the ignored local `.env` was aligned for `NEXUS_CREDENTIAL_ENC_KEY`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME`, and `AMAZON_REFRESH_TOKEN`. No secret values were printed or included in this audit. No deployment settings were changed. The isolated API on port 8094 was restarted with background jobs disabled.

## Measured live access

| Account/application | Checks | Result |
| --- | --- | --- |
| eBay xaviaracing | Identity matches the saved immutable ID; account privileges; inventory read | All HTTP 200; inventory endpoint reports 226 items |
| eBay motovento | Identity matches the saved immutable ID; account privileges; inventory read | All HTTP 200; inventory endpoint reports 0 items |
| eBay application | App token; Italy taxonomy; category 177101 aspects | All HTTP 200; 14 aspects |
| Amazon seller A1VRHKTGYO1JNU | LWA refresh; marketplace participation; AIRMESH-JACKET-BLACK-MEN-XL listing in Italy | All HTTP 200; live product type COAT |
| Amazon seller-specific definition | COAT / Italy / LISTING / ENFORCED; schema document download | Both HTTP 200; 157 schema properties |

The eBay Inventory API item count is not the local listing count: they represent different records. The initial inventory probe needed an explicit `Accept-Language` header. The successful category probe uses a category from actual account listings. No listings were created, changed, deleted, or published.

The page's Test buttons also passed: Amazon 5880 ms, xaviaracing 1541 ms, motovento 673 ms. Tests update heartbeat diagnostics and may refresh tokens; these are not listing submissions.

## Diagnostic and layout corrections

- Empty OAuth permission records remain unknown, rather than claiming every required permission was denied. Accounts, detail, and diagnostic text preserve this distinction.
- Refresh and heartbeat share failure-state rules. Outages, forbidden calls, signing defects, and app configuration failures do not become requests to reconnect merely after ten failures.
- Decryption failures identify server configuration as the cause. Refresh error classification survives the heartbeat adapter.
- A mismatched seller identity fails the test without adopting its permissions or marketplaces. The mismatched grant is blocked until reconnected; an unexpired cached token cannot bypass this block.
- Amazon heartbeat only tests the configured primary environment-managed seller. eBay heartbeat selects the stored production/sandbox environment, uses a timeout, and rejects an identity response without a user ID.
- Heartbeat reports permission drift using newly reported scopes when available.
- Account scope chips explicitly label inactive participation, including the stored Amazon US entry.
- Narrow panels wrap color choices and actions beneath account details. Before the fix, a 258px mobile row had 295px of content. Afterward all four rows fit their available width at 320px, 390px, and 1728px viewports. Light/dark presentation and keyboard action navigation were checked. Shared changes are mirrored in Factory and documented in the design-system catalog/changelog.

## Validation and limits

Passed: 245 API tests across 11 files; 98 Web tests across 2 files; API and Factory type checks; both generated-token checks; CSS parser across 14 stylesheets; design-system conformance ratchet. The changed shared account helpers/tests are identical in Web and Factory.

Broader workspace gates reported unrelated findings during this run:

- Web typecheck: missing `children` in `apps/web/src/app/products/[id]/edit/_studio/sheet/sheetGridStates.vitest.test.ts:13`.
- Token-resolution guard: `--nds-dg-font`, `--nds-dg-line`, `--nds-dg-pad-x`, `--nds-dg-pad-y` in Web datagrid CSS; `--nds-tooltip-arrow-x` in both apps; `--nds-tip-bg` and `--nds-tip-fg` in Factory primitive CSS. These are guard findings, not an account-panel regression diagnosis.
- Fork guard: differing export placement in the two `design-system/components/index.ts` files.
- The local runtime still logs DNS failures for its old Redis endpoint. Account access checks do not depend on that queue; asynchronous publishing needs separate validation.

This step proves current account access and representative schema reads. It does not certify every OAuth permission, every category, the complete product facts, publishing, queues, or WCAG AAA conformance. Existing eBay grants still lack recorded scope metadata. Full schema refresh and per-product channel payload validation remain the next mapping checks. No live consent/reconnect flow or listing write was exercised.

Reproduce the representative probes from repository root with `node --import tsx docs/audits/2026-09-07-attribute-mapping/account-access-check.mts`. It uses the normal API environment and writes a secret-free receipt to `/tmp/nexus-live-account-access.json`.

Reference: [eBay Identity API](https://developer.ebay.com/develop/api/buy/identity_api), [Amazon seller-specific product type definitions](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/retrieve-a-product-type-definition).
