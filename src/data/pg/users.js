import { ConflictError } from "../../errors.js";

export function pgUsersRepo(pool) {
  return {
    async create({ email, passwordHash, name, role, specialty = null }) {
      const query = `
        INSERT INTO users (email, password_hash, name, role, specialty)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, email, name, role, specialty
      `;
      try {
        const result = await pool.query(query, [email, passwordHash, name, role, specialty]);
        return result.rows[0];
      } catch (err) {
        if (err.code === '23505' && (err.constraint === 'users_email_lower_uq' || err.constraint === 'users_email_lower_uq')) {
          throw new ConflictError('email_taken');
        }
        throw err;
      }
    },

    async findByEmail(email) {
      const query = `
        SELECT id, email, name, role, specialty, password_hash
        FROM users
        WHERE lower(email) = lower($1)
      `;
      const result = await pool.query(query, [email]);
      if (!result.rows[0]) return null;
      // Convert password_hash to passwordHash for consistency
      const user = { ...result.rows[0] };
      if ('password_hash' in user) {
        user.passwordHash = user.password_hash;
        delete user.password_hash;
      }
      return user;
    },

    async findById(id) {
      if (!Number.isInteger(Number(id))) {
        return null;
      }
      const query = `
        SELECT id, email, name, role, specialty
        FROM users
        WHERE id = $1
      `;
      const result = await pool.query(query, [id]);
      return result.rows[0] || null;
    },

    async listByRole(role) {
      const query = `
        SELECT id, email, name, role, specialty
        FROM users
        WHERE role = $1
        ORDER BY id
      `;
      const result = await pool.query(query, [role]);
      return result.rows;
    },
  };
}