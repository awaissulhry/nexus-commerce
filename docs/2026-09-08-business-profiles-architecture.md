# Business profiles and channel accounts

Date: 2026-09-08
Status: implemented in the local working tree behind coordinated API/web feature flags.
Evidence: local PostgreSQL migration rehearsal, automated tests, and browser checks; see
[audit and rollout record](audits/2026-09-08-business-profiles/README.md). Production has not been migrated or enabled.

## Recommendation

Make a **Business profile** a real workspace that owns business data, channel accounts,
settings, and access assignments. Use `Workspace` as its internal name. A person signs in
once and accesses workspaces through memberships. An email identifies a login; it does
not own the business data or define an authorization boundary.

For the requested example:

```text
Your Nexus login
  Membership: owner → Xavia Racing
    Amazon → Xavia Racing seller account → enabled marketplaces
    eBay   → Xavia Racing seller account → enabled marketplaces
    Other connected channels
  Membership: owner → Another business
    eBay   → a different seller account → enabled marketplaces
```

A workspace may contain several accounts on the same channel. A second eBay account can
belong to Xavia Racing when it is part of the same operation, or to a new workspace when
it needs separate settings, data, and access. Do not impose one account per channel.

**Implemented default:** separate catalogs and stock between
workspaces by default. Explicit sharing can be supported where needed. Catalog sharing
and inventory sharing are independent decisions; neither implies the other. Within a
workspace, channel destinations can use the same master products and explicitly assigned
stock pools without automatically publishing every product everywhere.

Keep the initial hierarchy shallow. A parent organization can group workspaces for
consolidated billing and administration if that requirement is established. It should not
be an extra mandatory selector or an excuse to merge workspace permissions. The requested
one-login/many-business behavior does not require that additional tier.

## Terminology and ownership

| Concept | Meaning and ownership |
| --- | --- |
| User | The person signing in; owns personal identity, login security, and personal preferences. Use an immutable user ID for relationships. |
| Workspace / Business profile | The business operation; owns its business records, settings, channel accounts, and membership roster. |
| Membership | A user's access to one workspace, including status and role assignments. One person can have different roles in different workspaces. |
| Role | A set of permitted actions, such as Owner, Administrator, Operator, or Viewer. Role assignments are constrained by membership and any narrower account access. |
| Channel account | A verified external seller/shop identity, with one owning workspace. Names and colors are presentation, not identity. |
| Connection / authorization grant | Credentials and authorization lifecycle used to reach external accounts and destinations. Reauthorization preserves account identity and business history. |
| Marketplace destination | A selling market reached through a channel account. A country is not a separate business profile merely because it is another marketplace. |
| Listing | A product's representation at an explicit account and marketplace destination, with its own content, pricing, and publication state. |

Do not equate the number of credential grants with the number of business profiles.
Connector modeling must permit grant boundaries and account/market boundaries to differ.
Retain the existing connection and token services where they meet this contract; split
durable account identity from credential lifecycle when the connector requires it.

One external seller account should have one owning workspace. Access for several people
comes from memberships. If two brands need to operate the same seller account, model the
brands and product assignments inside its workspace, or design explicit delegated access;
do not duplicate the credentials and establish two competing owners of listings and stock.

Do not enable simple reassignment of a live account between workspaces. The implemented
assignment review permits unused, disconnected accounts only, with live Owner access to
both profiles. It refuses active credentials, pending sign-ins, recorded business activity
and linked business records. An account with business history needs a reviewed data migration.
An eligible assignment reserves the verified seller identity for the destination and creates
a new, inactive connection there without credentials. The source connection is retired and
cannot be reused; its events and scopes remain in the source business. Old job references
retain that inactive ID. The destination requires a fresh marketplace sign-in. Ownership,
connection creation and both audits commit atomically; stale reviews and retries are checked.
Disconnecting an account suspends integrations while preserving account attribution and
history. Archiving a workspace is distinct from deleting it.

The header retains the current profile and a small shortlist, with Search, Create and Manage
actions available even for one profile. The manager and account destination picker use
server-side search and cursor pagination. Creation has no hard profile-count limit; page
requests are bounded to 100 results and the UI normally requests 24. This removes full-list
preloading without claiming unlimited infrastructure capacity or a measured load ceiling.

## Settings contract

| Settings area | Scope |
| --- | --- |
| Name, email, password, MFA, sessions, theme, personal display language | User |
| Business identity, address, operational timezone, reporting currency, branding, business defaults | Workspace |
| Team invitations, member access, account restrictions, business API keys and integrations | Workspace, optionally narrowed to an account |
| Connection status, credential permissions, synchronization options, account defaults | Channel account / authorization grant as appropriate |
| Marketplace shipping, returns, tax configuration and listing overrides | Account plus marketplace, where the channel supports these settings |
| Personal saved views and notification delivery preferences | User plus workspace when business context matters |
| Shared saved views and automation rules | Workspace, with explicit destination restrictions |

Inheritance must be defined per setting. Where supported, show whether a value is inherited
from workspace defaults or explicitly overridden for an account/market. Resetting an
override returns to the documented default. Never inherit across business profiles.
Business timezone and personal display timezone are different settings. Changing reporting
currency does not rewrite historical order currencies or silently convert listing prices.

## Interaction contract

1. The global business switcher shows the current workspace and the workspaces the user can
   access. It always permits an authorized owner to create a second profile, including when
   only one exists. Creation establishes the workspace and owner membership atomically.
2. Keep personal identity/settings in the user menu. Manage roles under team settings;
   selecting a role is not switching businesses.
3. Inside a business profile, Channels lists its connected accounts and their actual health.
   Connecting another account captures the destination workspace before authorization starts.
   Reconnecting verifies the returned external identity against the existing account.
4. Pages may display several accounts within the current business. A channel operation
   names its account and marketplace; bulk operations enumerate their destinations explicitly.
5. Put the workspace in the route, for example `/w/<workspaceId>/products`. Account and
   marketplace selections further narrow that context. Switching preserves the page type and
   compatible filters; it cannot carry an old workspace's record ID into the new workspace.
6. Unsaved edits require a save/discard/cancel decision before leaving. Finish or detach pending
   work with its original context; changing the visible profile cannot retarget a write.
7. Different tabs may use different workspaces simultaneously. A last-used-workspace preference
   is only a navigation default, never the authority for an API request or background task.
8. Cross-profile reporting is an explicit aggregate view over authorized workspaces. It does not
   become an implicit destination for editing, publishing, or settings changes.

Implement platform UI using the existing Nexus design system. Read the relevant component
sources before implementation, document any reusable gap, and mirror shared changes to
Factory. Preserve documented control density. Verify keyboard access, focus, responsive
presentation, and both themes; “AAA quality” is a quality requirement, not a claim of audited
WCAG AAA conformance.

## Enforcement and consistency

- Establish authenticated user, requested workspace, live membership, and permitted actions
  for each request. An owner is an owner within their workspace. Never union an Owner role in
  workspace A into authority in workspace B.
- Validate resource ownership as well as the route permission: an account, product, order,
  file, or listing ID must belong to the authorized workspace. An opaque ID is not permission.
- Apply the same contract to API routes, GraphQL, server actions, SSR, exports, search,
  webhooks, scheduled work, workers, and machine credentials. Inbound events derive context
  from a verified provider account mapping; missing or ambiguous mappings require resolution.
- Carry workspace and destination IDs into job payloads, audit events, cache keys, object
  storage namespaces, and subscriptions. Prevent late responses from rendering into another
  workspace. Queue execution rechecks relevant account status and current authority; scheduled
  integrations use an explicitly scoped service identity rather than an ambient browser user.
- Bind OAuth state to the initiating user, workspace, connector, operation, and reconnect
  target when applicable. Validate the one-time state and membership on return. A workspace
  switch in another tab must not change where the account is attached.
- Scope business data at the database layer through required ownership keys or unambiguous
  parent relationships, with constraints that prevent cross-workspace associations. Move
  global business uniqueness rules, such as SKU, into the appropriate workspace/catalog scope.
  Provider identifier uniqueness must respect the connector's identity domain, environment,
  account and marketplace where applicable.
- Defaults are suggestions inside an authorized workspace. Resolve and persist the actual
  destination before queueing a write; later default changes cannot retarget it. Never fall
  back to another workspace's primary account when a destination is missing or disconnected.
- Preserve one authority for stock reservations and quantities per pool. Cross-workspace
  sharing, if enabled, requires explicit grants and allocation rules; a copied catalog must
  not create two independent counters for the same physical stock.
- Use centralized authorization and scoped database access. PostgreSQL row-level security
  can provide an additional boundary where implemented with transaction-local context and
  application roles that cannot bypass policies. Verify pooling, workers, and migrations before
  relying on it; a dropdown and scattered query filters are insufficient.

Start with shared infrastructure and indexed workspace scopes. Add per-workspace/provider
queue fairness, concurrency and rate limits, observability, and usage accounting. Isolation
and explicit context permit later partitioning or dedicated infrastructure where measured
workload or contractual requirements justify it. More databases or services alone do not
make the business model more scalable.

## Findings before implementation

The following table records the problems found at the start of this work. Its line numbers
refer to that source snapshot, not the current implementation. Business profiles, memberships,
scoped settings and connection ownership now replace the behavior described below.

| Finding | Evidence | Consequence |
| --- | --- | --- |
| The present profile selector reads permission roles and changes a client-side view. | `apps/web/src/app/_shared/ProfileScope.tsx:5`, `ProfileSwitcher.tsx:29` | Replace the business-switching concept; preserve role administration separately. |
| Channel connections already have external identity, labels, encrypted credential support, and market scopes, but no business workspace ownership. | `packages/database/prisma/schema.prisma:6183` | Extend the existing connection foundation instead of duplicating connector implementations. |
| Permissions resolve global role keys, with Owner granting implicit access; the resolver does not consume workspace membership. | `apps/api/src/lib/auth/rbac.ts:41`; `schema.prisma:4728` | Membership-scoped authorization is foundational, not a later UI enhancement. |
| Business settings select the first AccountSettings row. | `apps/web/src/app/settings/account/actions.ts:53` | Add workspace ownership before exposing settings for several businesses. |
| Personal profile writes and some legacy profile endpoints select the first user. | `apps/web/src/app/settings/profile/actions.ts:86`; `apps/api/src/routes/profile.routes.ts:39` | Resolve the authenticated user; correct these paths before treating the platform as isolated for multiple users. |
| Product SKU is globally unique and Product has no workspace owner. | `packages/database/prisma/schema.prisma:83` | Separate business catalogs need a schema and consumer migration. |
| Connections are selected by ID or channel without workspace context; declared resolution can select the primary account. | `apps/api/src/services/connection-resolver.service.ts:158`, `:167`, `:256` | Thread verified workspace context through resolution and bind writes to concrete destinations. |
| Listings and orders already carry channel-connection attribution in several models. | `schema.prisma:1652`, `:5178` | Reuse and validate attribution during migration; do not rebuild business history unnecessarily. |

The August multi-account design's MAP.8 describes account restrictions within role JSON.
That alone does not establish the business ownership, settings, and catalog boundaries
required here. This implementation extends the business model beyond that earlier milestone. Existing account-restricted legacy roles cause migration preflight to stop; they are never silently promoted to unrestricted business roles.

## Implemented structure

- `Workspace`, memberships, membership roles, invitations and audit records hold business
  ownership and access. An owner creates a workspace, its settings and a default warehouse
  in one transaction. Creation retries are idempotent. Profile edits and access changes
  reject stale versions; an active last owner cannot be removed.
- All 409 inventoried business models have workspace ownership. PostgreSQL policies use
  a non-bypass runtime role and transaction-local context. Natural identifiers such as SKU
  are scoped, and database triggers reject links to another workspace’s records.
- `ChannelAccountOwnership` keeps verified seller ownership across disconnect/reconnect.
  `ChannelAccountRoute` is a minimal active index for verified inbound provider messages;
  account scope changes and reactivation update its destinations. OAuth state captures
  the original workspace, user, environment and reconnect target.
- Browser routes use `/w/<id>/...`; API and server-rendered requests validate live membership.
  Scoped database access also covers nested queries and transactions. Business API keys,
  background jobs and event delivery carry their original context.
- Scheduled work visits active businesses in bounded pages with renewable Redis leases.
  User jobs recheck membership, role version and API-key revocation. Archive blocks new
  access/work; restore marks a cutoff so old queued jobs cannot resume accidentally.
- Business caches, local catalog storage and search collections use workspace namespaces.
  Account credential resolution refuses another business’s account or an ambiguous account
  selection. Legacy environment credentials remain limited to the initial legacy business.
- The profile manager supports create, rename, archive and restore. Team settings support
  scoped roles, member access, revocation and private invitation links. Personal profile and
  security settings stay outside business selection. The switcher preserves page sections
  while dropping record IDs and account filters. Business settings use Nexus controls,
  guard unsaved changes, and reject competing edits from another tab.

The remaining sections define the intended release contract. They are not claims that a
production reconciliation, live seller authorization, large-scale load test, transfer of accounts with business history,
or cross-business reporting/sharing has been performed. See the audit record for precise
validation and remaining release conditions.

## Migration sequence and release evidence

1. Inventory ownership and access across business entities and every entry point, including
   direct database server actions, workers, credentials, files and reporting. Resolve whether
   existing records belong to one initial workspace or several; do not infer ownership from
   account labels alone. Record current counts and attribution before changing anything.
2. Add workspace and membership models and ownership keys additively. Backfill only verified
   ownership. Preserve existing IDs, connections, credentials, and business history. Quarantine
   ambiguous attribution for review. Make the migration resumable and prepare rollback.
3. Enforce server and database scope, update unique constraints and foreign keys, and pin
   asynchronous destinations. Correct singleton user/settings paths. Verify all existing
   behavior with the initial workspace before enabling creation of a second one.
4. Build workspace creation/switching, scoped settings, account assignment/connect/reconnect,
   and team access on the same authorization contract. Include creation with zero channel
   accounts and access revocation while a workspace is open.
5. Enable multiple workspaces after migration reconciliation and isolation checks pass.
   Once new workspace records exist, rollback must preserve their ownership; falling back to
   an old unscoped application is not an acceptable rollback strategy. Use feature containment
   or a forward fix where restoring a pre-migration snapshot would lose subsequent writes.

Required evidence includes:

- One login switches between two workspaces; Amazon and eBay coexist in one workspace;
  two accounts on the same channel also work within one workspace.
- Identical SKUs in two separate workspace catalogs do not collide or merge records.
- Settings, files, search results, exports, notifications, and cache contents stay scoped.
- A member denied workspace B cannot read or mutate B by supplying its resource IDs through
  any exposed route or server action. A workspace A Owner gets no automatic authority in B.
- Revoked memberships and account restrictions take effect on open sessions and relevant
  queued work. Missing scope fails closed.
- Two tabs stay independent, stale requests cannot overwrite the newly visible context,
  and a queued publish remains attached to its original workspace/account/market.
- OAuth return after switching workspace, wrong-account reconnect, duplicate connection,
  disconnect, reconnect, and archival preserve identity and historical attribution.
- Migration counts, relationships, financial totals, and inventory reconcile; restoration
  or containment has been rehearsed for the supported rollout stage.

## External reference checks

The concrete design above is a recommendation based on Nexus's requirements and local code.
It follows the separation between authenticated identity, business membership and resource
isolation described in [AWS tenant isolation guidance](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html).
AWS explicitly distinguishes tenant isolation from authentication and general authorization.

[Auth0 Organizations](https://auth0.com/docs/manage-users/organizations) is another example of
business-specific membership and roles. This is supporting architectural context, not a
recommendation to replace Nexus authentication or introduce Auth0 as a dependency.
