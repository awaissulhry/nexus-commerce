# Amazon managed connection and account-name review

## Shipped behavior

- Seller credentials are held in the encrypted connection store. Runtime seller, region, and authorization are resolved together; environment access is only a migration path for an explicitly environment-managed row.
- Disconnect is respected by existing SDK objects, new calls, pagination and API startup. Restart does not recreate environment access after an OAuth connection has existed.
- Order-specific cancellation, shipment confirmation and Buy Shipping resolve the order's connection. Legacy single-account consumers fail closed when multiple Amazon sellers make routing ambiguous.
- Reauthorization cannot substitute a different seller or region. Imported grants and marketplace scopes commit together; existing metadata and history are retained.
- Private-app verification checks the stored grant, without importing environment credentials or pretending consent was renewed. Successful refresh clears synthetic expiry only for grants explicitly marked as private imports.
- Account names are shared across account lists, the switcher, details, diagnostics, consent messages, advertising profiles, campaign details and publishing status. Opaque keys remain internal. Missing names are explicit; Rename supplies a human label.
- Account cards stack at narrow container widths. The shared account styles and behavior are mirrored into Factory.
- OAuth callback payloads escape script-breaking characters, including names containing closing script tags.

## Verification

- GPT-6-Astra independently reviewed the connection implementation and the integrated naming changes. Confirmed findings were fixed and tested.
- 298 focused API tests passed across connection lifecycle, provider adapters, import, identity placement, tokens, callback security, shipping ownership and account names.
- 129 Web tests passed; 68 mirrored Factory account-model tests passed with the Web test configuration.
- API production build and API/Web TypeScript checks passed.
- Web token freshness and token guard passed.
- Browser checks: 390px light/dark account cards, legacy-ID fallback, name-only scope chips, switcher Escape, rename Escape cancellation and Enter save. Production account rename to XAVIA RACING confirmed.
- Clean API and Vercel production builds succeeded for the managed-lifecycle release. Live heartbeats passed for Amazon Seller (253ms), Amazon Ads (127ms), xaviaracing (562ms), and motovento (474ms). Private verification succeeded; expiry changed from the synthetic anniversary to not recorded. Startup logs confirmed environment synthesis was skipped.
- A final live detail-page check exposed a legacy raw identity dump; the follow-up replaces it with the same account name, hides account keys in ledger summaries, and adds regression coverage. Private sign-in wording and an unmeasured Last sync status were corrected at the same time.
- Deployed diagnostics testing also caught historical error prose containing a connection key. Display summaries now resolve embedded keys to current account names (with an explicit missing-name fallback), preserve operational measurements, and leave the original audit data unchanged.

## Explicit limits and unrelated checks

- The registered Amazon application is private. Amazon's supported authorization is through the Solution Provider Portal, not public website OAuth. Importing the existing company authorization does not grant additional application roles. A disconnected private account needs replacement authorization; no secret-entry workflow is added here.
- Requests already sent to Amazon and SDK retries already in flight cannot be recalled by disconnect.
- Factory's full TypeScript check is blocked by missing generated Prisma client types and downstream existing errors. Its token guard still reports the same 158 unrelated baseline violations.
- Local Turbopack cannot follow the isolated checkout's dependency symlinks outside its filesystem root; the production provider installs dependencies independently. The Webpack fallback reaches an existing non-pure global selector in `fulfillment/stock/sync-control/styles.module.css`; no unrelated stylesheet was changed. The provider's normal Turbopack build remains the Web release gate.
- After that local fallback build generated `.next` route types, local Web TypeScript reports the existing synchronous `customers/[id]` page-params mismatch. No source errors remain in the changed channel files; clean provider builds remain the full Web type gate.
