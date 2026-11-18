export function memorySessionsRepo() {
  let sessions = [];

  return {
    async create({ tokenHash, userId, expiresAt }) {
      const session = {
        token_hash: tokenHash,
        user_id: userId,
        expires_at: expiresAt,
        created_at: new Date(),
      };
      sessions = sessions.filter((s) => s.token_hash !== tokenHash);
      sessions.push(session);
      return session;
    },

    async findValid(tokenHash, now = new Date()) {
      const found = sessions.find(
        (s) => s.token_hash === tokenHash && new Date(s.expires_at).getTime() > new Date(now).getTime()
      );
      return found ? { userId: found.user_id, expiresAt: found.expires_at } : null;
    },

    async delete(tokenHash) {
      const before = sessions.length;
      sessions = sessions.filter((s) => s.token_hash !== tokenHash);
      return sessions.length < before;
    },

    async deleteExpired(now = new Date()) {
      const before = sessions.length;
      sessions = sessions.filter((s) => new Date(s.expires_at).getTime() > new Date(now).getTime());
      return before - sessions.length;
    },
  };
}
