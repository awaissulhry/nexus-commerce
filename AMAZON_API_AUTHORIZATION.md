# Re-Authorize Amazon SP-API for Catalog Items Access

The current `AMAZON_REFRESH_TOKEN` was generated before the **Catalog Items** role was
added to your SP-API app. Refresh tokens encode the scopes that were granted at the
moment they were issued — adding a role to the app's profile does not retroactively
extend an old token. You need to re-authorize the app to mint a new refresh token
that includes the Catalog Items scope.

## Confirming this is the issue

Run:

```bash
curl "https://nexusapi-production-b7bb.up.railway.app/api/amazon/test-catalog-api?asin=B0DYXSQP18"
```

Current response:
```json
{"success":false,"error":"Access to requested resource is denied.","details":{"code":"Unauthorized",...}}
```

After the steps below, the same call should return `{"success": true, ...}` with relationship data.

## Steps

1. Go to https://sellercentral.amazon.it
2. Navigate: **Apps & Services** → **Develop Apps**
3. Find your SP-API application (the one whose `LWA_CLIENT_ID` is in Railway env)
4. Click the **Authorize** button (even if it shows as already authorized — this re-issues the token with the current scopes)
5. Confirm permissions on the consent screen — make sure **Catalog Items** appears in the listed permissions
6. Copy the **new** refresh token shown after authorization (starts with `Atzr|...`)
7. Open https://railway.app → your project → **@nexus/api** service → **Variables** tab
8. Update `AMAZON_REFRESH_TOKEN` with the new value (no quotes, no surrounding whitespace)
9. Railway will auto-redeploy in ~2 minutes
10. Reply to the agent: **"token updated"**

## Verify after update

```bash
curl "https://nexusapi-production-b7bb.up.railway.app/api/amazon/test-catalog-api?asin=B0DYXSQP18"
```

Expected:
```json
{
  "success": true,
  "asin": "B0DYXSQP18",
  "hasRelationships": true,
  "parentAsins": ["..."]   // or "childAsins": [...] if this is a parent
}
```

If still `Unauthorized`: the new token didn't take effect. Check that
- Railway picked up the variable change (look at the deploy log)
- The token has no leading/trailing whitespace
- The token wasn't truncated (refresh tokens are ~250+ chars)
