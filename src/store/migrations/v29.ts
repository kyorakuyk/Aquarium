import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 29,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS event_advocacies (
        event_id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        owner_id INTEGER NOT NULL CHECK (owner_id > 0),
        source_session_id TEXT NOT NULL CHECK (length(source_session_id) BETWEEN 1 AND 512),
        requested_at INTEGER NOT NULL CHECK (requested_at >= 0),
        status TEXT NOT NULL DEFAULT 'awaiting_confirmation'
          CHECK (status IN ('awaiting_confirmation', 'confirmed', 'sending', 'sent', 'failed', 'cancelled')),
        prompt_message_id TEXT CHECK (prompt_message_id IS NULL OR length(prompt_message_id) BETWEEN 1 AND 512),
        prompted_at INTEGER CHECK (prompted_at IS NULL OR prompted_at >= 0),
        confirmation_message_id TEXT CHECK (confirmation_message_id IS NULL OR length(confirmation_message_id) BETWEEN 1 AND 512),
        confirmed_at INTEGER CHECK (confirmed_at IS NULL OR confirmed_at >= 0),
        claimed_at INTEGER CHECK (claimed_at IS NULL OR claimed_at >= 0),
        sent_message_id TEXT CHECK (sent_message_id IS NULL OR length(sent_message_id) BETWEEN 1 AND 512),
        sent_at INTEGER CHECK (sent_at IS NULL OR sent_at >= 0),
        failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('adapter_error', 'delivery_unknown')),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        UNIQUE (event_id, account),
        FOREIGN KEY (event_id, account) REFERENCES events (id, account) ON DELETE CASCADE,
        FOREIGN KEY (event_id, owner_id) REFERENCES event_notes (event_id, owner_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_event_advocacies_account_owner_status
      ON event_advocacies (account, owner_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_advocacies_account_status
      ON event_advocacies (account, status, updated_at DESC);

      INSERT OR IGNORE INTO event_advocacies (
        event_id, account, owner_id, source_session_id, requested_at, status, created_at, updated_at
      )
      SELECT event_id, account, owner_id, source_session_id, updated_at, 'awaiting_confirmation', created_at, updated_at
      FROM event_notes
      WHERE intent = 'advocate' AND status = 'active'
      ORDER BY updated_at DESC, id DESC;
    `);
  },
};
