# Channel connections — completion matrix

Last fully verified release (2026-09-22): `0f89aa53-ce89-4518-91b6-76a5c2d68507`, **SUCCESS**,
commit `439d9e3d34ed79a09d76981da08de5d2ca0190e2`. Both GitHub jobs and the deployment
smoke test are **SUCCESS**. Final public/database verification repeated at **21:58 UTC**.
[Sanitized release evidence](build/RELEASE-2026-09-22-EVIDENCE.json). This supersedes
older pending-deployment notes; the full channel plan remains open.

Updated 2026-09-23 (production evidence uses UTC). **Open working audit; not a completion declaration.**

“Baseline” means the implementation is present in the previously verified deployed
commit `7c70556ea`; it does not mean enabled or production-verified. Historical test
records remain dated evidence. New findings override “all built” summaries. Active
scope: Amazon, eBay, Etsy. Shopify stays connected; P8 stays deferred.

Current source audit: three independent reviewers plus main-session source/contract
inspection. Fresh production evidence and new slices: [CX-COMPLETION](build/CX-COMPLETION.md).
New local continuation: [CX-REMAINING](build/CX-REMAINING.md). C9–C11d7 implement
atomic receipt identity, durable claims, grant generations, current-refresh inspection,
transactional revocation/owner warnings, private admission and same-/cross-record
seller fences, stored receipt execution, archive-never-delete, and rolling-deployment
holds. They are independently reviewed locally and remain undeployed/default-OFF.
I1/I2 integrate only published main and make bootstrap/test fixtures match deployed
constraints. The full local package gate passes on c65db206b (256 realPG/zero skips,
11504 API,4603 web,both builds,127 security; detailed skips/ratchet in build record).
U1 adds reviewed shared retention fields with real-browser/typecheck/build proof.
U2 corrects Ingress queued/completed feedback and preserves keyboard focus; see its
current build record. C11e1/e2 add reviewed owner-only recovery APIs/UI and profile
read-race guards (264 realPG and full local API/web/build gates in their record).
C11f1/f2 add owned-only maintenance, strict pinned/cold/lossless encryption and cache
race fixes (11543 full API tests,44 targeted realPG,7 mutations for f2). C11f3 adds
quarantine integrity separate from adoptability (79 focused,32 realPG,6 mutations).
These are local only. Global quarantine authority/inventory/atomic maintenance audit,
transactional order/erasure work and channel operational dependencies remain open.
The Owner approved deployment. Final commit `439d9e3d3` (C1–C8 plus two verification
repairs) is pushed to main and serving in production. At 21:54Z: native Railway
SUCCESS, exact health/readiness build, protected diagnostic GET401, migration
checksum/finished state and all 18 pre-existing connections preserved. GitHub CI
passed 1,904 API regressions (four existing skips) and 3,093 web regressions. The
Deploy API workflow and final smoke test are also SUCCESS. This is release
verification, not a completion declaration for every channel flow. The additive Etsy
alias migration is the approved data change. Separately prepared vendor probes,
connection deletion, new channel activation and P7 drops have not been executed.

C11d3 private eBay admission is local only; original-profile and quarantine race
proofs are in [CX-REMAINING](build/CX-REMAINING.md). C11d4 adds the locally reviewed
cross-record seller fence (10 realPG/190 regressions); C11d5 wires execution locally (233 realPG/176 regressions); operational
recovery/key maintenance/archive and activation remain open.

Reobserved at2026-09-23 16:27Z: published main and public health remain0a563d6d, healthy200; five quantity mismatches and critical Ads integrity persist.
This supersedes the old serving-build observation only; the dated439 business/flag
proof remains dated. New continuation slices are still unpushed/undeployed.

| Requirement | Implementation / test evidence | Deployed | Enabled / production proof | Remaining acceptance | Dependency |
|---|---|---|---|---|---|
| P0.1 | Gateway mode guards; build/P0.1.md | Baseline | Production modes need fresh read; no per-operation proof | Preserve zero-call fixtures; audit live enabled operations | Live proof |
| P0.2 | Auth/raw-body/timing-safe guards; build/P0.2.md | Baseline | Fresh protected diagnostic GET401 with health/readiness200,21:20Z | Local negative verification guards pass; retain channel-specific live-proof boundaries | Further live proofs separately |
| P0.3 | Encrypted operator secrets/private-address refusal; build/P0.3.md | Baseline | Storage encryption mode not freshly checked | Read boolean encryption evidence; no secret disclosure | Read evidence |
| P0.4 | Signed eBay refund transport; build/P0.4.md | Baseline | No successful sandbox/live refund proof | Authorized EU sandbox refund contract | Live call/test account |
| P0.5 | Expiry UI/90-30-7 alerts; build/P0.5.md | Baseline | Actual LWA expiry date outstanding | Record real date and verify owner notification | Owner portal + production write |
| P0.6 | Per-profile Amazon subscriptions/ledger; build/P0.6.md | Baseline | Current subscriptions/arrival evidence incomplete | Read current cron/ledger by profile | Live subscriptions separately |
| P0.7 | Account refusal replaced in queue by destination; build/P0.7.md | Baseline | Second-account end-to-end proof incomplete | Retain isolation guards; inspect live destination attribution | Live proof |
| P0.8 | Official deadlines; build/P0.8.md | Baseline | Documentation proof, not live feature | Current vendor checks used for amended flows | None for docs |
| P1.1 | gateway/gateway.ts; zero gateway ratchet | C5 deployed 439d9e3d3 | Auth-hold safeguards deployed; no held/resumed production row observed | Observe a naturally held/resumed row;20:38Z preflight found zero holds | Observation |
| P1.2 | Gateway ratchet freshly passes all five channels at zero | Baseline | Not per-operation production proof | Keep ratchet and documented exemptions unchanged | None for local gate |
| P1.3 | outbound-rows.ts; zero external creators; destination column | C5 deployed 439d9e3d3 | Per-account production attribution not freshly proved | Both drains deployed; per-account recovery production observation remains | Observation/live proof |
| P1.4 | Connected Shopify GraphQL; build/P1.4.md | Baseline | Connected Shopify preserved; stock round-trip not established | Preserve existing store; no activation as part of this scope | Owner test store/live call |
| P1.5 | Shared eBay marketplace headers; build/P1.5.md | Baseline | Fixture coverage; no new live proof | Retain per-market header regressions | Deployment if changed |
| P1.6 | Approved groups removed; build/P1.6-delete-list.md | Baseline | Remaining live dependencies retained | Do not equate zero traffic with unneeded fallback | New deletions separately |
| P1.7 | Preview and ended-listing guards; build/P1.7.md | Baseline | Historical fixtures; partial flat-file cap amendment | Keep approved 200-row preview policy and guard mutations | Live proof |
| P1.8 | contract/channel-contracts.ts has only four checks | Baseline | Switch historically on; accounts absent; coverage partial | Add supported contract coverage/partial state; configure test accounts | Test accounts + channel calls |
| P2.1 | C9–C11d7 local durable protocol, archive and rolling holds; package256 realPG/zero skips | C1 in published baseline; new protocol local only | New processing defaults OFF; no live signal proof | C11d6 local archive14 realPG/91 regressions and DB guards; C11d7 rollout9 realPG/5 mutations. Owner recovery API/UI is locally reviewed; global key maintenance and live delivery/recovery proof remain | Implementation + approved deployment/activation |
| P2.2 | Amazon per-type subscriptions and parsing; build/P2.2.md | Baseline | New types gated; every type arrival not proven | Actual subscription inventory and per-type real arrivals | Live calls/subscriptions |
| P2.3 | eBay notifications.ts/routes/handlers independently audited | C3/C8 deployed 439d9e3d3 | Startup log proves automatic setup disabled; no new subscription provisioned | C3 transport/status fixed; C8 readiness/explicit activation hold (83 tests); revocation processor now locally wired; operational quarantine, account-token topic coverage and real delivery remain open | Implementation + approved catalogue/activation |
| P2.4 | Shopify reconciliation/lifecycle; build/P2.4.md | Baseline | Store connected; no fresh uninstall/privacy proof | Preserve connection and regression coverage | Any test uninstall/write |
| P2.5 | Etsy receiver/receipts; C2 contract/routing: 35 focused + 5 real PostgreSQL tests | C2 deployed 439d9e3d3 | Migration checksum/finished state and exclusive shop57783036→Motovento route verified;12 scopes preserved | Finish transactional ingest/poll; register4 actual events and prove freshness | Stock policy/history boundary + registration/live call |
| P2.6 | C11a–d5 local: current-grant and seller fences; atomic revocation/owner warnings; receiver/worker/manual wiring;25 domain/10 seller/17 processor realPG | Legacy baseline only | Production still has the old path; new processing remains undeployed/OFF | Operational quarantine readiness and real signal/reconnect proof | Implementation + approved deployment/activation/live event |
| P2.7 | AMS dedupe and subscription check; build/P2.7.md | Baseline | Every live profile hourly arrival not freshly proved | Per-profile dataset/read controls | Live read if needed |
| P2.8 | Ingress DS tab; C11d5 local stored-ID replay/readiness preflight and private lease omission | C1 in published baseline; new routes/UI local | U2 synthetic actual-Ingress browser proof; no new production UI observation | C11e1 API32 realPG/44 route regressions and C11e2 UI54 tests/6 mutations/browser proof are local; key maintenance/global visibility and production proof remain | Implementation + browser observation |
| P3.1 | Gateway error vocabulary; build/P3.1.md real/shape fixtures | Baseline | No new outgoing call measured | Preserve channel codes/messages and fixture distinctions | None local |
| P3.2 | ListingIssue recorders and suppression job; build/P3.2.md | Baseline | Suppression pull defaults off; one-minute live rejection proof missing | Verify switch, listing attribution and rejected-change timing | Production enablement/live call |
| P3.3 | cx/account-calls.service.ts; studio syncQueue.ts says ListingIssue dormant | Baseline partial | Diagnostics exists; studio rejection pane not built | Finish shared listing-error presentation with studio boundary respected | Deployment |
| P3.4 | Channel owner Notification path; build/P3.4.md | C7 deployed 439d9e3d3 | Owner notification behavior proved locally56tests; no production failure induced | Observe owning-profile delivery/dedupe | Observation or approved controlled test |
| P3.5 | Success-response deprecation headers; build/P3.5.md | Baseline | Synthetic header proof; no real deprecation observed | Fixture is valid local acceptance; retain production observation distinction | Observation |
| P3.6 | Channel health/trace service; build/P3.6.md | Baseline | No-data is not green; positive operational SLO evidence incomplete | Read current per-operation counts, latency/backlog/DLQ targets | Production observation |
| P4.1 | Per-channel publish lanes; build/P4.1.md | Baseline | Per-operation live publication proof incomplete | Keep previews, account policy and Presence boundaries | Live publish approval |
| P4.2 | Image gateway/readback; build/P4.2.md | Baseline | Sweep historically on; positive-count proof required | Read current sweep counts/issues, preserve channels out of scope | Observation/live calls |
| P4.3 | Quantity resolver, routed clamp, EU fail-closed, inbound stock removal | Baseline | Etsy order stock policy needs explicit choice | Safe transactional Etsy effects; test duplicate/cancel races | Stock timing/opening boundary |
| P4.4 | Currency/bounds; price-readback.service.ts | Baseline partial | eBay price readback is missing | Implement scoped eBay price confirmation; no automatic price healing | Live read proof |
| P4.5 | Regional Ads discovery/disconnect/expiry; build/P4.5a-h.md | Baseline partial | No reconnect needed; Manual Collection wire value unresolved | Verify daily region repair and accepted SB contract | No reconnect; live probe only approved |
| P4.6 | Etsy writers/freshness; build/P4.6a-f.md | Baseline partial | Mode unknown; Motovento zero stored listings | Correct full freshness accounting and demonstrate supported writes | First write/mode approval |
| P5.1 | Orders 2026 adapter + quantity-4 live money proof; build/P5.1.md | Baseline | Enablement still gated | Set switch only approved; production quantities/totals/pagination verify | Production config approval |
| P5.2 | amazon-financial-events.service.ts independently audited | C4 deployed 439d9e3d3 | v0 retained; new-API writer hold deployed; comparison remains identity/overlap only | Approved overlap read, money mapping, null account attribution, safe reconciliation and race proof | Approved corrected dry run, then cutover |
| P5.3 | One Shopify version accessor; build/P5.3.md | Baseline | 2026-07 historical traffic; preserve connected store | Quarterly version maintenance remains operational | None current scope |
| P5.4 | No buyer-PII/RDT path; build/P5.4.md | Baseline | Historical 4,464 order census; privacy ratchet | Keep data-minimization choice; no RDT invented | None |
| P5.5 | Search Returns not on official decommission list | Not required | Supported read retained | No speculative replacement | None |
| P6.1 | cx/amazon-secret-rotation.service.ts | C7 deployed 439d9e3d3 | Startup at 21:51Z proves rotation OFF: credential queue URL absent | Queue/portal/effective IAM setup, recovery serialization and end-to-end rotation proof | Queue registration + live rotation |
| P6.2 | Signing-key expiry parsing; build/P6.2b.md | Baseline | eBay expiry 2029-08-28 historical live proof | Fresh heartbeat/expiry read; no rotation needed now | Read/observation |
| P6.3 | Rotated Etsy token persistence; build/P6.3.md | Baseline | Connected Motovento heartbeat proves token path only | Retain persistence retry/race guards; inspect failures | Observation |
| P6.4 | Local revoke/channel removal hint; build/P6.4.md | Baseline | No destructive production revoke requested | Preserve honest per-channel outcomes | Any disconnect separately |
| P6.5 | Owned-only heartbeat; build/P6.5.md | Baseline | Guest-account write isolation fixture evidence | Real DB RLS coverage, owner/guest runtime evidence | Observation |
| P6.6 | Private authorization/import; env fallback instrumentation | Baseline | Only ~32-minute prior zero, not one full day | Observe full cron cycle; retire env fallback after evidence | Production switch approval |
| P6.7 | Post-Order auth documented; no extra scopes required | Resolved amendment | No reconnect required | Optional actual keyset portal confirmation | Portal read |
| P6.8 | OAuth callbacks/apps; actual Etsy and Shopify connections read | Baseline plus current release | Etsy Motovento + Shopify Xavia ownership/state/scopes preserved at 21:54Z | Verify callback URLs/webhook mode separately | Portal changes separately |
| P7a | Dependency census; channel-sync inert worker and producer remain | Partial | No deletion authorized by continuation | Justified code removal list; retain live Ads fallback | Explicit deletion boundary |
| P7b | Schema dependency inventory | Not started | Green week not elapsed/proven | Each table requires dependency retirement + green week + individual approval | One yes per drop |
| P8 | New channels | Deferred | Explicitly out of scope | Preserve connected Shopify; no new channel work | New scope decision |
| CX cleanup | 4abb1a371 guarded deletion; prior 59 tests/101 PostgreSQL gate | Deployed 439d9e3d3 | All18 connections preserved; exact-ten candidates untouched | Fresh exact-ID/dependent check immediately before any approved deletion | Exact-ten approval separately |

## Measurable quality obligations (no blanket AAA pass claimed)

| Dimension | Acceptance threshold | Current proof / unresolved evidence |
|---|---|---|
| Correctness | Exact money/currency/quantity semantics; zero duplicate financial effects; no quiet partial reads | C4 correct identifiers, rejects partial pagination, performs zero money writes. Monetary reconciliation/cutover still open. |
| Account isolation | Every write and inbound action names exactly one owner; foreign/missing/ambiguous identity causes zero effects | C2 five realPG routing cases; C11d3 admission24 and C11d4 seller10 realPG cases, stored processor17 and rollout9 cases. Quarantine operator access and transactional order/stock isolation remain. |
| Security | Invalid/missing verification executes zero handlers; credentials never in diagnostics; no auth bypass | C1 38 tests/two killed mutations; existing boolean-only credential report retained. C11f1 locally fences maintenance targets/owned scope and truthful failure state; cold recovery/global key maintenance and live KMS/Neon proof remain. |
| Resilience | Failed work remains recoverable; sign-in/rate holds spend zero row retries; no premature SUCCESS | C3/C5 deployed guards; C9–C11d7 local durable claims/replay/warnings and archive races, including five rollout and six archive mutations. Production delivery/recovery observation remains. |
| Performance | Bounded traversal/work, account concurrency preserved; measure real latency/backlog against P3.6 targets | Notification reads max20 pages/collection, finances max50 pages, retry drain max200 rows. No production p95/positive-load claim yet. |
| Accessibility | Existing DS controls; keyboard-only critical paths, responsive 390/1280 widths, light/dark; no serious/critical accessible-name/focus violations | U1 actual retention component uses shared DS Card/Field/Input/Button: key-by-key typing, validation, keyboard/focus,320–1440 widths and light/dark checked with synthetic local data; hint contrast5.32/7.38. Full-app Ingress/Diagnostics and studio errors remain unverified; no WCAG AAA claim. |
| Observability | Failed/rejected/unknown events remain visible; complete=true/healthy only with positive evidence; owning-profile alerts | C1 rejects remain in ledger; C3 failed cron persists FAILED; empty/partial compare explicit. C7 persists rotation owner alerts; production delivery still unobserved. |
| Maintainability | Named slice commits, independent review, typecheck, canonical ratchets, no new suppressions/skips/weakened hooks | C9–C11d7/I1/I2 locally reviewed. Canonical on c65db206b:11504API/287skips,4603web/13skips,both builds,127security,256realPG/zero skips,RBAC2725/0unmapped. Profiles ratchet41known failing/217tests,none new/worse. Latest C11e2 package:11518API/295skips,4640web/13skips,264realPG/zero skips,both builds,127security,RBAC2727/0unmapped; ratchet unchanged. Next approved push reruns hooks. |

P7's green week and each destructive-drop approval remain mandatory. The approved deployment and additive Etsy alias migration are now applied. No
connection deletion, manual credential change, channel activation or P7 drop was performed.
