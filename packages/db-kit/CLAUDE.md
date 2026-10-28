# packages/db-kit — generic database tools for the factory

Generic and fail closed: no factory names inside, roles and setting names are parameters. Today it holds
`url-guard` (is a connection URL on this machine?), used by the factory env loaders. The tenant adapter, the
runtime-role audit and the policy SQL generator come in a later step. Commerce keeps its own copy in
`packages/database`; nothing in Commerce imports this package.

## Commands
    npm run typecheck -w @nexus/db-kit
    cd packages/db-kit && npx vitest run

## Rules
- Exports TypeScript source (`exports` point at `src/*.ts`); there is no build step.
- No environment reading here: callers pass URLs, roles and settings in.
- A test that needs PostgreSQL uses a throwaway database, never a URL from a `.env`.
