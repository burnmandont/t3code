import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.T3_RELAY_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("T3_RELAY_DATABASE_URL is required.");

const migrationsFolder = process.env.T3_RELAY_MIGRATIONS_FOLDER ?? "/app/drizzle/relay";
const pool = new Pool({ connectionString: databaseUrl, max: 2 });

try {
  await migrate(drizzle({ client: pool }), { migrationsFolder });
} finally {
  await pool.end();
}
