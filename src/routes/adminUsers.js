import express from "express";
import { ValidationError, AuthError, ForbiddenError, ConflictError } from "../errors.js";
import { wrap } from "../errors.js";
import { requireRole } from "../auth/middleware.js";
import { hashPassword } from "../auth/password.js";

export function adminUsersRouter({ repos, config }) {
  const router = express.Router();

  // Create doctor route
  router.post("/doctors", requireRole("admin"), wrap(async (req, res) => {
    const { email, password, name, specialty } = req.body;
    
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
    
    // Validate specialty (optional)
    let normalizedSpecialty = null;
    if (specialty !== undefined) {
      if (typeof specialty !== "string") throw new ValidationError("validation", "Specialty must be a string if provided");
      const trimmedSpecialty = specialty.trim();
      if (trimmedSpecialty.length > 100) throw new ValidationError("validation", "Specialty must be 100 characters or less");
      normalizedSpecialty = trimmedSpecialty || null;
    }
    
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
      role: "doctor", // Create doctor role
      specialty: normalizedSpecialty,
    });
    
    // Respond with user (excluding sensitive data)
    res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, specialty: user.specialty ?? null },
    });
  }));

  // List users route
  router.get("/users", requireRole("admin"), wrap(async (req, res) => {
    const { role } = req.query;
    
    // Validate role parameter if provided
    if (role !== undefined) {
      if (typeof role !== "string") throw new ValidationError("validation", "Role must be a string if provided");
      if (!["doctor", "patient", "admin"].includes(role)) throw new ValidationError("validation", "Role must be one of: doctor, patient, admin");
      
      const users = await repos.users.listByRole(role);
      res.json({ users });
    } else {
      // Get all users from all roles
      const allUsers = [
        ...(await repos.users.listByRole("doctor")),
        ...(await repos.users.listByRole("patient")),
        ...(await repos.users.listByRole("admin")),
      ];
      // Sort by id
      allUsers.sort((a, b) => a.id - b.id);
      res.json({ users: allUsers });
    }
  }));

  return router;
}