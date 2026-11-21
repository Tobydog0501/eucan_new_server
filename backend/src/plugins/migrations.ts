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
