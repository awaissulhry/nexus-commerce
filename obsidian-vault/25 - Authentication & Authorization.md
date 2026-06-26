# Authentication & Authorization

→ [[00 - Nexus Commerce MOC]] | [[04 - API Layer (Fastify)]]

## Overview

Two-layer auth system: API key authentication for direct API access + OAuth 2.0 per-channel connections for marketplace integrations.

---

## API Key Authentication

### Implementation

| File | Purpose |
|------|---------|
| `apps/api/src/middleware/api-key-auth.ts` | Key verification (bcrypt/SHA-256), scopes, IP allowlist, grace windows |
| `apps/api/src/middleware/api-key-hook.ts` | Fastify hook for per-route API key gating |

### Scopes

| Scope | Access |
|-------|--------|
| `products:read` | Read product data |
| `products:write` | Create/update products |
| `listings:read` | Read listing status |
| `listings:write` | Publish/update listings |
| `orders:read` | Read orders |
| `orders:write` | Update order status |
| `stock:read` | Read inventory |
| `stock:write` | Update inventory |
| `analytics:read` | Read analytics data |
| `admin` | Full admin access |

### Key Storage

- Hashed in `ApiKey` table (bcrypt for new keys, SHA-256 for legacy keys)
- Rotation grace period: old key accepted for N days after rotation
- IP allowlist: per-key IP restriction
- Expiry: optional key expiry date
- Revocation: instant via DB delete

### Verification Flow

```
Request arrives at Fastify
    │
    ▼
api-key-hook.ts checks X-API-Key header
    │
    ▼
api-key-auth.ts: verifyApiKey()
    ├── Lookup ApiKey by prefix
    ├── bcrypt.compare(provided, stored)
    ├── Check scope covers route
    ├── Check IP allowlist
    └── Check expiry
          │
          ├── PASS → request continues
          └── FAIL → 401 Unauthorized
```

---

## OAuth Channel Connections

### Per-Channel OAuth Flows

| Channel | Flow | Route |
|---------|------|-------|
| Amazon | LWA (Login with Amazon) | env-managed (no UI) |
| eBay | OAuth 2.0 | `ebay-auth.routes.ts` |
| Shopify | OAuth 2.0 | `shopify-setup.routes.ts` |

### ChannelConnection Model

```prisma
ChannelConnection {
  id
  channel       // AMAZON | EBAY | SHOPIFY
  managedBy     // 'env' | 'oauth'
  credentials   // encrypted tokens
  status        // ACTIVE | EXPIRED | REVOKED
  expiresAt
}
```

> **Critical:** `ChannelConnection` rows are **PRESERVE-by-default** in all data wipes — even stale-looking rows. These are live API credentials.

### Token Refresh

| Channel | Mechanism |
|---------|-----------|
| Amazon | LWA refresh token (long-lived, env-managed) |
| eBay | `ebay-token-refresh.job.ts` cron — refreshes before expiry |
| Shopify | OAuth access tokens (long-lived) |

---

## Web App Authentication

- Next.js middleware protects all app routes
- Session management (JWT or session cookies)
- `/settings/team` — team member management
- Protected routes check auth context server-side

---

## Rate Limiting

- `@fastify/rate-limit` — per-route rate limiting
- `rate-limiter.ts` — configuration
- Token-bucket for external API calls (bidding engine)
- Redis-backed counters

---

## API Key Management (Settings)

Route: `/settings/api-keys`

| Action | Description |
|--------|-------------|
| Create key | Generate new key with scopes |
| View keys | List active keys (prefix shown, hash hidden) |
| Rotate key | Generate new hash, grace window for old |
| Revoke key | Delete immediately |
| Set IP allowlist | Restrict to specific IPs |
| Set expiry | Optional expiry date |

---

## Audit Log

All authentication events logged to `AuditLog`:
- Key creation/rotation/revocation
- OAuth connection established/revoked
- Failed authentication attempts
- Admin actions

Route: `/settings/audit`

---

## Related Notes

- [[04 - API Layer (Fastify)]] — Fastify middleware stack
- [[11 - Amazon SP-API Integration]] — Amazon LWA auth
- [[12 - eBay Integration]] — eBay OAuth
- [[13 - Shopify Integration]] — Shopify OAuth
- [[05 - Database Schema]] — ApiKey, ChannelConnection models
