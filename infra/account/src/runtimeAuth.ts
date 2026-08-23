import { Pool } from "pg";

import { makeAccountAuth } from "./auth.ts";
import { loadAccountConfiguration } from "./config.ts";

// Defense in depth in addition to telemetry.enabled=false in the auth options.
process.env.BETTER_AUTH_TELEMETRY = "0";

// The migration CLI imports this same runtime definition, preventing schema
// drift between generated SQL and the deployed account service.
const configuration = loadAccountConfiguration();

export const accountDatabase = new Pool({
  connectionString: configuration.databaseUrl,
  application_name: "t3-sovereign-account",
  max: 10,
});

export const auth = makeAccountAuth(configuration, accountDatabase);
