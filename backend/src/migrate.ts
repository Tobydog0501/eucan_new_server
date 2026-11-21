/**
 * Run the schema migrations by hand:
 *
 *   npm run migrate                    # ./databases/loginDatabase.db
 *   npm run migrate -- path/to/file.db # another database file
 *
 * The backend also runs them on every start-up, so this is only needed to
 * upgrade a database without starting the server. Safe to run repeatedly.
 */
import Database from "better-sqlite3";
import fs from "fs";
import { runMigrations } from "./plugins/migrations";

const file = process.argv[2] || "./databases/loginDatabase.db";
if (!fs.existsSync(file)) {
  console.error(`Database not found: ${file}`);
  process.exit(1);
}
const db = new Database(file);
try {
  const { applied } = runMigrations(db);
  console.log(applied.length === 0 ? `${file}: schema already up to date.` : `${file}: applied ${applied.join("; ")}.`);
} finally {
  db.close();
}
