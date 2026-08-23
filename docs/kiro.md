# Kiro

Kiro is a native provider backed by the Kiro API (`kiro-api`). It is built into OMP rather than supplied by an extension. Do not enable the legacy `omp-provider-kiro` extension alongside the native provider: the native `kiro` provider and `kiro-api` transport reject shadow registrations.

For general credential precedence and provider configuration, see [Providers](./providers.md).

## Quick start

1. Run `/login kiro`.
2. Choose **AWS** for an IAM Identity Center subscription or **API** for a `ksk_...` API key.
3. After authentication, choose a `kiro/<model-id>` model from the discovered catalog.

Kiro login uses replacement semantics. Logging in again replaces the stored Kiro credential with the newly selected AWS profile or API key.

## AWS IAM Identity Center device login

Choose **AWS** in the Kiro login method selector. OMP asks for:

- **Start URL** — the AWS access portal URL, for example `https://company.awsapps.com/start`.
- **OIDC region** — the AWS IAM Identity Center/OIDC region for that portal.

The Start URL must be an HTTPS `*.awsapps.com/start` URL without a port, query string, fragment, username, or password. The region must be a valid AWS region.

OMP registers a public Kiro client for the selected OIDC region, requests a device code, displays the verification URL and one-time user code, and waits for browser approval. When more than one Kiro profile is available, the login dialog presents a profile selector. The terminal shows a profile name or a region-based fallback, never the full profile ARN or AWS account number.

The selected profile determines the Kiro runtime route. Its profile identity, registered client metadata, and validated token endpoint are stored with the OAuth credential. If a registration response omits `tokenEndpoint` or returns it as `null`, OMP uses and persists the validated canonical regional endpoint `https://oidc.<region>.amazonaws.com/token`; a returned non-null endpoint is preserved only after the same validation.

OMP caches the validated Start URL, OIDC region, and registered public client locally. Cached registrations are scoped to their region, expire with the registered client, and are repaired with the canonical token endpoint when an older cache entry omitted that field or stored `null`.

## Kiro API-key login

Choose **API** and paste the Kiro API key. Keys must use the `ksk_...` format; surrounding quotes and control characters are removed before validation. OMP validates the key against the Kiro model-management route and stores the resolved runtime endpoint with the key.

Set `KIRO_API_REGION` when the key's AWS region is known:

```sh
export KIRO_API_KEY=ksk_...
export KIRO_API_REGION=us-east-1
```

`KIRO_API_KEY` is the environment fallback for the provider. `KIRO_API_REGION` is optional when validation resolves exactly one safe route; set it when route discovery is ambiguous or when the key is tied to a non-bootstrap region.

## Profile selection and model discovery

Model discovery is credential-scoped:

- AWS OAuth discovery uses the selected profile and its runtime region.
- API-key discovery uses the key's resolved runtime endpoint.
- Cached models are restored only after the selected Kiro credential is known.

Kiro has no fabricated default model. Select an explicit `kiro/<model-id>` after online discovery. A cache entry for one profile, API key, or endpoint is not reused for another. If models disappear after switching accounts, log in again and allow discovery to complete.

## Builder

The **Builder** option is shown as an explicit placeholder for a future Builder ID flow. It reports that Builder ID login is not available, stores no credential, and does not report a successful login. Choose AWS or API instead.

## Logout and re-login

Use `/logout` and select Kiro. Logging out removes the stored Kiro credential; it does not remove an environment-provided `KIRO_API_KEY` or another configured credential source.

Run `/login kiro` again when:

- the registered client or OAuth refresh state has expired;
- the AWS profile, Start URL, or OIDC region has changed;
- model discovery is using the wrong profile or endpoint; or
- a present registration endpoint fails validation.

## Troubleshooting

### `Invalid AWS access portal URL`

Use the Start URL copied from IAM Identity Center. It must be an HTTPS `*.awsapps.com/start` URL with no query, fragment, port, username, or password.

### `Kiro API key did not resolve to exactly one route`

Set `KIRO_API_REGION` to the region that issued the key, then run `/login kiro` again and choose API. A region is also required when the key is valid in a route that cannot be discovered from the bootstrap probes.

### `Kiro response has an invalid tokenEndpoint`

A present registration endpoint must be the HTTPS regional AWS OIDC token endpoint with no query, fragment, port, or credentials. OMP uses the canonical regional endpoint only when the registration response omits the property. Re-run `/login kiro` after correcting a stale or invalid cached registration.

### No Kiro models after login

Confirm that the selected model is under the `kiro` provider, wait for online discovery, and verify that the selected AWS profile or API-key region is correct. Log in again after changing profiles or regions.

### Builder login appears to do nothing

Builder ID is intentionally deferred. No credential is stored and no model refresh is triggered. Select AWS or API until Builder support is implemented.
