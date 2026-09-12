# Settings navigation conversion — 2026-09-08

Settings now composes the same `WorkspaceSubheader` used by Product Edit Studio, with `DetailHeader` and `ToolbarButton`. The old fixed secondary rail and its separate mobile state store are removed. Settings owns its page padding so the subheader meets the application rail and page content occupies the full available width.

The existing settings registry still supplies every group and destination. Permission filtering runs against canonical routes before native link URLs receive their business profile prefix. Personal settings and the business profile directory retain their identity routes. Nested channel and family pages retain their parent selection. Settings search and form/save providers remain mounted in the layout.

All new feature CSS handles layout and uses Nexus semantic tokens. No shared design-system component needed modification or extension. The consumed `WorkspaceSubheader`, `DetailHeader`, `ToolbarButton`, and `Drawer` sources match their Factory mirrors. Individual settings forms, the overview cards, and the search dialog retain their existing implementations in this navigation-only conversion.

## Validation

- Focused Vitest suite: **7 passed** across `settings-navigation.vitest.test.ts` and `paths.vitest.test.ts`. Covers business-scoped native links, shared identity routes, permission filtering, empty groups, nested route selection, profile changes, unscoped routes, and valid disclosure IDs.
- Nexus token check: passed.
- DS conformance, raw primitive, CSS shadow, raw hex, and radius ratchets: all passed without changing baselines.
- Targeted `git diff --check`: passed. No obsolete `SettingsRail` imports remain.
- Initial web type check passed. The final check reported one unrelated error in `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/ChannelSheet.tsx:2206`: **TS2783, `initialState` is specified more than once**. No Settings diagnostics were reported. That product editor file was not changed for this task.

## Browser verification

Used the disposable business-profile fixture at `127.0.0.1:4126`, with synthetic accounts. Verified the Settings overview and Channels pages, plus navigation to the business profile directory. No provider authorization or live account changes were performed.

- Desktop 1728 × 906: drawer at x=66, y=56, width=224, aligned with the application rail and top bar. Content width remained 1662px with the drawer both closed and open.
- Mobile 390 × 844: drawer at x=66, y=56, width=324. No horizontal overflow. The last navigation link remained visible when reached by keyboard (bottom=836px).
- Verified light and dark presentation, active Channels highlighting, named collapsible groups, Enter toggling, Tab/Shift+Tab focus wrapping, Escape dismissal, and focus return to the opener.
- Clicking the current route closes the drawer. Business profile navigation reached `/profiles`; the Settings back link reached the scoped overview.
- Search trigger opened the existing settings palette; searching `ebay` returned Channels.
- After scrolling the overview 483.5px, the sticky subheader remained at y=56, directly below the top bar.
- A local test session redirected to sign-in during a reload. Signing in again restored navigation, including the overview.

Screenshots: [desktop dark](desktop-dark.png), [desktop light](desktop-light.png), [mobile dark](mobile-dark.png), [mobile light](mobile-light.png).

This is a local implementation and verification record; no deployment was performed.
