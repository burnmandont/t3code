import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.T3_RELAY_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("T3_RELAY_DATABASE_URL is required for relay database commands.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/persistence/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
});
