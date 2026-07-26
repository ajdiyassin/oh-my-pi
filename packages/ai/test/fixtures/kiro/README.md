# Kiro Phase 0 fixtures

These fixtures are protocol evidence for issue [#4](https://github.com/ajdiyassin/oh-my-pi/issues/4), not a provider implementation. They are intentionally synthetic and identity-free. The official user-facing authentication boundary is documented at <https://kiro.dev/docs/cli/authentication/>; native OMP work must not invoke Kiro CLI or read its credential store.

## Evidence index

The source archive names are recorded for provenance only; their contents are secret-bearing and are not part of this repository:

- `01-builder-id`
- `02-organization`
- `03-google`
- `04-github`
- `05-api-key`
- `05-api-key-2`
- `06-runtime`
- `07-refresh`
- `08-exception`
- `09-image`
- `10-device-flow`
- `10-device-flow-google`
- `22-image-desktop`
- `cli-v3-full` (CLI v3: full login, prompt, thinking, usage; no image input)
- `desktop-ide-full` (desktop/IDE: same full lifecycle, with image input)

Only sanitized metadata, schemas, and independently constructed CRC-valid EventStream frames may be committed. Never copy or quote raw captures, prompts, responses, tool arguments/results, cookies, authorization codes, PKCE verifiers, refresh/access/API keys, email/account/profile identifiers, or machine paths. Use semantic markers such as `<access-token>`, `<profile-arn>`, `<request-id>`, and `<provider-message>`.

## Verified wire surface

- Region-scoped management base: `https://management.<region>.kiro.dev/`.
- Region-scoped runtime base: `https://runtime.<region>.kiro.dev/`.
- Management targets observed/required by the Phase 0 contract: `AmazonCodeWhispererService.ListAvailableProfiles`, `AmazonCodeWhispererService.ListAvailableModels`, `AmazonCodeWhispererService.GetProfile`, and `AmazonCodeWhispererService.GetUsageLimits`.
- `GetUsageLimits` was observed under three transports returning the same response schema: `POST` with `X-Amz-Target: KiroControlPlaneBearerService.GetUsageLimits` (JSON body), `POST` with the legacy `AmazonCodeWhispererService.GetUsageLimits` target (query-param variant), and desktop's `GET /getUsageLimits?origin=…&profileArn=…&resourceType=…`. All require a bearer token and the selected profile. OMP uses the `KiroControlPlaneBearerService` POST so the profile ARN stays out of the query string. The response carries `usageBreakdownList[]` (`resourceType`, `currentUsage`/`usageLimit` plus `*WithPrecision` siblings, `nextDateReset`, `overageCap`/`overageRate`/`overageCharges`, `bonuses[]`, `overageCredits[]`), with `subscriptionInfo`, `overageConfiguration.overageStatus`, and a `userInfo` block that must never be surfaced. `overageCap` varies with the requested `resourceType`, so the scope must be pinned explicitly rather than inherited from a server default.
- Runtime target: `KiroRuntimeService.GenerateAssistantResponse` (confirmed for both text-only and image requests in `22-image-desktop`).
- Runtime request/response transport uses `Content-Type: application/x-amz-json-1.0` and `Accept: application/vnd.amazon.eventstream`. Authenticated requests use a bearer `Authorization` value. The observed/allowed request metadata includes `x-amzn-codewhisperer-optout`, `amz-sdk-invocation-id`, `amz-sdk-request`, and `User-Agent`; do not assume every optional header appears on every flow or add fingerprinting headers.
- Management and runtime requests are separate concerns: API-key discovery validates a bounded management route before inference, while OAuth runtime calls use the selected profile. The API-key runtime request has no `profileArn`; OAuth carries the selected profile in the validated protocol/request shape.

The API-key evidence validates `us-east-1`; the typed `eu-central-1` failure is retained as negative evidence. A valid explicit region takes precedence; absent an explicit region, only the bounded bootstrap management probes may be attempted. Never probe a region with paid inference, and never guess when route validation is ambiguous.

The checked-out `eventstream.json` contains independently constructed frames derived from the sanitized observed event schemas; it does not contain captured response bytes and was not encoded by the production decoder:

- normal sequence: `initial-response`, `reasoningContentEvent`, `assistantResponseEvent`, `contextUsageEvent`;
- metrics sequence: `metadataEvent`, `meteringEvent`, `metricsEvent`;
- synthetic exception sequence: `validationException` with sanitized `REQUEST_BODY_INVALID`, message, and request-id markers.

EventStream frames are binary Amazon EventStream messages. Decode `:message-type` first: normal `event` frames route by `:event-type`; `error`/`exception` frames become typed provider errors using only allowlisted exception/status/request-id fields. The captured `08-exception` evidence is HTTP 400 JSON; the synthetic exception frame proves decoder/error-path handling only and is not represented as captured Kiro behavior.

## Authentication and state

 - Browser OAuth evidence records the PKCE/state/loopback callback contract needed for the OMP-owned browser implementation. The committed fixture is a privacy-safe protocol contract, not proof that OMP has already executed this not-yet-implemented flow. Callback/state mismatch, cancellation, and expiry must fail without persisting credentials.
 - Builder/IDC and social device behavior are distinct. `10-device-flow` and the validated AWS OIDC contract establish a non-loopback device path with registered-client state. A validated device flow satisfies the Phase 0 non-loopback requirement; no separate manual authorization-code flow was proven.
 - Desktop Google/GitHub OAuth is recorded as observed evidence, but it is not a supported OMP login product path and OMP does not implement or offer this flow. Do not infer support for an unobserved flow.
- Successful OAuth profile selection is part of login. Preserve the selected `<profile-arn>` exactly across refresh; refresh state (including any registered-client state proven necessary by the protocol) is broker-owned, redacted, and merged without silently switching profile/account. Re-running login is the profile-switch operation.
- The supported native boundary is OMP-managed browser/manual/device authentication and pasted/environment API keys. Existing Kiro CLI/IDE sessions, databases, sidecars, and caches are deliberately out of scope.

## Runtime semantics

- Tool input represented as strings is a delta fragment and must be concatenated per tool-use ID. Tool input represented as an object is a complete snapshot; retain the newest snapshot and never append repeated serialized snapshots. Interleaved IDs remain independent. A completed empty zero-argument tool normalizes to `{}`; malformed completed input is a typed error, not raw diagnostic output.
- `08-exception` is an HTTP 400 JSON error fixture. It must be classified from status/code/message/request-id metadata and must not be mistaken for an EventStream exception. The EventStream exception fixture is synthetic and exists to exercise frame-level exception handling separately.
- `09-image` remained inconclusive. The later successful `22-image-desktop` capture, corroborated by `desktop-ide-full`, proves current user-message images use `userInputMessage.images[]` with `{ format, source: { bytes: <base64> } }`; JPEG and PNG were both observed. Tool-result image blocks and continuation-id creation remain unproven and fail closed.
- `origin` is client-scoped: `KIRO_CLI` for the CLI surface and `AI_EDITOR` for the desktop/IDE surface. OMP is a CLI and always sends `KIRO_CLI`; the desktop value is recorded as observed evidence, not as an OMP request value.
- Terminal `stopReason` arrives on `metadataEvent`, not on `assistantResponseEvent`; both `cli-v3-full` and `desktop-ide-full` show `assistantResponseEvent` carrying content only. Readers must honor the metadata spelling or every stream degrades to a default stop.
- `meteringEvent` is a billing frame shaped `{ unit, unitPlural, usage }` where `usage` is fractional credits, not tokens. It must be recognized (not treated as unknown) and must never contribute to token usage totals; token metrics come only from the `metricsEvent`/`usage` envelopes.
- Metrics/event fields are additive and may arrive in separate events. Preserve provider-reported input/output/cache/reasoning values; reasoning is a subset of output, and cache values are never estimated. Context usage is metadata/fallback, not a new untyped usage field.

Any future protocol change must first add a sanitized fixture and fail closed on unknown or malformed recognized fields. The fixtures and this guide must remain free of secrets, identity values, raw content, and paths.
