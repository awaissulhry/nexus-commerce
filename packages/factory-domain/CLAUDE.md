# packages/factory-domain — the factory's pure logic

Pure TypeScript: state machines, rules, unit conversions, numbering formats, document builders, zod contracts,
permissions and the event catalogue, one folder per module (`src/<module>/`). It exports source:
`@nexus/factory-domain/<path>` is `src/<path>.ts`; there is no build step.

## Commands
    npm run typecheck -w @nexus/factory-domain
    cd packages/factory-domain && npx vitest run [src/<module>]

## Rules
- No I/O: no Node I/O module, database, queue, network client, provider SDK, `fetch` or `process.env` in a source
  file (`src/purity.vitest.test.ts`). Ports (interfaces) live here; the adapters that do the I/O live in
  `apps/factory-api`.
- No float for money or quantities: use decimal.js; no `parseFloat`, `.toNumber()` or `Number(<amount>)`
  (`scripts/factory/check-no-float.mjs`).
- Tests are `*.vitest.test.ts` next to the code and need no database.
