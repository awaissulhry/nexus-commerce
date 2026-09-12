# Local Shopify connection setup — 2026-09-09

Current status: app registration and local setup completed. The real Nexus flow reaches Shopify's **Install Nexus Commerce** screen for **Xavia Racing**. Installation approval and the completed provider callback remain pending.

## Diagnosis

The reported error occurs before any request to Shopify. The local API on port 8091 resolves its database to `127.0.0.1:55439`. A read-only query confirmed no Shopify or Etsy `ChannelApp` rows. Neither the root nor API environment file supplies the corresponding app credentials. Neither supplies `NEXUS_PUBLIC_API_URL` / `PUBLIC_API_URL` or `NEXUS_WEB_URL`.

Initially, the signed-in Shopify Dev Dashboard for the **Xavia Racing** organization showed an empty Apps page. The first turn prepared a **Nexus Commerce** app creation form. The follow-up created and configured that app after the user's response to the approval request. Store access has not yet been granted.

The previous audit (`2026-09-08-shopify-etsy-connections.md`) explicitly left deployed configuration and actual provider consent unverified. Passing its mocked-provider tests did not establish that this local installation was configured.

## Corrections

- Missing app configuration is now a typed setup failure. Starting sign-in returns a friendly 503 response, without creating an OAuth session or setting a callback cookie. Unexpected internal failures are logged server-side and no longer echoed to the dialog.
- A read-only, uncached `GET /api/cx/connect/:channel/readiness` checks the same app credential and callback validation used by the actual start operation. It returns only readiness and safe explanatory text. The existing `channelsConnect` permission rule covers the endpoint.
- Shopify and Etsy dialogs check configuration before enabling Continue. Missing setup is shown through the existing Nexus Banner with a Check again action. Requests time out, abort when the dialog closes, ignore obsolete responses, and use the chosen business profile. Start still validates independently.
- Existing database app configuration remains authoritative. A partial or unreadable stored app never silently switches to a different environment app. Heartbeat classification recognizes the new setup error.
- The API environment example now documents the actual channel encryption key, the web return origin, and where to configure app credentials.
- The follow-up added an explicit Shopify-only loopback callback option. It requires both `NODE_ENV=development` and `NEXUS_SHOPIFY_LOCAL_OAUTH=1`; only HTTP localhost, 127.0.0.1, or IPv6 loopback with the exact `/api/cx/callback/shopify` path is accepted. Query strings, fragments, URL credentials, other hosts/routes, production, and Etsy are refused. Only this flow's callback cookie uses `HttpOnly; SameSite=Lax` without Secure. HTTPS flows and other channel cookies retain their existing policy. This matches Shopify's current standalone-app development example.
- Shopify's actual Dev Dashboard rejected `read_marketplace_fulfillment_orders` and `read_merchant_approval_signals` for this app. They now join the explicitly approved scopes instead of blocking the default installation. The app version and default connector request use 93 accepted scopes; seven channel-specific/restricted scopes remain behind explicit approval.

No shared design-system files or feature CSS were changed.

## Configuration completed

- Organization: **Xavia Racing**, Shopify organization `79081726`.
- App: **Nexus Commerce**, app `421328781313`.
- Active version: **local-connect-2026-09-09**, version `1122449457153`.
- App URL: `http://localhost:3000/settings/channels`; standalone (not embedded).
- Registered callback: `http://localhost:8091/api/cx/callback/shopify`.
- Legacy installation enabled to match the connector's authorization-code flow and scope URL parameter. Webhooks API version remains `2026-07`.
- Local `apps/api/.env` contains the app client ID and secret, `NEXUS_PUBLIC_API_URL=http://localhost:8091`, `NEXUS_WEB_URL=http://localhost:3000`, `NODE_ENV=development`, and `NEXUS_SHOPIFY_LOCAL_OAUTH=1`. The existing encryption key was preserved. The environment file is ignored by Git and restricted to owner read/write. The app secret was transferred directly from the browser to that local file without printing it in tool output.
- The running API restarted, and a read-only database check confirmed a production-environment Shopify app row with a client ID and encrypted secret. Here, `production` names the provider credential environment; this remains the isolated local Nexus database.
- Clicking Check again removed the setup warning; Continue became enabled for `xaviaracing.myshopify.com`. The actual popup reached Shopify's Install screen with no credential, callback, or scope error.

No public tunnel or production deployment was created. A production setup still requires HTTPS and a separately verified callback to its own API/database.

## Remaining verification

Approve installation at Shopify's actual consent screen, then verify the callback returns to Nexus and saves the verified identity and actual granted scopes. This grants access to customer data and read/write store data, so confirmation was requested at the Install action. Validate cancellation, retry, reconnection, and required downstream operations before production sign-off. If the consent state expires while awaiting approval, start a fresh flow from Nexus.

Etsy separately needs `ETSY_API_KEY`, `ETSY_SHARED_SECRET`, its provider-approved app, and the exact `/api/cx/callback/etsy` HTTPS callback.

Official references: [Shopify app credentials](https://shopify.dev/docs/apps/build/authentication-authorization/manage-credentials), [standalone app authorization and localhost cookie example](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps), [app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration), [Shopify staff explanation of restricted marketplace scopes](https://community.shopify.dev/t/error-when-read-marketplace-orders-or-read-marketplace-fulfillment-orders-scope-is-added/31861/2).

## Verification

- API: 339 tests passed across 16 targeted suites, including 26 new HTTP tests using the real app resolver and encryption with in-memory persistence. Cases cover missing configuration, retry after configuration, valid consent URLs, stored credentials taking precedence, incomplete/unreadable credentials, invalid callback URLs, safe unexpected-error responses, loopback callback/cookie behavior, and rejection of production/remote-host/other-channel misuse.
- Web: 86 tests passed across six channel suites, including 12 new readiness cases covering retry, profile/channel changes, malformed responses, cancellation, and timeout.
- API and web TypeScript checks passed.
- Web/Factory token generation checks, design-system conformance, shared-fork drift, and raw-control ratchets passed.
- Browser: verified the running local Shopify and Etsy setup messages, disabled Continue even with a valid store domain, Check again, desktop light/dark presentation, Tab/Shift+Tab focus wrapping, Escape, and focus restoration. Found and corrected Etsy's single-profile shortcut that had skipped the dialog. Chrome's viewport override did not change the measured 1728px viewport, so mobile visual verification remains outstanding; the override was reset.
- The API suite emitted the existing `node-cron` missing-source-map warning; it had no unhandled errors or test failures.

Real provider consent remains pending. These results do not establish a working Shopify account connection or an error-free/AAA certification for the whole platform.
