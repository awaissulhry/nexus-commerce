# Isolated product transfer browser fixture

This harness renders the real product transfer drawer, source mapper, review and Nexus design system. Auth, surrounding editor state and backend location are fixture adapters. The API process registers the real transfer routes against an isolated synthetic store; it does not write the working catalog.

Run from the repository root in separate terminals:

```sh
NEXUS_PRODUCT_TRANSFER_BROWSER=1 npm run test --workspace=@nexus/api -- src/services/pim/catalog-product-transfer.vitest.test.ts -t 'serves the isolated product transfer browser fixture'
```

```sh
node docs/audits/2026-09-08-product-transfer/browser-fixture/server.mjs
```

Open `http://127.0.0.1:3126`. The API listens on port 4108. Stop both processes when finished.

The labeled synthetic-source action supplies an inspected fixture to the real mapper for environments that cannot automate native file selection. It does not establish browser upload acceptance. Export, review, save, filters and recent-job recovery use the real components and API routes. See the [implementation report](../../../2026-09-08-product-import-export-implementation.md) for evidence and limitations.
