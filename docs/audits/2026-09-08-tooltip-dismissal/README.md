# Sub-sidebar tooltip dismissal — 2026-09-08

## Cause and fix

Reproduced on the Settings sub-sidebar: after clicking Collapse, focus returned to “Expand settings navigation” and its portal tooltip remained fully visible (`opacity: 1`, 180.77 × 35.40px, at x=8/y=22.60). The tooltip opened on every focus event, including Drawer focus restoration, and pointer exit kept it open whenever the trigger retained focus. This was an interaction-state issue, not a long animation delay.

The shared portal Tooltip now dismisses on pointer activation, click, Enter/Space, and Escape. Dismissal survives focus restoration and stationary-pointer re-entry. Keyboard navigation inside an expanded disclosure does not rearm its trigger. A fresh keyboard visit or deliberate pointer movement can show the hint again. Hover hints no longer inherit restored or pointer focus and therefore close on pointer exit. Touch pointers do not open hover hints.

The fix applies to WorkspaceSubheader consumers, including Settings and Product Edit Studio, through the existing TooltipPortalProvider. The tooltip interaction source and regression tests are mirrored in Factory. No feature CSS, timing values, control sizes, or Drawer focus restoration changed. Existing inline CSS tooltips retain their implementation.

## Validation

- Web: 14 targeted tests passed (9 tooltip regressions and 5 Settings navigation tests).
- Factory: all 9 mirrored tooltip regressions passed.
- Web and Factory type checks passed.
- Web and Factory token checks passed.
- DS conformance and raw-primitive ratchets passed; no baseline changes.
- Shared tooltip source parity and targeted `git diff --check` passed.

Browser verification used the existing local fixture on port 4126 and the shared component catalog at `/design-system#workspace-subheader-example`:

- Pointer open/close: focus returned to the opener with zero visible portal tooltips.
- Enter/Space open, Tab through the drawer, then Escape: focus returned with zero tooltips.
- Selecting the Images destination and clicking the backdrop both closed the panel without reopening a hint.
- A subsequent Tab/Shift+Tab visit showed the tooltip again.
- Fresh pointer movement showed the tooltip; leaving cleared it while the trigger retained focus.
- Desktop 1728 × 906 Settings and mobile 390 × 844 shared catalog specimen passed in light and dark themes. The visible keyboard focus ring remains intact after dismissal.

Screenshots: [desktop light](desktop-light.png), [desktop dark](desktop-dark.png), [mobile light](mobile-light.png), [mobile dark](mobile-dark.png).

Implemented and verified locally. No deployment or live account changes were performed.
