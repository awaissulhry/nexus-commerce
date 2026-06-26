# Shared Packages

→ [[00 - Nexus Commerce MOC]] | [[02 - Monorepo Structure]]

## Package Overview

Two shared packages in `packages/`:

| Package | Name | Consumers |
|---------|------|-----------|
| `packages/database` | `@nexus/database` | `apps/api`, `apps/web` |
| `packages/shared` | `@nexus/shared` | `apps/api`, `apps/web`, `services/bidding-engine` |

---

## `@nexus/database`

### Location

`packages/database/`

### Purpose

Exports the Prisma Client singleton. Single source of truth for the database schema.

### Contents

| Path | Purpose |
|------|---------|
| `prisma/schema.prisma` | Database schema (13,423 lines, 416 models) |
| `prisma/migrations/` | 310 migration folders |
| `src/index.ts` | Exports Prisma Client instance |
| `package.json` | `postinstall: prisma generate` |

### Usage

```typescript
import { prisma } from '@nexus/database'

const product = await prisma.product.findUnique({ where: { id } })
```

### Post-install Hook

`postinstall: prisma generate` — runs automatically when the package is installed. Generates the type-safe Prisma Client from `schema.prisma`.

### Key Notes

- Prisma adapter: `@prisma/adapter-pg` for pooled PG connections
- Connection string: `DATABASE_URL` env var
- Migration command: `prisma migrate deploy` (use `DATABASE_DIRECT_URL` without `-pooler`)
- Never run `prisma migrate dev` in production

---

## `@nexus/shared`

### Location

`packages/shared/`

### Purpose

Shared utilities used across apps and services.

### Contents

| File | Purpose |
|------|---------|
| `vault.ts` | Configuration management (env/secrets references) |
| `image-validation.ts` | Image format + dimensions validation |

### Vault (`vault.ts`)

Centralises configuration access:
- Wraps environment variable access
- Type-safe config retrieval
- Used in both API and web for shared config patterns

### Image Validation (`image-validation.ts`)

Used in bulk import and image upload flows:
- Validates image format (JPEG, PNG, WebP, GIF)
- Checks minimum dimensions (e.g. Amazon requires 1000×1000px minimum)
- Checks maximum file size
- Returns validation result with error messages

### Build Output

Compiled to `dist/`:
- CommonJS: `dist/index.js`
- ESM: `dist/index.mjs`
- Types: `dist/index.d.ts`

Dual-build supports both `require()` (API) and `import` (web/services).

---

## Inter-package Dependencies

```
apps/api
  ├── depends on @nexus/database (Prisma client)
  └── depends on @nexus/shared (vault, image-validation)

apps/web
  ├── depends on @nexus/database (Prisma client for server components)
  └── depends on @nexus/shared (vault, image-validation)

services/bidding-engine
  └── depends on @nexus/shared (vault)
```

---

## Turborepo Build Order

Turborepo's `build` pipeline ensures packages build before apps:

```
packages/database (prisma generate → dist/)
packages/shared (tsc → dist/)
    │
    ▼
apps/api (tsc → dist/)
apps/web (next build → .next/)
services/bidding-engine (tsc → dist/)
```

The `^build` dependency in `turbo.json` enforces this ordering.

---

## Related Notes

- [[02 - Monorepo Structure]] — workspace structure
- [[05 - Database Schema]] — full schema detail
- [[04 - API Layer (Fastify)]] — API uses these packages
- [[08 - Web App (Next.js)]] — Web uses these packages
