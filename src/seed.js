import { hashPassword } from "./auth/password.js";
import { ConflictError } from "./errors.js";

export async function seedAdmin(repos, config) {
  const adminEmail = config.adminEmail;
  const adminPassword = config.adminPassword;
  
  if (!adminEmail || !adminPassword) {
    return null;
  }
  
  const normalizedEmail = adminEmail.trim().toLowerCase();
  
  // Check if admin already exists
  const existing = await repos.users.findByEmail(normalizedEmail);
  if (existing) {
    console.log("admin exists");
    return null;
  }
  
  // Warn if password is too short
  if (adminPassword.length < 8) {
    console.warn("admin password is shorter than 8 characters");
  }
  
  try {
    const passwordHash = await hashPassword(adminPassword);
    const user = await repos.users.create({
      email: normalizedEmail,
      passwordHash,
      name: "Administrator",
      role: "admin",
      specialty: null,
    });
    console.log("admin seeded");
    return user;
  } catch (err) {
    // Swallow ConflictError from race condition
    if (err instanceof ConflictError) {
      console.log("admin exists");
      return null;
    }
    throw err;
  }
}