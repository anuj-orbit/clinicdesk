import { ConflictError } from "../../errors.js";

export function memoryUsersRepo() {
  const users = [];
  let nextId = 1;

  function toUser(u) {
    return { id: u.id, email: u.email, name: u.name, role: u.role, specialty: u.specialty ?? null };
  }

  return {
    async create({ email, passwordHash, name, role, specialty = null }) {
      if (users.some((u) => u.email.toLowerCase() === String(email).toLowerCase())) {
        throw new ConflictError("email_taken");
      }
      const user = {
        id: nextId++,
        email,
        passwordHash,
        name,
        role,
        specialty,
        created_at: new Date().toISOString(),
      };
      users.push(user);
      return toUser(user);
    },

    async findByEmail(email) {
      const found = users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
      return found ? { ...toUser(found), passwordHash: found.passwordHash } : null;
    },

    async findById(id) {
      const found = users.find((u) => u.id === Number(id));
      return found ? toUser(found) : null;
    },

    async listByRole(role) {
      return users.filter((u) => u.role === role).map(toUser);
    },
  };
}
