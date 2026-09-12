# Etsy local connection — 2026-09-10

Status: **ItalianHideCraft is connected to local Nexus and verified against Etsy's live API.** All 12 permissions are recorded, token renewal succeeds, and the connection remains healthy after renewal and a page reload. Chrome's automatic HTTPS-to-localhost return required manual navigation during sign-in; see the development callback limitation below.

## Initial local diagnosis

- Browser: `http://localhost:3000/settings/channels`.
- Web API target: `http://localhost:8091`; database host: `127.0.0.1:55439`.
- Neither the root nor API environment file initially contained `ETSY_API_KEY` or `ETSY_SHARED_SECRET`.
- The running API's read-only `GET /api/cx/connect/etsy/readiness` initially returned `ready: false`, `code: channel_unavailable`, and the reported missing-app-credentials message. The app resolver reports this when neither stored app configuration nor environment credentials are available.
- Clicking **Check again** initially repeated the check and showed the same warning; **Continue to Etsy** stayed disabled. Retrying could not supply missing app credentials.
- Local credential encryption is configured in the root environment. Existing encryption and other channel configuration were preserved.
- `NEXUS_PUBLIC_API_URL` is `http://localhost:8091` and `NEXUS_WEB_URL` is `http://localhost:3000`. Etsy requires an exactly registered HTTPS callback, so credentials alone will not finish setup.

## Etsy observations and action

The user confirmed that the signed-in **Hannah Stone** account was the intended account. Its developer dashboard initially showed no registered app.

Submitted a seller-app registration named **Nexus Commerce**, with this description:

> I am developing Nexus Commerce to connect my own Etsy shop to my local commerce management application. I will use the API to read my shop, listings and orders, then manage listing information, inventory, prices and order fulfilment for my own shop.

Etsy initially returned **App rejected** and **Your app nexus-commerce has been rejected.** No reason or credentials appeared. Registration was retried only after the user reported correcting missing account information and asked to continue.

Read-only checks then found:

- Shop Manager identifies the shop as **ItalianHideCraft** and displays **Your account has been suspended**. The notice persisted after the dashboard finished loading.
- Developer Settings displays **Your shop is in Developer Mode** and explains that this hides listings from search. It directs the owner to `developer@etsy.com` for help. We did not establish when Developer Mode began or whether it relates to the suspension or registration rejection.
- Etsy's published seller-app eligibility requires an active shop in good standing without an existing registered app. The suspension is therefore an eligibility blocker and a likely explanation for rejection; Etsy did not explicitly confirm the rejection reason.

## Completed after the account correction

- Rechecked the same confirmed account: the suspension banner had cleared. Developer Settings now explicitly reports **Your shop is NOT in Developer Mode**. No shop-mode button was used by the agent.
- Resubmitted the same truthful seller-app registration. Etsy approved **Nexus Commerce** (`nexus-commerce`), app ID `1513907185612`, with 10 QPS / 10K QPD displayed.
- Saved its keystring and shared secret in the ignored `apps/api/.env`, restricted to owner read/write. Configured the `ETSY` / `production` `ChannelApp` row in the isolated local database, using the existing encryption key. Here `production` means Etsy's credential environment, not a Nexus production deployment.
- Registered and reloaded to verify `https://morbidity-curtly-probe.ngrok-free.dev/api/cx/callback/etsy` on Etsy. Stored it only in Etsy's `redirectUris`, preserving the other channels and the existing local API/web URLs.
- `GET /api/cx/connect/etsy/readiness` now returns `{"ready":true}`. Clicking **Check again** cleared the warning and enabled **Continue to Etsy**.
- The real popup reached Etsy's consent screen for Nexus Commerce and the confirmed account. Consent was granted, and the normal local callback completed the nonce, single-use session, token exchange, and shop identity checks. The popup closed and the account appeared in Nexus.
- Saved connection: `cmtvy3wta00fjnjpxl22lly3k`; shop: **ItalianHideCraft** / `57783036`; Etsy user ID: `1051233836`. The stored connection is active, OAuth-managed, and connected, with zero consecutive failures and no last error.
- All 12 required permissions were recorded, with no scope drift: `address_r`, `address_w`, `email_r`, `listings_d`, `listings_r`, `listings_w`, `profile_r`, `profile_w`, `shops_r`, `shops_w`, `transactions_r`, `transactions_w`.
- The actual account-card **Test** returned **OK · 532 ms**. Forced token renewal then succeeded, and another live heartbeat using the renewed token returned `success: true`, `authStatus: connected`, `scopeDrift: []` (1013 ms). Reloading Nexus preserved the connected account and updated renewal/heartbeat timestamps.

No listing changes, listing sync, publishing, appeal, support message, or production deployment was performed. The local API did not need restarting because its authoritative app configuration was written directly to the local database.

## Development callback helper and limitation

`scripts/etsy-local-callback.mjs` listens only on `127.0.0.1:8093`. It accepts only GET requests on `/api/cx/callback/etsy` with a valid-shaped state and either an authorization code or provider error. It rejects other paths, methods, unknown/duplicate parameters, and non-loopback destination configuration. It returns the browser to the fixed local API callback without reading, forwarding, or creating a Nexus session. It does not log callback query strings. Responses disable caching and referrers.

The ngrok tunnel exposes only that separate helper, with request inspection disabled. A public request to `/api/products` returned 404. No whole-API tunnel was created. The helper and tunnel were left running for this local session.

To start them again from the repository root:

```sh
node scripts/etsy-local-callback.mjs
```

In a separate terminal:

```sh
ngrok http http://127.0.0.1:8093 --inspect=false --url https://morbidity-curtly-probe.ngrok-free.dev
```

The callback tunnel is needed for browser sign-in/reconnection, not ongoing Etsy API access or token renewal. If the tunnel domain changes, update both Etsy's registration and its local `ChannelApp.redirectUris`.

During this sign-in, ngrok displayed its first-visit interstitial. After continuing, Chrome blocked the automatic redirect to HTTP localhost with `ERR_BLOCKED_BY_CLIENT`. Opening the verified local callback directly in the same popup completed the existing attempt successfully. Its state and code stayed within browser navigation; the normal API session and nonce checks were preserved. No browser protection was disabled, and no OAuth checks were bypassed. **Fully automatic return/reconnection is not verified in this browser.** Do not describe this local development flow as having a seamless callback until that browser behavior is resolved. The established account connection and refresh operation are verified.

## Verification

- `node --test scripts/etsy-local-callback.test.mjs`: 4 tests passed, covering exact local return, provider cancellation, route/method isolation, ambiguous callbacks, destination restrictions, and response security headers.
- Actual Etsy approval and saved callback registration; local readiness/dialog; actual consent, callback, and persisted shop identity; live account test, forced token renewal, and post-renewal heartbeat; connection persisted after reload.
- No platform UI or shared design-system code changed in this setup task. No Web/Factory type or token checks were required for the standalone JavaScript helper.

## References

- [Etsy authentication and exact HTTPS callback requirements](https://developers.etsy.com/documentation/essentials/authentication/)
- [Etsy seller-app eligibility](https://help.etsy.com/hc/en-gb/articles/41918478450967-How-to-Register-a-Seller-App-with-Etsy-s-API?segment=selling)
- [Etsy's seller API access announcement and support contact](https://github.com/etsy/open-api/discussions/1647)
- Signed-in [developer settings](https://www.etsy.com/developers/shop) and [Shop Manager](https://www.etsy.com/your/shops/me/dashboard).
