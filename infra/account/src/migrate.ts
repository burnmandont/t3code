import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.T3_ACCOUNT_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("T3_ACCOUNT_DATABASE_URL is required.");

const migrationsFolder = process.env.T3_ACCOUNT_MIGRATIONS_FOLDER ?? "/app/drizzle/account";
const pool = new Pool({ connectionString: databaseUrl, max: 2 });

try {
  await migrate(drizzle(pool), { migrationsFolder });
} finally {
  await pool.end();
}
