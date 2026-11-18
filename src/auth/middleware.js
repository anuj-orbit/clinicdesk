import crypto from "node:crypto";
import { AuthError, ForbiddenError } from "../errors.js";
import { parseCookies, hashToken } from "./session.js";

export function loadSession({ repos }) {
  return async (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.sid;
      req.cookies = cookies;
      if (!token) {
        req.user = null;
        return next();
      }
      const session = await repos.sessions.findValid(hashToken(token), new Date());
      if (!session) {
        req.user = null;
        return next();
      }
      const user = await repos.users.findById(session.userId);
      if (!user) {
        req.user = null;
        return next();
      }
      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        specialty: user.specialty ?? null,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return next(new AuthError("unauthenticated"));
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AuthError("unauthenticated"));
    }
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError("forbidden"));
    }
    next();
  };
}
