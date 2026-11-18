import pg from "pg";
import path from "path";
import { readFileSync } from "fs";
import { readdir } from "fs/promises";

export async function migrate(pool, { dir } = {}) {
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(727001)");

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    const migrationsDir = dir || path.join(path.dirname(new URL(import.meta.url).pathname), "migrations");
    let files;
    try {
      files = await readdir(migrationsDir);
    } catch {
      files = [];
    }

    const sqlFiles = files
      .filter(f => f.endsWith(".sql") && !f.startsWith("_") && f !== ".DS_Store")
      .sort();

    const applied = [];

    for (const file of sqlFiles) {
      const name = file;
      const already = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [name]
      );
      if (already.rows.length > 0) {
        console.log(`Migration ${name} already applied`);
        continue;
      }

      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [name]
        );
        await client.query("COMMIT");
        applied.push(name);
        console.log(`Applied migration ${name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Failed to apply migration ${name}: ${err.message}`);
      }
    }

    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)");
    client.release();
  }
}