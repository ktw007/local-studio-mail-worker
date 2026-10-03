PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  environment_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','deleted')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  fingerprint TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  read_at TEXT,
  UNIQUE(mailbox_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS messages_mailbox_time ON messages(mailbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS messages_retention ON messages(received_at);
