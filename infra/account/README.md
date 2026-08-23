# Sovereign T3 account service

This service replaces the hosted Clerk account boundary with a self-hosted
OAuth 2.1 and OpenID Connect issuer. It is intentionally separate from the T3
environment server and relay:

- Better Auth owns users, sessions, OAuth clients, consent, token state, and
  encrypted Ed25519 signing keys.
- PostgreSQL is the only persistent dependency.
- The relay verifies JWT access tokens locally through the issuer's JWKS.
- T3 clients are public OAuth clients and must use authorization code flow with
  S256 PKCE. They never receive a client secret.
- Anonymous dynamic client registration is disabled. First-party clients are
  provisioned explicitly with the checked script in this package.
- Better Auth telemetry is disabled in configuration and forced off through
  `BETTER_AUTH_TELEMETRY=0` at runtime.

## Configuration

| Variable                                      | Purpose                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `T3_ACCOUNT_BASE_URL`                         | Externally visible origin, for example `https://auth.example.com`.                  |
| `T3_ACCOUNT_BASE_PATH`                        | OAuth/OIDC path prefix; defaults to `/api/auth`.                                    |
| `T3_ACCOUNT_DATABASE_URL`                     | PostgreSQL connection URL for the account database.                                 |
| `T3_ACCOUNT_SECRET`                           | High-entropy Better Auth secret, at least 32 characters.                            |
| `T3_ACCOUNT_RELAY_AUDIENCE`                   | Exact relay API audience placed in JWT access tokens.                               |
| `T3_ACCOUNT_HOST`                             | Listener address; defaults to `127.0.0.1`.                                          |
| `T3_ACCOUNT_PORT`                             | Listener port; defaults to `4200`.                                                  |
| `T3_ACCOUNT_TRUSTED_ORIGINS`                  | Comma-separated browser/mobile origins accepted by auth CSRF and CORS.              |
| `T3_ACCOUNT_ALLOWED_EMAILS`                   | Comma-separated, case-insensitive account-creation allowlist.                       |
| `T3_ACCOUNT_PASSWORD_LOGIN_ENABLED`           | Temporary password bootstrap; defaults to `true`. Disable after enrolling passkeys. |
| `T3_ACCOUNT_CLIENT_ID`                        | Public first-party client ID; defaults to `t3-code`.                                |
| `T3_ACCOUNT_CLIENT_NAME`                      | Display name for the first-party client.                                            |
| `T3_ACCOUNT_CLIENT_REDIRECT_URIS`             | Required comma-separated, exact OAuth callback URLs.                                |
| `T3_ACCOUNT_CLIENT_POST_LOGOUT_REDIRECT_URIS` | Optional exact post-logout URLs.                                                    |
| `T3_ACCOUNT_CLIENT_SKIP_CONSENT`              | Whether the owned first-party client skips consent; defaults to `true`.             |

Use a dedicated database and role. Do not share the relay's database role even
when both databases live in one PostgreSQL cluster.

Account creation is closed when `T3_ACCOUNT_ALLOWED_EMAILS` is empty. The
allowlist applies only to new email/password accounts; existing allowed users
can continue signing in after the variable is narrowed or cleared.

Passkeys are stored in the account PostgreSQL database and use WebAuthn with
required user verification. Keep password login enabled only for initial
bootstrap. Visit `/sign-in` directly, sign in with the bootstrap password,
enroll and test a passkey, then set `T3_ACCOUNT_PASSWORD_LOGIN_ENABLED=false`,
clear `T3_ACCOUNT_ALLOWED_EMAILS`, redeploy, and verify passkey sign-in before
changing the edge source allowlist.

This deployment deliberately uses infrastructure access as the independent
recovery root instead of requiring a second hardware authenticator. Before
public exposure, test the complete break-glass cycle while the account hostname
is still restricted at both Nginx tiers:

1. Verify passkey sign-in with password login disabled and the signup allowlist
   empty.
2. Confirm an unlisted public address cannot reach the account service.
3. Keep `T3_ACCOUNT_ALLOWED_EMAILS` empty, temporarily set
   `T3_ACCOUNT_PASSWORD_LOGIN_ENABLED=true`, and redeploy the control service.
   The allowlist governs account creation, not password sign-in for the existing
   operator account.
4. Verify the known password can sign in. If it cannot, reset only the
   credential password through the private PostgreSQL administrative path.
5. Return `T3_ACCOUNT_PASSWORD_LOGIN_ENABLED=false`, clear the allowlist,
   redeploy, and verify passkey sign-in again.

Restore an exact email to `T3_ACCOUNT_ALLOWED_EMAILS` only when deliberately
creating a replacement account, and only while the account hostname remains
source-restricted. Normal lost-passkey recovery for the existing account does
not require reopening signup.

After public exposure, recovery must first restore the account source allowlist
at both trusted proxy tiers and verify the restriction from an untrusted
network. Never expose a temporarily re-enabled password endpoint to the public.
The sole passkey must not be deleted while password login is disabled.

## Database lifecycle

The Better Auth CLI generates [schema.generated.ts](./src/schema.generated.ts)
from the runtime plugin configuration. Drizzle then derives the checked SQL
migration from that generated schema.

```sh
vp run --filter t3code-account db:schema
vp run --filter t3code-account db:generate
vp run --filter t3code-account db:migrate
```

Run `db:schema` and `db:generate` when Better Auth or its plugin configuration
changes. Review the SQL diff before migration. `db:migrate` is the production
operation and requires `T3_ACCOUNT_DATABASE_URL`.

After migrating, provision or reconcile the public PKCE client:

```sh
vp run --filter t3code-account client:provision
```

The provisioning operation is idempotent. It never creates or stores a client
secret, and it always restores `require_pkce`, the allowed scopes, and the exact
redirect URI list.

## Relay configuration

Given `T3_ACCOUNT_BASE_URL=https://auth.example.com`, configure the sovereign
relay with:

```text
T3_OIDC_ISSUER=https://auth.example.com/api/auth
T3_OIDC_JWKS_URL=https://auth.example.com/api/auth/jwks
T3_OIDC_AUDIENCE=<same value as T3_ACCOUNT_RELAY_AUDIENCE>
T3_OIDC_REQUIRED_SCOPE=t3:relay
```

The issuer metadata is available at both:

- `/api/auth/.well-known/openid-configuration`
- `/.well-known/oauth-authorization-server/api/auth`

## T3 CLI and headless authorization

Configure the CLI bundle or runtime with the sovereign issuer values below.
`T3CODE_OAUTH_RESOURCE` must exactly match both `T3_ACCOUNT_RELAY_AUDIENCE`
and the relay's `T3_OIDC_AUDIENCE`; Better Auth uses the OAuth `resource`
parameter to mint a JWT access token for that audience.

```text
T3CODE_OAUTH_ISSUER=https://auth.example.com/api/auth
T3CODE_OAUTH_CLIENT_ID=t3-code
T3CODE_OAUTH_RESOURCE=urn:t3:relay
T3CODE_HOSTED_APP_URL=https://code.example.com
T3CODE_RELAY_URL=https://relay.example.com
```

Provision these callback URLs on the public client:

```text
http://127.0.0.1:34338/callback
https://code.example.com/connect/callback
https://code.example.com/connect/account/callback
t3code-dev://app/connect/account/callback
t3code://app/connect/account/callback
```

The first supports a browser on the machine running `t3 connect link`. The
second supports SSH/headless machines: the operator opens the self-hosted web
app's `/connect` URL on another device, signs in at the sovereign account
service, and pastes the one-time code back into the terminal. The PKCE verifier
never leaves the CLI process. The third is the interactive browser app's own
PKCE callback. The final two return development and packaged Electron sign-ins
from the system browser to the desktop app. Add `https://code.example.com` to
`T3_ACCOUNT_TRUSTED_ORIGINS` so its token exchange and refresh responses pass
the account service's exact-origin CORS policy.

## Current boundary

The CLI, hosted headless handoff, browser account session, and Electron desktop
can use the sovereign issuer. Electron keeps the refresh credential and PKCE
transaction in an encrypted main-process state file and receives OAuth callbacks
through its registered custom URL scheme. Mobile secure token storage still
requires an integrated client pass. Public TLS and ingress are also deliberately
deferred; production cookies become secure automatically when
`T3_ACCOUNT_BASE_URL` uses HTTPS.
