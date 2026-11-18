import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./helpers.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

// Required element ids per PLAN.md section 3.4, plus the shared page shell.
const PAGES = {
  "/": ["login-form", "register-form"],
  "/index.html": ["login-form", "register-form"],
  "/patient.html": ["doctor-select", "from-date", "slots", "my-bookings"],
  "/doctor.html": ["availability-list", "availability-form", "doctor-bookings"],
  "/admin.html": [
    "all-bookings",
    "filter-status",
    "filter-doctor",
    "audit-log",
    "filter-booking-id",
    "doctor-form",
  ],
};

// Every page has the shared shell elements.
const SHARED_IDS = ["status", "user-name", "logout-btn"];

function listPublicJs() {
  const jsDir = path.join(PUBLIC_DIR, "js");
  if (!fs.existsSync(jsDir)) return [];
  return fs
    .readdirSync(jsDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => `/js/${f}`);
}

test("pages return 200 text/html with required ids and aria-live", async () => {
  const { url, close } = await startApp();

  for (const [route, ids] of Object.entries(PAGES)) {
    const res = await fetch(`${url}${route}`);
    assert.equal(res.status, 200, route);
    assert.match(res.headers.get("content-type") || "", /text\/html/, route);
    const html = await res.text();

    for (const id of [...ids, ...SHARED_IDS]) {
      assert.ok(
        new RegExp(`id=["']${id}["']`).test(html),
        `${route} must contain #${id}`,
      );
    }
    assert.match(html, /aria-live/, `${route} must have an aria-live region`);
  }

  await close();
});

test("every public/js file and css/app.css returns 200", async () => {
  const { url, close } = await startApp();

  const assets = [...listPublicJs(), "/css/app.css"];
  for (const asset of assets) {
    const res = await fetch(`${url}${asset}`);
    assert.equal(res.status, 200, asset);
  }

  await close();
});

test("no page references http:// or https://", async () => {
  const { url, close } = await startApp();

  for (const route of Object.keys(PAGES)) {
    const res = await fetch(`${url}${route}`);
    const html = await res.text();
    assert.ok(!/https?:\/\//.test(html), `${route} must not reference an absolute URL`);
  }

  await close();
});

test("no public/js file assigns innerHTML", () => {
  const jsDir = path.join(PUBLIC_DIR, "js");
  if (!fs.existsSync(jsDir)) return;
  for (const file of fs.readdirSync(jsDir).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(jsDir, file), "utf8");
    assert.ok(!/innerHTML\s*=/.test(src), `${file} must not assign innerHTML`);
  }
});