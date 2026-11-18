import express from "express";
import crypto from "node:crypto";
import { ValidationError, AuthError, ConflictError } from "../errors.js";
import { wrap } from "../errors.js";
import { hashToken, sessionCookie, clearSessionCookie } from "../auth/session.js";
import { hashPassword, verifyPassword, DUMMY_HASH } from "../auth/password.js";

export function authRouter({ repos, config }) {
  const router = express.Router();
  const ttlHours = config.sessionTtlHours ?? 168;

  // Registration route
  router.post("/register", wrap(async (req, res) => {
    const { email, password, name } = req.body;
    
    // Validate email
    if (typeof email !== "string" || !email) throw new ValidationError("validation", "Email is required and must be a string");
    const trimmedEmail = email.trim();
    if (!trimmedEmail.toLowerCase().match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) throw new ValidationError("validation", "Email must match format: example@domain.com");
    if (trimmedEmail.length > 254) throw new ValidationError("validation", "Email must be 254 characters or less");
    
    // Validate password
    if (typeof password !== "string" || !password) throw new ValidationError("validation", "Password is required and must be a string");
    if (password.length < 8 || password.length > 200) throw new ValidationError("validation", "Password must be between 8 and 200 characters");
    
    // Validate name
    if (typeof name !== "string" || !name) throw new ValidationError("validation", "Name is required and must be a string");
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 100) throw new ValidationError("validation", "Name must be between 1 and 100 characters");
    
    // Normalize email
    const normalizedEmail = trimmedEmail.toLowerCase();
    
    // Check if email already exists
    const existingUser = await repos.users.findByEmail(normalizedEmail);
    if (existingUser) throw new ConflictError("email_taken", "Email address is already registered");
    
    // Create user with hashed password
    const passwordHash = await hashPassword(password);
    const user = await repos.users.create({
      email: normalizedEmail,
      passwordHash,
      name: trimmedName,
      role: "patient", // Role is always 'patient' per specification
    });
    
    // Create session
    const token = crypto.randomBytes(32).toString('base64url');
    await repos.sessions.create({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + ttlHours * 3600e3),
    });
    
    // Set cookie
    res.setHeader("Set-Cookie", sessionCookie(token, Math.round(ttlHours * 3600), config.cookieSecure));
    
    // Respond with user (excluding sensitive data)
    res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, specialty: user.specialty ?? null },
    });
  }));

  // Login route
  router.post("/login", wrap(async (req, res) => {
    const { email, password } = req.body;
    
    // Validate input
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      throw new AuthError("invalid_credentials", "Invalid email or password");
    }
    
    const trimmedEmail = email.trim().toLowerCase();
    const user = await repos.users.findByEmail(trimmedEmail);
    
    let isPasswordValid = false;
    if (user) {
      isPasswordValid = await verifyPassword(password, user.passwordHash);
    } else {
      // Use dummy hash for timing safety
      isPasswordValid = await verifyPassword(password, DUMMY_HASH);
    }
    
    if (!isPasswordValid) {
      throw new AuthError("invalid_credentials", "Invalid email or password");
    }
    
    // Create session
    const token = crypto.randomBytes(32).toString('base64url');
    await repos.sessions.create({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + ttlHours * 3600e3),
    });
    
    // Set cookie
    res.setHeader("Set-Cookie", sessionCookie(token, Math.round(ttlHours * 3600), config.cookieSecure));
    
    // Respond with user
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, specialty: user.specialty ?? null },
    });
  }));

  // Logout route
  router.post("/logout", wrap(async (req, res) => {
    const sid = req.cookies?.sid;
    if (sid) {
      await repos.sessions.delete(hashToken(sid));
    }
    res.setHeader("Set-Cookie", clearSessionCookie());
    res.status(204).send();
  }));

  // Session route
  router.get("/session", wrap(async (req, res) => {
    if (!req.user) {
      throw new AuthError("unauthenticated", "No active session");
    }
    res.json({ user: req.user });
  }));

  return router;
}