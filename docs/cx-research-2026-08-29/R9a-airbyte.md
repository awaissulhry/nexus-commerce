# Airbyte design-pattern study (delivered inline by the R9 sub-agent before the session-limit cutoff; saved verbatim in condensed form)

Sources: `airbyte_protocol.yaml` (https://raw.githubusercontent.com/airbytehq/airbyte-protocol/main/protocol-models/src/main/resources/airbyte_protocol/v0/airbyte_protocol.yaml), docs.airbyte.com protocol page, `airbyte-python-cdk` (declarative_component_schema.yaml, http.py, core.py, error handlers), source-shopify, source-amazon-seller-partner (manifest), source-amazon-ads, source-bigcommerce (archived), source-woocommerce. Licences: **protocol + python CDK = MIT; platform AND connectors = Elastic License 2.0** (https://docs.airbyte.com/platform/developer-guides/licenses/ — "Airbyte Connectors and everything in our public repos excluding airbyte-protocol are … ELv2"). Study for patterns; do not copy connector code.

## A. Protocol
- Four source verbs: `spec() -> ConnectorSpecification`, `check(Config) -> AirbyteConnectionStatus`, `discover(Config) -> AirbyteCatalog`, `read(Config, ConfiguredAirbyteCatalog, State) -> Stream<Record|State>`; destination `write(...)`. JSON lines over stdin/stdout.
- `AirbyteMessage.type`: RECORD, STATE, LOG, SPEC, CONNECTION_STATUS, CATALOG, TRACE, CONTROL, DESTINATION_CATALOG. **`CONTROL`/`CONNECTOR_CONFIG`** is how a connector pushes a rotated refresh token back to the platform.
- Catalog vs ConfiguredCatalog: stream declares `supported_sync_modes`, `source_defined_cursor`, `default_cursor_field`, `source_defined_primary_key`, `is_resumable`; the platform/user chooses `sync_mode` (full_refresh|incremental), `cursor_field`, `primary_key`, `destination_sync_mode` (append, overwrite, append_dedup, update, soft_delete).
- State: `AirbyteStateMessage.type` GLOBAL | STREAM | LEGACY; `AirbyteStreamState{stream_descriptor, stream_state}`; `sourceStats.recordCount` per checkpoint.
- Trace: ERROR (`failure_type`: system_error | config_error | transient_error), ESTIMATE, STREAM_STATUS (STARTED/RUNNING/COMPLETE/INCOMPLETE), ANALYTICS.
- OAuth (`advanced_auth`): `predicate_key`/`predicate_value` select the oneOf branch; four blobs — `oauth_user_input_from_connector_config_specification` (non-secret per-connection inputs e.g. shop), `complete_oauth_output_specification` (what the token endpoint returns → `path_in_connector_config`), `complete_oauth_server_input_specification` (admin-held client_id/secret), `complete_oauth_server_output_specification` (which server secrets are injected into connector config at runtime). Declarative OAuth adds `consent_url`, `access_token_url`, `scope`, `state{min,max}`. Protocol docs: "authSpecification and advanced_auth will be removed from the protocol" — OAuth is a platform concern.

## B. Declarative (low-code) CDK — `declarative_component_schema.yaml`
- `DeclarativeStream{retriever, incremental_sync, primary_key, schema_loader, transformations, state_migrations}`; `SimpleRetriever{requester, record_selector, paginator, partition_router}`.
- `HttpRequester{url_base, path, http_method, request_parameters/headers/body_json, authenticator, error_handler}`.
- Authenticators: `OAuthAuthenticator{client_id, client_secret, refresh_token, token_refresh_endpoint, grant_type refresh_token|client_credentials, access_token_name, expires_in_name, token_expiry_date(_format), scopes, refresh_token_updater{access_token_config_path, refresh_token_config_path, token_expiry_date_config_path}}` (updater = rotating refresh tokens flow back as CONTROL msgs); `ApiKeyAuthenticator{api_token, inject_into: header|request_parameter|body}`; `BearerAuthenticator`; `SessionTokenAuthenticator{login_requester, session_token_path, expiration_duration}`; `JwtAuthenticator`.
- Pagination: `DefaultPaginator` with `PageIncrement | OffsetIncrement | CursorPagination{cursor_value, stop_condition, page_size}`, `page_token_option: RequestOption | RequestPath`.
- Record selection: `extractor.field_path`, `record_filter.condition`, `AddFields`, `RemoveFields`, `schema_normalization`.
- Incremental: `DatetimeBasedCursor{cursor_field, datetime_format, start_datetime, end_datetime, step (ISO8601), cursor_granularity, lookback_window, start_time_option, end_time_option, partition_field_start/end, is_data_feed, is_client_side_incremental, clamping{DAY|WEEK|MONTH}}`; `IncrementingCountCursor`.
- Partition routers: `SubstreamPartitionRouter{parent_stream_configs[{stream, parent_key, partition_field, incremental_dependency, lazy_read_pointer, extra_fields}]}`, `ListPartitionRouter{values, cursor_field, request_option}`.
- Error handling: default retries 5xx+429 up to 5× exponential. `HttpResponseFilter{http_codes, error_message_contains, predicate, action}`; `action` ∈ SUCCESS, FAIL, RETRY, IGNORE, RESET_PAGINATION, RATE_LIMITED, REFRESH_TOKEN_THEN_RETRY. Backoffs: `ConstantBackoffStrategy{backoff_time_in_seconds, jitter}`, `ExponentialBackoffStrategy{factor=5}`, `WaitTimeFromHeader{header, regex, max_waiting_time_in_seconds}`, `WaitUntilTimeFromHeader{header, min_wait, regex, max_waiting_time}`, `CompositeErrorHandler`.
- Async jobs: `AsyncRetriever{creation_requester, polling_requester, download_requester, status_extractor, status_mapping{running, completed, failed, timeout, skipped}, download_target_extractor, abort_requester, delete_requester, polling_job_timeout}`; orchestrator caps concurrent jobs, `_DEFAULT_MAX_JOB_RETRY = 3`.
- Dynamic streams: `dynamic_streams` + `DynamicSchemaLoader`.

## C. Python CDK HttpStream
- Abstract `url_base`, `path()`, `next_page_token()`, `parse_response()`; overridable `request_params/headers/body_json`; `HttpSubStream` yields `{"parent": record}` slices.
- New retry surface: `get_error_handler() -> ErrorHandler`, `get_backoff_strategy()`, `exit_on_rate_limit`. `HttpStatusErrorHandler(error_mapping, max_retries=5, max_time=600s)`. Default map: 400 FAIL/system, 401/403 FAIL/config_error, 404/405 FAIL/system, 408 RETRY/transient, **429 RATE_LIMITED/transient**, 5xx RETRY/transient.
- `ErrorResolution(response_action, failure_type, error_message)`.
- Checkpointing: `CheckpointMixin.state`, `state_checkpoint_interval` (emit STATE every N records), `is_resumable`; readers: CursorBased / ResumableFullRefresh (pagination-token checkpoint) / Incremental / FullRefresh.
- `HttpAvailabilityStrategy.check_availability` = read the first record of the first slice; zero records still "available".
- Concurrent source: thread pool + bounded `Queue(maxsize=10_000)`, partition generators < workers (back-pressure).

## D. Commerce connectors
- **source-shopify** (certified, api_version `2025-10`, limit 250): spec `shop` + credentials oneOf (oauth2.0 {client_id, client_secret, access_token} | api_password); `advanced_auth` output `shop`, `access_token` (offline token, no refresh). Header `X-Shopify-Access-Token`. REST incremental streams on `updated_at` with `state_checkpoint_interval=250`, `lookback_window_in_days`; GraphQL **Bulk** streams (Products, ProductVariants, InventoryItems/Levels, Collections, Metafield*, FulfillmentOrders, DiscountCodes…): `bulkOperationRunQuery` with `updated_at:>=… AND updated_at:<=…` filter, poll `node(id){... on BulkOperation{status errorCode objectCount fileSize url partialDataUrl}}`, stream JSONL to disk in 10 MB chunks, re-nest via `__parentId`; **cancel-to-checkpoint** after `job_checkpoint_interval` records using `partialDataUrl`; **adaptive window** (halve on `job_termination_threshold` timeout, EMA-expand on success, floor 0.1 day); concurrency guard on `BULK_OPERATION_RUNNING` (wait 30 s × up to 120); rate limiting from `X-Shopify-Shop-Api-Call-Limit` (`current/max`, threshold 0.9 → sleep tiers 0/0.2/1.5/5 s) and GraphQL `extensions.cost.throttleStatus`; `ShopifyNonRetryableErrors` 401/402/403/404 → config_error; streams filtered by granted `ShopifyScopes`; `continue_sync_on_stream_failure = True`. 49 streams.
- **source-amazon-seller-partner** (manifest-only since 2025-01): spec `aws_environment`, `region` (23 codes), `account_type` Seller|Vendor, `lwa_app_id`, `lwa_client_secret`, `refresh_token`, `replication_start_date` (≤730 d), `period_in_days` 90, `report_options_list`, `max_done_report_age_hours`, `creation_requester_429_max_retries`; **no AWS SigV4** (LWA only). Reports = `AsyncRetriever`: POST `reports/2021-06-30/reports {reportType, marketplaceIds, dataStartTime, dataEndTime, reportOptions}` → poll `processingStatus` (running IN_QUEUE/IN_PROGRESS; completed DONE; failed FATAL/CANCELLED) → `reportDocumentId` → GET document → url; decoders GzipCsv/GzipXml/GzipJson. 429 backoff = `1 / x-amzn-RateLimit-Limit`. Custom: `AmazonSPOauthAuthenticator` (adds `x-amz-access-token`, invalidates on 403 "token expired"), **`AmazonSPRdtAuthenticator`** (POST `/tokens/2021-03-01/restrictedDataToken {restrictedResources:[{method, path, dataElements:[buyerInfo, shippingAddress]}]}`, cached ~50 min), **`ReportCreationRequester`** reuses a DONE report younger than `max_done_report_age_hours` or an in-flight one. 48+ report types incl. GET_MERCHANT_LISTINGS_ALL_DATA, GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL, GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE, GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA, GET_LEDGER_DETAIL_VIEW_DATA, GET_SALES_AND_TRAFFIC_REPORT, GET_BRAND_ANALYTICS_*; 58 streams in docs.
- **source-amazon-ads** (certified, manifest-only 9.1.1): OAuth2 refresh at api.amazon.com/auth/o2/token, region NA/EU/FE, **profiles as partition** via `Amazon-Advertising-API-Scope` header; 53 streams (30 simple + 27 async report streams, `max_concurrent_async_job_count` 10).
- **source-woocommerce** (certified): Basic auth consumer key/secret, `wp-json/wc/v3`, 21 streams, cursor `date_modified_gmt`, P30D step.
- **source-bigcommerce**: archived; `X-Auth-Token` api key, `store_hash` in URL, PageIncrement 250, cursor `date_modified`.
- **No** source-ebay, source-etsy, source-zalando, source-magento (archived) in the monorepo.

## Patterns worth re-implementing (pattern · why · complexity)
1. spec/check/discover/read as four verbs + JSON-Schema config + per-stream schema · one contract for every source · M
2. Catalog vs ConfiguredCatalog (source proposes cursor/pk, operator chooses) · S
3. Per-stream STATE `{stream_descriptor, stream_state}` checkpointed every N records · resumable, per-stream reset · S
4. `ErrorResolution{action, failure_type, message}` + status map + RATE_LIMITED as its own action · config_error vs transient bubbles to the operator honestly · S
5. Composable backoff strategies (WaitTimeFromHeader for `x-amzn-RateLimit-Limit`, WaitUntilTimeFromHeader, exponential, `max_waiting_time` → give up) · S
6. `DatetimeBasedCursor` windowed slices with step/granularity/lookback/clamping · M
7. `SubstreamPartitionRouter` with `incremental_dependency` · orders→refunds, products→variants, profiles→campaigns · M
8. `AsyncRetriever` create/poll/download + status_mapping + job cap + retries + timeout · SP-API reports, Ads reports, Shopify bulk · L
9. Shopify bulk: adaptive window, cancel-to-checkpoint, `__parentId` re-nesting · L
10. `ReportCreationRequester` reuse of a recent DONE report · avoids burning quota · S
11. RDT authenticator layered over LWA · S
12. `advanced_auth` four-blob split (user input / oauth output / server input / server output) + CONTROL message for rotated refresh tokens · M
13. `HttpAvailabilityStrategy` = read first record, classify failure; filter streams by granted scopes · S
14. `continue_sync_on_stream_failure` + explicit STREAM_STATUS · S
15. Concurrent partition reader with bounded queue back-pressure · M

## What Airbyte loses / anti-patterns
- Record-only, read-only protocol: no "action" verb (create order, update price) — writes are whole-stream destinations, no per-call result or idempotency key.
- Per-stream state, no cross-stream transaction (orders vs items checkpoint separately).
- JSON-Schema config UI ceiling: no live lookups (e.g. pick a Shopify location).
- OAuth lives outside the protocol; self-hosted must bring own client id/secret.
- Connector-as-container: a Docker process per sync, JSON lines over stdout — impossible in a request path ("refresh one SKU").
- Report streams block inside `read` (poll in-process, no come-back-later).
- Silent semantics drift (`reportOptions` accepted for every report, sent for two; no-op deprecated params kept in spec).
- Schema is discover-once; metafields/localised CSV headers need hand-written transformers.
- Licence trap: connectors ELv2.
- Two coexisting retry APIs; re-implement only the new one.
- Archived commerce coverage: BigCommerce/Magento archived; eBay/Etsy/Zalando absent.
