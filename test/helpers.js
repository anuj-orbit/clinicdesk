import { createApp } from "../src/app.js";
import { buildRepos } from "../src/repos.js";
import { loadConfig } from "../src/config.js";
import { newToken, hashToken } from "../src/auth/session.js";

/** Memory repos only (never Postgres/Mongo), optionally merged with overrides. */
export function memoryRepos() {
  return buildRepos({ pool: null, getMongoDb: null });
}

/**
 * Starts the app on an ephemeral port.
 * Returns { url, repos, close }.
 */
export async function startApp({ repos, config } = {}) {
  const base = memoryRepos();
  const finalRepos = repos ? { ...base, ...repos } : base;
  const app = createApp({ repos: finalRepos, config: config ?? loadConfig() });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    repos: finalRepos,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A cookie-jar HTTP client. Every request sends content-type: application/json.
 * Each method resolves to { status, body, headers }.
 */
export function client(url, initialCookies = {}) {
  const jar = new Map(Object.entries(initialCookies));

  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async function request(method, path, body) {
    const headers = { "content-type": "application/json" };
    const cookie = cookieHeader();
    if (cookie) headers.cookie = cookie;

    const res = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie")]
          : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1);
        jar.set(name, value);
      }
    }

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    return { status: res.status, body: parsed, headers: res.headers };
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    put: (path, body) => request("PUT", path, body ?? {}),
    del: (path) => request("DELETE", path),
    setCookie: (name, value) => jar.set(name, value),
    getCookie: (name) => jar.get(name),
  };
}

/** Inserts a user directly through the repo. */
export async function createUser(repos, { role = "patient", email, name, passwordHash, specialty = null } = {}) {
  const unique = email ?? `${role}-${Math.random().toString(36).slice(2, 10)}@clinic.test`;
  return repos.users.create({
    email: unique,
    passwordHash: passwordHash ?? "scrypt$deadbeef$deadbeef",
    name: name ?? `Test ${role}`,
    role,
    specialty,
  });
}

/**
 * Inserts a session directly through repos.sessions and returns a client that
 * already holds the sid cookie. Lets Areas B/C test without Area A's login route.
 */
export async function loginAs(repos, url, user) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await repos.sessions.create({ tokenHash: hashToken(token), userId: user.id, expiresAt });
  return client(url, { sid: token });
}
