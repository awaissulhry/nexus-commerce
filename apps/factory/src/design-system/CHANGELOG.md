# Changelog — Nexus Design System (Factory mirror)

## Account names — 2026-09-08

Mirrored the complete account-style block, previously absent in Factory, including 390px-tested container-responsive layout. Hosts can supply accurate verification wording or hold unavailable actions through `reconnectLabelForAccount`.

Mirrored the shared account/channel display-name helpers and name-only switcher, panel, and scope chips from Web. Opaque keys remain internal, including in accessible labels and dialogs; missing names are explicit and can be renamed. Regression tests cover legacy IDs and real names.

## Amazon Seller migration — 2026-09-08

Mirrors Web’s `AccountsPanel`, account model, tests, application-role permission copy, and explicit ENV-credential replacement action. The copy covers both public website authorization and private-app self-authorization import.
