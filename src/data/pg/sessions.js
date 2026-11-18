export function pgSessionsRepo(pool) {
  return {
    async create({ tokenHash, userId, expiresAt }) {
      const query = `
        INSERT INTO sessions (token_hash, user_id, expires_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (token_hash) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          expires_at = EXCLUDED.expires_at,
          created_at = EXCLUDED.created_at
        RETURNING *
      `;
      const result = await pool.query(query, [tokenHash, userId, expiresAt]);
      return {
        token_hash: result.rows[0].token_hash,
        user_id: result.rows[0].user_id,
        expires_at: result.rows[0].expires_at,
        created_at: result.rows[0].created_at,
      };
    },

    async findValid(tokenHash, now = new Date()) {
      const query = `
        SELECT user_id, expires_at
        FROM sessions
        WHERE token_hash = $1 AND expires_at > $2
      `;
      const result = await pool.query(query, [tokenHash, now]);
      return result.rows[0] ? {
        userId: result.rows[0].user_id,
        expiresAt: result.rows[0].expires_at,
      } : null;
    },

    async delete(tokenHash) {
      const query = `DELETE FROM sessions WHERE token_hash = $1`;
      const result = await pool.query(query, [tokenHash]);
      return result.rowCount > 0;
    },

    async deleteExpired(now = new Date()) {
      const query = `DELETE FROM sessions WHERE expires_at <= $1`;
      const result = await pool.query(query, [now]);
      return result.rowCount;
    },
  };
}