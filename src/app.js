import express from "express";
import { fileURLToPath } from "node:url";
import { dbStatus } from "./db.js";
import { buildRepos } from "./repos.js";
import { loadConfig } from "./config.js";
import { loadSession } from "./auth/middleware.js";
import { authRouter } from "./routes/auth.js";
import { adminUsersRouter } from "./routes/adminUsers.js";
import { bookingRouter } from "./routes/booking.js";
import { adminRouter } from "./routes/admin.js";
import { errorHandler } from "./errors.js";

export function createApp({ repos = buildRepos(), config = loadConfig() } = {}) {
  const app = express();

  // CSRF hardening: mutating API requests must be JSON. DELETE is exempt.
  app.use((req, res, next) => {
    if (["POST", "PUT", "PATCH"].includes(req.method) && req.path.startsWith("/api")) {
      const contentType = req.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return res.status(415).json({
          error: {
            code: "unsupported_media_type",
            message: "Content-Type must be application/json",
          },
        });
      }
    }
    next();
  });

  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  app.get("/health", async (_req, res) => {
    const db = await dbStatus();
    const healthy = !Object.values(db).includes("error");
    res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", ...db });
  });

  app.use(loadSession({ repos }));

  app.use("/api/auth", authRouter({ repos, config }));
  app.use("/api/admin", adminUsersRouter({ repos, config }));
  app.use("/api/admin", adminRouter({ repos, config }));
  app.use("/api", bookingRouter({ repos, config }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
  });

  app.use(errorHandler);

  return app;
}
