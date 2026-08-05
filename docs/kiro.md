# Kiro

Kiro is a native provider backed by the Kiro API (`kiro-api`). It supports AWS IAM Identity Center device login and Kiro API-key login. Kiro is not an extension provider: the `kiro` provider and `kiro-api` transport are built into OMP, and the legacy `omp-provider-kiro` extension must not be enabled alongside them.

For the general provider credential precedence and `/login` behavior, see [Providers](./providers.md). For remote credential storage, see [Auth Broker and Auth Gateway](./auth-broker-gateway.md).

## Trust and credential boundaries

OMP's direct Kiro provider is a separate trust boundary: after login or API-key resolution, the selected bearer/key is sent directly to the Kiro AWS management/runtime endpoints required for discovery, inference, and (for OAuth) usage. OMP does not import, synchronize, or read credentials from the Kiro CLI or Kiro IDE. Broker mode changes the storage boundary, not the provider contract: refresh tokens and registered-client secrets stay on the broker, while the client receives only redacted snapshots, status, and the selected identity.

## Quick start

1. Start OMP and run `/login kiro`.
2. Select **AWS** for an IAM Identity Center subscription or **API** for a `ksk_...` API key.
3. Select a `kiro/<model-id>` model after authentication. The model catalog is discovered after the credential is resolved.
4. Use `/usage` to inspect AWS-account quota when using an AWS OAuth credential.

Kiro logins use replacement semantics: a successful Kiro login replaces the existing stored Kiro credential pool. To switch back to a different AWS profile or API key, log in again with the new identity.

## AWS IAM Identity Center device login

Choose **AWS** in the Kiro login method selector. OMP asks for:

- **Start URL** — the AWS access portal URL, for example `https://company.awsapps.com/start`.
- **Region** — the AWS IAM Identity Center/OIDC region for that portal.

The Start URL must be an HTTPS `*.awsapps.com/start` URL without a port, query string, fragment, or embedded credentials. The region must be an AWS-style region identifier.

OMP registers a public Kiro CLI client for the selected OIDC region, requests a device code, opens the verification URL in the browser, and displays the one-time user code. Finish the approval in the browser, then select the Kiro profile when more than one profile is available. Profile labels show the profile name or a region-based fallback; the full profile ARN and AWS account number are not shown in the terminal.

The login stores the selected profile with the OAuth credential. The profile determines the Kiro runtime endpoint and quota scope, so changing profiles changes both model discovery and usage reporting.

### Cached AWS login inputs

After a successful AWS login, OMP caches the validated Start URL and region as convenience defaults. The next `/login kiro` flow pre-fills them, but both prompts can be replaced. The cache is best-effort and is scoped to the local credential store. In broker mode, the broker serves these defaults to the client through its authenticated Kiro login endpoint.

The registered public client is also cached per OIDC region. OMP rejects stale or incompatible cached registrations and re-registers them. A registration whose client secret expires within the safety margin is treated as expired. If the registered client or its refresh state has expired, run `/login kiro` again rather than attempting to repair the stored secret manually.

## Kiro API-key login

Choose **API** and paste the Kiro API key. Keys must use the `ksk_...` format; surrounding quotes and control characters are removed before validation. OMP validates the key by calling the Kiro model-management route and stores the resolved runtime endpoint with the key.

Set `KIRO_API_REGION` when the key's AWS region is known:

```sh
export KIRO_API_KEY=ksk_...
export KIRO_API_REGION=us-east-1
```

`KIRO_API_KEY` is the environment fallback for the provider. It can make Kiro models available without an interactive login, but it does not create an OAuth profile and therefore cannot be used for profile-scoped Kiro usage reporting. `KIRO_API_REGION` is optional when validation can resolve exactly one safe route; set it when route discovery is ambiguous or when the key is tied to a non-bootstrap region.

API-key requests use the configured/resolved Kiro runtime endpoint. If the key is invalid for the selected region, check the region before replacing the key.

## Model discovery and selection

Kiro discovery is credential-scoped:

- AWS OAuth discovery uses the selected profile and its runtime region.
- API-key discovery uses the key's resolved API endpoint.
- Cached models are restored only after the selected Kiro credential is known. A cache entry for one profile or API endpoint is not reused for another.

If Kiro models disappear after switching accounts, log in again and allow discovery to complete. Do not copy a model-cache entry between profiles or endpoints.

## Usage and privacy

`/usage` reports Kiro quotas only for AWS OAuth credentials with a validated profile. The provider's usage endpoint is profile-scoped; API-key credentials return no Kiro usage report when there is no supported profile identity.

Kiro quota rows are represented using the units reported by Kiro (for example, requests or an unknown/credit-like unit), with reset times, warning/exhausted status, and provider-reported overage or bonus notes when available. Provider-supplied labels and notes are sanitized before they reach terminal output or `--json` output. Raw upstream usage payloads are intentionally not retained in usage reports.

The selected profile ARN contains an AWS account identifier. OMP reduces it to the trailing profile segment for usage scopes and account labels; the full ARN and account number are not printed by `/usage`, including JSON output. Use `/usage --redact` when the remaining account/profile labels should be masked as well.

## Auth broker operation

When `OMP_AUTH_BROKER_URL` is configured, the local client uses the remote credential store for Kiro. The interactive client still presents the method selector and AWS Start URL/Region prompts, but the broker performs the AWS device-login orchestration and persists the resulting OAuth credential. The client receives the verification URL and user code, polls the broker for completion, and receives only the stored identity after success.

Configure the broker URL and bearer token as described in [Auth Broker and Auth Gateway](./auth-broker-gateway.md):

```sh
export OMP_AUTH_BROKER_URL=https://broker.example:8765
export OMP_AUTH_BROKER_TOKEN=...
```

The Kiro broker routes are:

- `GET /v1/login/kiro/defaults` — read cached Start URL/region defaults.
- `POST /v1/login/kiro` — start an AWS device-login session and return the verification URL, user code, and expiry.
- `GET /v1/login/kiro/:sessionId` — poll for `pending`, `selection_required`, `complete`, or `error`. A `selection_required` status contains opaque, session-local option IDs; it never contains the real profile ARN or account ID.
- `POST /v1/login/kiro/:sessionId/selection` — submit the selected opaque option ID with its prompt ID, then resume the device flow.
- `DELETE /v1/login/kiro/:sessionId` — cancel an in-progress session.

Refresh tokens, Kiro registered-client IDs/secrets, and other Kiro refresh state remain on the broker. They are redacted from snapshots sent to clients. A broker client cannot use a remote Kiro login for arbitrary providers; the remote login route is intentionally Kiro-specific. `omp auth-broker login kiro` can also be run on the broker host for a local broker-side login.

A broker allows only a bounded number of concurrent Kiro login sessions. If a session expires, is cancelled, or the broker reports that it could not start the flow, run `/login kiro` again.

The broker stores validated Start URL/Region defaults and registered-client metadata in its durable SQLite OAuth cache. They survive client reconnects and broker restarts when the broker database is retained; the client-side cache is not the source of truth.

## Builder, GitHub, and Google login

The **Builder** option is shown as an explicit placeholder for a future Builder ID flow. It currently reports that Builder ID login is not available, saves no credential, and must not display a successful-login message. Choose AWS or API instead.

Native Kiro login does not offer GitHub or Google authentication. Those identities are not accepted as substitutes for AWS IAM Identity Center or a Kiro API key; use the provider-specific login flow for GitHub Copilot or Google providers.

## Logout and re-login

Use `/logout` and select Kiro, or run the broker/local provider logout command appropriate to your deployment. Logging out removes the stored Kiro credential; it does not remove an environment-provided `KIRO_API_KEY` or a model configuration that supplies another credential source.

Run `/login kiro` again when:

- the registered Kiro client or refresh state has expired;
- the AWS profile, Start URL, or region has changed;
- model discovery is using the wrong profile or endpoint; or
- a broker login session was cancelled or timed out.

## Troubleshooting

### `Invalid AWS access portal URL`

Use the Start URL copied from IAM Identity Center. It must be an HTTPS `*.awsapps.com/start` URL with no query, fragment, port, username, or password.

### `Kiro API key did not resolve to exactly one route`

Set `KIRO_API_REGION` to the region that issued the key, then run `/login kiro` again and choose API. A region is also required when the key is valid in a route that cannot be discovered from the bootstrap probes.

### No Kiro models after login

Confirm that the selected model is under the `kiro` provider, wait for online discovery, and verify that the selected AWS profile or API-key region is correct. In broker mode, verify `OMP_AUTH_BROKER_URL` and its token, then re-run `/login kiro` so the remote snapshot is refreshed.

### No usage report

This is expected for an API-key credential. For AWS login, confirm that the credential has a selected profile and that the profile is still valid; then retry `/usage` after re-login if the registered client or OAuth token expired.

### Builder login appears to do nothing

Builder ID is intentionally deferred. No credential is stored and no model refresh is triggered. Select AWS or API until Builder support is implemented.
