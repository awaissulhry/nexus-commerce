# Shopify and Etsy connection re-audit — 2026-09-08

Status: connection-flow hardening implemented and locally verified. This is not a blanket production or accessibility certification. Real provider consent and deployment configuration remain to be verified.

## Scope and fixes

Reviewed both connectors, shared OAuth initiation/completion, callback HTML and API security headers, business-profile callback relay, encrypted token persistence/renewal, account identity checks, permission reporting, and the connection UI. Existing unrelated work was preserved.

| Finding | Correction |
| --- | --- |
| The global API CSP blocked callback scripts and styles. | Per-response nonces enable only the callback's own script/style blocks. Ordinary API HTML remains locked down. Tests exercise the production policy resolver and the web proxy's header preservation. |
| The business-profile relay added a field to Shopify's signed query. | Strip only the Nexus relay marker before HMAC verification; retain all provider fields. Tested a relayed signed callback. |
| Shopify could store a grant without verifying its shop. | Require verified identity, immutable shop ID, matching permanent domain, and a complete GraphQL response. Reject partial/error responses; classify HTTP-200 throttling. |
| Token responses were loosely parsed and requests could hang or redirect credentials. | Bound exchange/refresh requests and body reads to 20 seconds, reject redirects, validate token shapes/lifetimes, and preserve an explicitly empty scope grant. Token error bodies are not persisted. |
| An in-flight refresh could replace a newer consent or restore disconnected credentials. | Guard refresh writes against the credential/status/lease snapshot; persist refresh failure status atomically; recheck account state after lease acquisition and while waiting for peers. Clear expiry metadata on disconnect. |
| Callback matching depended on the business-profile feature flag. | Correlate every shared flow with its state, including when profiles are disabled. Only explicitly legacy flows may lack state. |
| Closing sign-in during initiation navigated the original tab. | Treat an intentionally closed window as cancellation. Keep the same-tab fallback for a browser-blocked window; clean up abandoned attempts. Open ordinary new tabs. |
| Shopify/Etsy permission reporting overstated verification. | Record actual echoed grants; Etsy's identity heartbeat no longer presents cached scopes as newly introspected. An empty reported scope list updates drift correctly. Discovery receives fresh verified identity. |
| Mobile connection cards had a fixed minimum wider than their container. | Use a container-bounded grid minimum. Preserve canonical Nexus controls. Shopify's dialog now supports native form submission, validation and keyboard navigation. |

## Permissions

Shopify requests 95 configured commerce scopes, plus up to five known restricted scopes when explicitly approved in `ChannelApp.extra.approvedScopes` or `SHOPIFY_APPROVED_SCOPES`. An explicitly stored array takes precedence over environment fallback. Restricted scopes are not requested blindly: Shopify can reject the whole installation before consent. This is a custom-distribution commerce connector, not a Payments App or a claim to every Shopify API entitlement. Protected customer data, store-plan restrictions and app distribution remain provider-controlled. The actual returned grant is authoritative. See [Shopify access scopes](https://shopify.dev/docs/api/usage/access-scopes).

Etsy requests all 12 scopes in its current official OpenAPI specification. Authorization uses PKCE; API identity requests use the required `keystring:shared-secret` header; the shared secret is not included in token-exchange bodies. See [Etsy authentication](https://developers.etsy.com/documentation/essentials/authentication/) and [official OpenAPI specification](https://www.etsy.com/openapi/generated/oas/3.0.0.json).

Shopify's configured custom-distribution offline tokens can be non-expiring; expiry is not invented. Expiring grants must carry a refresh token. Do not assume the same token policy for public distribution. See [Shopify access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens).

## Verification

- API: 324 tests passed across 16 suites covering CX services/connectors, callback routes, heartbeat and credential rotation. Real Shopify/Etsy connector contracts were exercised with mocked provider HTTP, in-memory persistence and actual encryption. This includes successful grants, replay rejection and failing identity checks.
- Web: 80 tests passed across seven channel/workspace suites; callback-proxy regressions preserve nonce CSP and callback-cookie clearing.
- API and web TypeScript checks passed.
- Web and Factory generated-token checks passed. Design-system conformance and shared-fork guards passed; no shared design-system files were changed.
- Browser: inspected both connection cards at 1440px and 390px in light/dark presentation. Shopify's mobile dialog fit within the viewport with no overflowing descendants. Checked invalid-domain feedback, admin-URL normalization, enabled/disabled Continue behavior, focus wrapping, Escape and focus restoration. No real provider grant was submitted.
- Scoped whitespace/diff check passed. Test runner emitted an existing `node-cron` missing-sourcemap warning, not a test failure.

## Required before production sign-off

Verify deployed app credentials, exact HTTPS provider-registered callback URLs, the web callback origin, encryption configuration, Shopify app/store entitlements and Etsy app approval. Complete real consent for both accounts, then verify return-to-tab, saved identity/granted scopes, renewal, cancellation/retry and disconnect on the deployed origins. Exercise the deployed browser cookie policy as well as the business-profile relay; local mocked tests cannot establish cross-origin browser/provider acceptance.

This review does not certify downstream product/order synchronization, webhook installation/delivery, the whole repository, or WCAG AAA. No deployment, app approval, real account connection or account disconnection was performed.
