import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import dotenv from "dotenv";
import { Pool } from "pg";
import { resolveDbSsl } from "../lib/db-ssl";

const envCandidates = [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "..", "..", ".env"),
];
for (const envPath of envCandidates) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const url =
  process.env.AUTH_DATABASE_URL ??
  process.env.APP_WRITE_DATABASE_URL;
if (!url) {
  throw new Error(
    "AUTH_DATABASE_URL or APP_WRITE_DATABASE_URL is required to setup Auth.js tables.",
  );
}

const schemaPath = resolve(process.cwd(), "src", "db", "schema.auth.sql");
if (!existsSync(schemaPath)) {
  throw new Error(`Missing auth schema file: ${schemaPath}`);
}
const schemaSql = readFileSync(schemaPath, "utf-8");

const run = async () => {
  const pool = new Pool({
    connectionString: url,
    ssl: resolveDbSsl(url),
  });

  await pool.query(schemaSql);

  const adminEmail = "erknfe@gmail.com";
  await pool.query("INSERT INTO ops_admins (email) VALUES ($1) ON CONFLICT DO NOTHING", [
    adminEmail.toLowerCase(),
  ]);

  await pool.end();
  console.log("Auth.js schema ready. Ops admin seeded:", adminEmail);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
