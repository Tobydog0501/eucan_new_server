import Database from "better-sqlite3";

/**
 * Schema migrations for loginDatabase.db.
 *
 * Every step is idempotent: it looks at the current schema first and only
 * changes what is missing, so running the whole list again (on every start-up,
 * or by hand with `npm run migrate`) is a no-op. Steps only ever add columns,
 * tables or indexes; existing rows keep their values (new columns default to
 * NULL, which means "not deleted").
 */

export type MigrationReport = { applied: string[] };

type Step = { name: string, run: (db: Database.Database) => boolean };

function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?;`).get(table) !== undefined;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  // `table` is always one of the fixed names below, never caller input.
  const columns = db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

const STEPS: Step[] = [
  {
    // Soft delete for single clock-in punches (issue #30).
    name: "clockinrecord soft-delete columns",
    run: (db) => {
      let changed = false;
      if (!hasTable(db, "clockinrecord")) {
        // Same shape as the production table; only reached on an empty database.
        db.exec(`CREATE TABLE clockinrecord (id TEXT NOT NULL,name TEXT NOT NULL,date DATETIME DEFAULT (strftime('%Y-%m-%d', 'now', '+8 hours')),num INT DEFAULT 1,clockin DATETIME,clockout DATETIME);`);
        changed = true;
      }
      for (const column of ["deleted_at", "deleted_by", "delete_reason"]) {
        if (!hasColumn(db, "clockinrecord", column)) {
          db.exec(`ALTER TABLE clockinrecord ADD COLUMN ${column} TEXT DEFAULT NULL;`);
          changed = true;
        }
      }
      return changed;
    },
  },
  {
    name: "clockin_punch_audit table",
    run: (db) => {
      if (hasTable(db, "clockin_punch_audit")) return false;
      db.exec(`
        CREATE TABLE clockin_punch_audit (
          audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL CHECK (action IN ('delete', 'restore')),
          punch_id TEXT NOT NULL,
          punch_date TEXT NOT NULL,
          punch_num INTEGER NOT NULL,
          clockin TEXT,
          clockout TEXT,
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          reason TEXT NOT NULL,
          acted_at TEXT NOT NULL
        );
      `);
      return true;
    },
  },
  {
    name: "clockinrecord (id, date) index",
    run: (db) => {
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_clockinrecord_id_date';`).get() !== undefined;
      if (exists) return false;
      // Not UNIQUE: old data is not guaranteed to be free of duplicates.
      db.exec(`CREATE INDEX idx_clockinrecord_id_date ON clockinrecord (id, date);`);
      return true;
    },
  },
  // Steps 1-3 above belong to the punch soft delete. Steps 4-7 below add the
  // missed-punch notice and the make-up (補登) request; new steps go after them.
  {
    // 4. Make-up punch requests filed by employees, reviewed by admins.
    name: "makeup_request table",
    run: (db) => {
      if (hasTable(db, "makeup_request")) return false;
      db.exec(`
        CREATE TABLE makeup_request (
          request_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          department TEXT NOT NULL,
          missed_date TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('in', 'out', 'both')),
          clockin TEXT,
          clockout TEXT,
          reason TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
          reviewer_id TEXT,
          reviewer_name TEXT,
          reviewed_at TEXT,
          review_note TEXT,
          punch_num INTEGER
        );
        CREATE INDEX idx_makeup_request_id_date ON makeup_request (id, missed_date);
        CREATE INDEX idx_makeup_request_state ON makeup_request (state);
      `);
      return true;
    },
  },
  {
    // 5. Who did what to which make-up request, and why.
    name: "makeup_audit table",
    run: (db) => {
      if (hasTable(db, "makeup_audit")) return false;
      db.exec(`
        CREATE TABLE makeup_audit (
          audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id INTEGER NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('submit', 'approve', 'reject')),
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          reason TEXT NOT NULL,
          acted_at TEXT NOT NULL
        );
        CREATE INDEX idx_makeup_audit_request ON makeup_audit (request_id);
      `);
      return true;
    },
  },
  {
    // 6. A punch created by an approved make-up request points back at it;
    //    NULL (every existing row) means an ordinary punch.
    name: "clockinrecord makeup_request_id column",
    run: (db) => {
      if (hasColumn(db, "clockinrecord", "makeup_request_id")) return false;
      db.exec(`ALTER TABLE clockinrecord ADD COLUMN makeup_request_id INTEGER DEFAULT NULL;`);
      return true;
    },
  },
  {
    // 7. One row per employee and day the missed-punch notice was handled,
    //    so a re-run never mails the same person about the same day twice.
    name: "missed_punch_notice table",
    run: (db) => {
      if (hasTable(db, "missed_punch_notice")) return false;
      db.exec(`
        CREATE TABLE missed_punch_notice (
          id TEXT NOT NULL,
          date TEXT NOT NULL,
          kind TEXT NOT NULL,
          channel TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (id, date)
        );
      `);
      return true;
    },
  },
];

/** Bring the schema up to date. Runs in one transaction: all steps or none. */
export function runMigrations(db: Database.Database): MigrationReport {
  const applied: string[] = [];
  db.transaction(() => {
    for (const step of STEPS) {
      if (step.run(db)) applied.push(step.name);
    }
  })();
  return { applied };
}
