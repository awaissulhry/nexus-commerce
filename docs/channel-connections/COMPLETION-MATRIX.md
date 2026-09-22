# Channel connections — completion matrix

Updated 2026-09-22. **Open working audit; not a completion declaration.**

“Baseline” means the implementation is present in the previously verified deployed
commit `7c70556ea`; it does not mean enabled or production-verified. Historical test
records remain dated evidence. New findings override “all built” summaries. Active
scope: Amazon, eBay, Etsy. Shopify stays connected; P8 stays deferred.

Current source audit: three independent reviewers plus main-session source/contract
inspection. Fresh production evidence and new slices: [CX-COMPLETION](build/CX-COMPLETION.md).
No production mutation or live API call has been performed in this continuation.

| Requirement | Implementation / test evidence | Deployed | Enabled / production proof | Remaining acceptance | Dependency |
|---|---|---|---|---|---|
| P0.1 | Gateway mode guards; build/P0.1.md | Baseline | Production modes need fresh read; no per-operation proof | Preserve zero-call fixtures; audit live enabled operations | Live proof |
| P0.2 | Auth/raw-body/timing-safe guards; build/P0.2.md | Baseline | Historical anonymous 401 with healthy control | Repeat anonymous read after package deploy | Deployment |
| P0.3 | Encrypted operator secrets/private-address refusal; build/P0.3.md | Baseline | Storage encryption mode not freshly checked | Read boolean encryption evidence; no secret disclosure | Read evidence |
| P0.4 | Signed eBay refund transport; build/P0.4.md | Baseline | No successful sandbox/live refund proof | Authorized EU sandbox refund contract | Live call/test account |
| P0.5 | Expiry UI/90-30-7 alerts; build/P0.5.md | Baseline | Actual LWA expiry date outstanding | Record real date and verify owner notification | Owner portal + production write |
| P0.6 | Per-profile Amazon subscriptions/ledger; build/P0.6.md | Baseline | Current subscriptions/arrival evidence incomplete | Read current cron/ledger by profile | Live subscriptions separately |
| P0.7 | Account refusal replaced in queue by destination; build/P0.7.md | Baseline | Second-account end-to-end proof incomplete | Retain isolation guards; inspect live destination attribution | Live proof |
| P0.8 | Official deadlines; build/P0.8.md | Baseline | Documentation proof, not live feature | Current vendor checks used for amended flows | None for docs |
| P1.1 | gateway/gateway.ts; zero gateway ratchet | Baseline | C5 fixes auth holds; 77 tests and mutations | C5 implemented/reviewed; observe a held/resumed production row | Deployment |
| P1.2 | Gateway ratchet freshly passes all five channels at zero | Baseline | Not per-operation production proof | Keep ratchet and documented exemptions unchanged | None for local gate |
| P1.3 | outbound-rows.ts; zero external creators; destination column | Baseline | Per-account production attribution not freshly proved | C5 holds implemented in both drains; full gate/production observation pending | Deployment/live proof |
| P1.4 | Connected Shopify GraphQL; build/P1.4.md | Baseline | Connected Shopify preserved; stock round-trip not established | Preserve existing store; no activation as part of this scope | Owner test store/live call |
| P1.5 | Shared eBay marketplace headers; build/P1.5.md | Baseline | Fixture coverage; no new live proof | Retain per-market header regressions | Deployment if changed |
| P1.6 | Approved groups removed; build/P1.6-delete-list.md | Baseline | Remaining live dependencies retained | Do not equate zero traffic with unneeded fallback | New deletions separately |
| P1.7 | Preview and ended-listing guards; build/P1.7.md | Baseline | Historical fixtures; partial flat-file cap amendment | Keep approved 200-row preview policy and guard mutations | Live proof |
| P1.8 | contract/channel-contracts.ts has only four checks | Baseline | Switch historically on; accounts absent; coverage partial | Add supported contract coverage/partial state; configure test accounts | Test accounts + channel calls |
| P2.1 | ingress/ledger.ts + inbound-retry.job.ts; C1 38 tests/2 killed mutations | C1 local | Baseline replay accepts unverified records | Deploy verified replay guard; complete eBay durable processing | Deployment |
| P2.2 | Amazon per-type subscriptions and parsing; build/P2.2.md | Baseline | New types gated; every type arrival not proven | Actual subscription inventory and per-type real arrivals | Live calls/subscriptions |
| P2.3 | eBay notifications.ts/routes/handlers independently audited | Baseline + local prior fixes | Zero destinations/subscriptions at prior read; no genuine events | C3 transport/status fixed; C8 readiness/explicit activation hold (83 tests); durable processors/account-token scope and delivery still open | Live catalogue then subscription approval |
| P2.4 | Shopify reconciliation/lifecycle; build/P2.4.md | Baseline | Store connected; no fresh uninstall/privacy proof | Preserve connection and regression coverage | Any test uninstall/write |
| P2.5 | Etsy receiver/receipts; C2 contract/routing: 35 focused + 5 real PostgreSQL tests | C2 local | Motovento connected; portal zero endpoints; zero local listings/events | Finish transactional ingest/poll; deploy alias; register 4 actual events | Registration/live call; stock opening boundary |
| P2.6 | account-lifecycle.service.ts; revocation code exists | Baseline | eBay real revocation handler currently unreachable | Awaited scoped lifecycle dispatch; real signal proof | Live event |
| P2.7 | AMS dedupe and subscription check; build/P2.7.md | Baseline | Every live profile hourly arrival not freshly proved | Per-profile dataset/read controls | Live read if needed |
| P2.8 | Ingress DS tab + retry/replay; build/P2.8.md | Baseline + C1 local | Tab deployed, unverified replay flaw corrected locally | Browser keyboard/responsive verification after changes | Deployment |
| P3.1 | Gateway error vocabulary; build/P3.1.md real/shape fixtures | Baseline | No new outgoing call measured | Preserve channel codes/messages and fixture distinctions | None local |
| P3.2 | ListingIssue recorders and suppression job; build/P3.2.md | Baseline | Suppression pull defaults off; one-minute live rejection proof missing | Verify switch, listing attribution and rejected-change timing | Production enablement/live call |
| P3.3 | cx/account-calls.service.ts; studio syncQueue.ts says ListingIssue dormant | Baseline partial | Diagnostics exists; studio rejection pane not built | Finish shared listing-error presentation with studio boundary respected | Deployment |
| P3.4 | Channel owner Notification path; build/P3.4.md | Baseline partial | C7 owner notifications implemented locally (56 tests) | Deploy and observe owner delivery/dedupe | Deployment |
| P3.5 | Success-response deprecation headers; build/P3.5.md | Baseline | Synthetic header proof; no real deprecation observed | Fixture is valid local acceptance; retain production observation distinction | Observation |
| P3.6 | Channel health/trace service; build/P3.6.md | Baseline | No-data is not green; positive operational SLO evidence incomplete | Read current per-operation counts, latency/backlog/DLQ targets | Production observation |
| P4.1 | Per-channel publish lanes; build/P4.1.md | Baseline | Per-operation live publication proof incomplete | Keep previews, account policy and Presence boundaries | Live publish approval |
| P4.2 | Image gateway/readback; build/P4.2.md | Baseline | Sweep historically on; positive-count proof required | Read current sweep counts/issues, preserve channels out of scope | Observation/live calls |
| P4.3 | Quantity resolver, routed clamp, EU fail-closed, inbound stock removal | Baseline | Etsy order stock policy needs explicit choice | Safe transactional Etsy effects; test duplicate/cancel races | Stock timing/opening boundary |
| P4.4 | Currency/bounds; price-readback.service.ts | Baseline partial | eBay price readback is missing | Implement scoped eBay price confirmation; no automatic price healing | Live read proof |
| P4.5 | Regional Ads discovery/disconnect/expiry; build/P4.5a-h.md | Baseline partial | No reconnect needed; Manual Collection wire value unresolved | Verify daily region repair and accepted SB contract | No reconnect; live probe only approved |
| P4.6 | Etsy writers/freshness; build/P4.6a-f.md | Baseline partial | Mode unknown; Motovento zero stored listings | Correct full freshness accounting and demonstrate supported writes | First write/mode approval |
| P5.1 | Orders 2026 adapter + quantity-4 live money proof; build/P5.1.md | Baseline | Enablement still gated | Set switch only approved; production quantities/totals/pagination verify | Production config approval |
| P5.2 | amazon-financial-events.service.ts independently audited | C4 local safety amendment | v0 default; C4 corrects dry run and holds unsafe new writes (87 tests) | Approved overlap read, money mapping, null account attribution, safe reconciliation and race proof | Approved corrected dry run, then cutover |
| P5.3 | One Shopify version accessor; build/P5.3.md | Baseline | 2026-07 historical traffic; preserve connected store | Quarterly version maintenance remains operational | None current scope |
| P5.4 | No buyer-PII/RDT path; build/P5.4.md | Baseline | Historical 4,464 order census; privacy ratchet | Keep data-minimization choice; no RDT invented | None |
| P5.5 | Search Returns not on official decommission list | Not required | Supported read retained | No speculative replacement | None |
| P6.1 | cx/amazon-secret-rotation.service.ts | Baseline partial | C7 strict static policy and owner delivery proved locally | Effective IAM/portal setup, recoverable rotation and end-to-end test remain | Queue registration + live rotation |
| P6.2 | Signing-key expiry parsing; build/P6.2b.md | Baseline | eBay expiry 2029-08-28 historical live proof | Fresh heartbeat/expiry read; no rotation needed now | Read/observation |
| P6.3 | Rotated Etsy token persistence; build/P6.3.md | Baseline | Connected Motovento heartbeat proves token path only | Retain persistence retry/race guards; inspect failures | Observation |
| P6.4 | Local revoke/channel removal hint; build/P6.4.md | Baseline | No destructive production revoke requested | Preserve honest per-channel outcomes | Any disconnect separately |
| P6.5 | Owned-only heartbeat; build/P6.5.md | Baseline | Guest-account write isolation fixture evidence | Real DB RLS coverage, owner/guest runtime evidence | Observation |
| P6.6 | Private authorization/import; env fallback instrumentation | Baseline | Only ~32-minute prior zero, not one full day | Observe full cron cycle; retire env fallback after evidence | Production switch approval |
| P6.7 | Post-Order auth documented; no extra scopes required | Resolved amendment | No reconnect required | Optional actual keyset portal confirmation | Portal read |
| P6.8 | OAuth callbacks/apps; actual Etsy and Shopify connections read | Baseline + local origin fixes | Etsy Motovento + Shopify Xavia connected | Verify callback URLs/webhook mode separately | Portal changes separately |
| P7a | Dependency census; channel-sync inert worker and producer remain | Partial | No deletion authorized by continuation | Justified code removal list; retain live Ads fallback | Explicit deletion boundary |
| P7b | Schema dependency inventory | Not started | Green week not elapsed/proven | Each table requires dependency retirement + green week + individual approval | One yes per drop |
| P8 | New channels | Deferred | Explicitly out of scope | Preserve connected Shopify; no new channel work | New scope decision |
| CX cleanup | 4abb1a371 guarded deletion; prior 59 tests/101 PostgreSQL gate | Local only | Exact ten proposed rows untouched | Deploy reviewed package; fresh exact-ID check before any deletion | Deployment and exact-ten separate |

## Measurable quality obligations (no blanket AAA pass claimed)

| Dimension | Acceptance threshold | Current proof / unresolved evidence |
|---|---|---|
| Correctness | Exact money/currency/quantity semantics; zero duplicate financial effects; no quiet partial reads | C4 correct identifiers, rejects partial pagination, performs zero money writes. Monetary reconciliation/cutover still open. |
| Account isolation | Every write and inbound action names exactly one owner; foreign/missing/ambiguous identity causes zero effects | C2 five real PostgreSQL routing tests including alias collisions; finance account binding mutation killed; C7 owner-profile notification isolation proved. eBay processors and Etsy ingest remain. |
| Security | Invalid/missing verification executes zero handlers; credentials never in diagnostics; no auth bypass | C1 38 tests/two killed mutations; existing boolean-only credential report retained. KMS/Neon rotation still Owner dependencies. |
| Resilience | Failed work remains recoverable; sign-in/rate holds spend zero row retries; no premature SUCCESS | C3 real CronRun recorder tests; C5 77 tests and native Shopify resume proof. eBay durable replay remains. |
| Performance | Bounded traversal/work, account concurrency preserved; measure real latency/backlog against P3.6 targets | Notification reads max20 pages/collection, finances max50 pages, retry drain max200 rows. No production p95/positive-load claim yet. |
| Accessibility | Existing DS controls; keyboard-only critical paths, responsive 390/1280 widths, light/dark; no serious/critical accessible-name/focus violations | No UI changes in C1–C8. Existing Ingress/Diagnostics production usability and unfinished studio errors still need runtime verification. |
| Observability | Failed/rejected/unknown events remain visible; complete=true/healthy only with positive evidence; owning-profile alerts | C1 rejects remain in ledger; C3 failed cron persists FAILED; empty/partial compare explicit. C7 persists rotation owner alerts; production delivery still unobserved. |
| Maintainability | Named slice commits, independent review, typecheck, canonical ratchets, no new suppressions/skips/weakened hooks | C1–C8 reviewed; final full API11215passed/137skipped/zero errors. Final canonical passed both builds,4591web,124security,106realPG/zero skips,RBAC2724/0unmapped. Profiles ratchet41known failing/217tests,none new/worse; one fixed exception removed. |

P7's green week and each destructive-drop approval remain mandatory. No production
row, token, subscription, publishing mode, or deployment has been changed.
