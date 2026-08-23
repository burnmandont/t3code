import { Pool } from "pg";

import { T3_RELAY_SCOPE } from "./auth.ts";
import { loadPublicClientProvisioningConfiguration } from "./clientProvisioning.ts";

const databaseUrl = process.env.T3_ACCOUNT_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("T3_ACCOUNT_DATABASE_URL is required.");

const client = loadPublicClientProvisioningConfiguration();
const pool = new Pool({ connectionString: databaseUrl, max: 2 });

try {
  await pool.query(
    `INSERT INTO oauth_client (
      id, client_id, client_secret, disabled, skip_consent, enable_end_session,
      subject_type, scopes, name, redirect_uris, post_logout_redirect_uris,
      token_endpoint_auth_method, grant_types, response_types, public, require_pkce,
      created_at, updated_at
    ) VALUES (
      $1, $1, NULL, FALSE, $2, TRUE,
      'public', $3, $4, $5, $6,
      'none', $7, $8, TRUE, TRUE,
      now(), now()
    )
    ON CONFLICT (client_id) DO UPDATE SET
      disabled = FALSE,
      skip_consent = EXCLUDED.skip_consent,
      enable_end_session = TRUE,
      subject_type = 'public',
      scopes = EXCLUDED.scopes,
      name = EXCLUDED.name,
      redirect_uris = EXCLUDED.redirect_uris,
      post_logout_redirect_uris = EXCLUDED.post_logout_redirect_uris,
      token_endpoint_auth_method = 'none',
      grant_types = EXCLUDED.grant_types,
      response_types = EXCLUDED.response_types,
      public = TRUE,
      require_pkce = TRUE,
      updated_at = now()`,
    [
      client.clientId,
      client.skipConsent,
      ["openid", "profile", "email", "offline_access", T3_RELAY_SCOPE],
      client.name,
      client.redirectUris,
      client.postLogoutRedirectUris,
      ["authorization_code", "refresh_token"],
      ["code"],
    ],
  );
  process.stdout.write(
    `Provisioned public PKCE client '${client.clientId}' with ${client.redirectUris.length} redirect URI(s).\n`,
  );
} finally {
  await pool.end();
}
