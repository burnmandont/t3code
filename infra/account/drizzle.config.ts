import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.T3_ACCOUNT_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("T3_ACCOUNT_DATABASE_URL is required for account database commands.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.generated.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
});
