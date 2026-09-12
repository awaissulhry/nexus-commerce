# Store product information browser fixture

Run from the repository root after installing the workspace dependencies:

```sh
node docs/audits/2026-09-08-store-product-information/browser-fixture/server.mjs
```

Open `http://127.0.0.1:3136/products/store-demo/edit/studio?scope=SHOPIFY&market=GLOBAL`.

This mounts the actual StudioClient and Nexus design system through Vite. Navigation and authentication have small local shims. Shopify/Etsy column metadata comes from the local Studio API; all sample product identities, content, accounts and readiness are synthetic. The fixture includes one parent and two children. It does not access a channel account or a database.

Edits affect memory only. Restart the server to reset them. `/api/fixture/evidence` records the write payloads for inspection. The fixture does not implement server validation, database transactions, publishing, or complete readiness recomputation after edits. Those are not browser-fixture assertions; the API test suites exercise validation, storage routing and optimistic concurrency separately.

Rehearsal: switch Shopify/Etsy, edit Title with Enter, cancel with Escape, select Etsy’s maker enum, open Requirements and close it with Escape. Verify focus returns to the opener. Repeat in both themes at 768px and 390px, using arrow keys for channel selection. The selected channel must stay visible within the scrolling chip track and the document must not overflow horizontally. The information grid retains its own horizontal scrolling.
