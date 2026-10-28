# apps/factory-web — the factory web app

Next.js 16 (App Router), the same Next and React versions as `apps/web`. Today one placeholder page. The four views
(Office, Floor, Portal, Links), the app shell and the design system come in later steps.

## Commands (from the repository root unless noted)
    FACTORY_API_URL=http://127.0.0.1:8190 npm run dev -w @nexus/factory-web     # :3200
    npm run typecheck -w @nexus/factory-web     # next typegen + tsc; needs no API
    cd apps/factory-web && npx vitest run
    cd apps/factory-web && FACTORY_API_URL=http://127.0.0.1:1 npx next build

## Rules
- `FACTORY_API_URL` has NO fallback: without it `next dev`, `next build` and `next start` refuse to start
  (`next.config.ts`). Only `next typegen` loads without it. Never point it at a production API from this machine.
- The browser reaches the API through this app: `/api/*` is rewritten to `<FACTORY_API_URL>/api/*`, so the session
  cookie stays first-party.
- No database access from the web: never import `@nexus/factory-db`.
- Environment only as `process.env.FACTORY_…` (`scripts/factory/check-env-loader.mjs`).
- Do not import the Commerce design system from `apps/web/src/design-system`: it moves into a package first. No
  Tailwind.
