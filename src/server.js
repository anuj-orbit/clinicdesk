import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildRepos } from "./repos.js";
import { getPg } from "./db.js";
import { migrate } from "./data/migrate.js";
import { seedAdmin } from "./seed.js";

const port = Number(process.env.PORT) || 3000;

function checkProductionEnv() {
  if (process.env.NODE_ENV !== "production") return;
  const missing = [];
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!process.env.MONGODB_URI) missing.push("MONGODB_URI");
  if (missing.length > 0) {
    console.error(`Missing required environment variables in production: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function main() {
  checkProductionEnv();

  const config = loadConfig();
  const repos = buildRepos();

  if (process.env.DATABASE_URL) {
    await migrate(getPg());
  }

  await seedAdmin(repos, config);

  const app = createApp({ repos, config });
  app.listen(port, "0.0.0.0", () => {
    console.log(`listening on :${port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
