# Playwright tests for /products/[id]/edit?tab=images

Scaffolded in IR.16. The config + smoke spec are in place; auth-gated
specs are marked `test.fixme()` until a session-cookie fixture exists.

## Running locally

```bash
# One-time browser install (~150 MB)
npx playwright install chromium

# Run against local dev server
npm run dev --workspace=@nexus/web   # in another terminal
npx playwright test --workspace=@nexus/web

# Run against the live deploy
PLAYWRIGHT_BASE_URL=https://nexus-commerce-three.vercel.app \
  npx playwright test --workspace=@nexus/web
```

## What to add when the auth fixture lands

Replace each `test.fixme()` in `images-workspace.spec.ts` with `test()`,
and add a `beforeEach` that signs in via cookie or NextAuth JWT. Then
the IR.1–IR.15 surface gets real visual + behaviour coverage:

- Master gallery renders correctly across 0 / 1 / 5 / 50+ image counts
- Lightbox + drawer sections (AI quality check, Auto-enhance, DAM, version chain)
- Image editor crop / rotate / flip with each aspect-ratio preset
- DAM picker filter combinations (folder + tag + missing-alt)
- Apply-to-children confirmation banner + success toast
- Publish-history rows with retry + manual SP-API refresh
- Per-marketplace Amazon guidance card (IT/DE/FR/ES)
- Italian-text overlay locale warning

## Visual-regression snapshots

`playwright.config.ts` sets a lenient `maxDiffPixelRatio: 0.02` /
`threshold: 0.2` so font-rendering noise across CI machines doesn't
fail every run. First run creates `*.png` snapshots alongside specs;
subsequent runs compare. Update with `--update-snapshots`.

CI integration is NOT wired — that's another commit + a GitHub
Actions workflow with browser caching.
