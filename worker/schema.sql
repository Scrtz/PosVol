-- Posta Volante — schema do D1
-- Rode com: wrangler d1 execute posta-volante --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  address TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,           -- NULL = endereço permanente (nunca expira)
  user_id TEXT REFERENCES users(id)  -- NULL = não vinculado a nenhuma conta
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  from_addr TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,  -- formato: "iterações:salt_hex:hash_hex" (PBKDF2-SHA256)
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_address ON messages(address);
