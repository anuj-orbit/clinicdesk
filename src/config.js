function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env = process.env) {
  const sessionTtlHours = positiveNumber(env.SESSION_TTL_HOURS, 168);
  const cookieSecure = String(env.COOKIE_SECURE ?? "").toLowerCase() === "true";
  let clinicOffsetMinutes = Number(env.CLINIC_UTC_OFFSET_MINUTES ?? 0);
  if (!Number.isInteger(clinicOffsetMinutes) || clinicOffsetMinutes % 30 !== 0 || Math.abs(clinicOffsetMinutes) > 14 * 60) {
    throw new Error("CLINIC_UTC_OFFSET_MINUTES must be an integer multiple of 30 between -840 and 840");
  }
  clinicOffsetMinutes = clinicOffsetMinutes || 0; // normalise -0
  const adminEmail = env.ADMIN_EMAIL || undefined;
  const adminPassword = env.ADMIN_PASSWORD || undefined;

  return { sessionTtlHours, cookieSecure, clinicOffsetMinutes, adminEmail, adminPassword };
}
