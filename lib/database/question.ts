import { Database } from "bun:sqlite";

import type { Question } from "../types";

export class QuestionDatabase {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;

  constructor(filename = "data/questions.db") {
    console.log(`Loading local database from ${filename}`);
    this.db = new Database(filename);

    this.db.run("PRAGMA journal_mode = WAL;");

    this.db.run(`
			CREATE TABLE IF NOT EXISTS questions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				external_id TEXT,
				url TEXT,
				data JSON,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(url)
			)
		`);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_external_id ON questions(external_id)
    `);

    this.insertStmt = this.db.prepare(`
			INSERT OR IGNORE INTO questions (external_id, url, data) VALUES (?, ?, ?)
		`);
  }

  saveBatch(questions: Question[], sourceUrl: string) {
    if (questions.length === 0) return;

    const insertMany = this.db.transaction((items: Question[]) => {
      for (const q of items) {
        this.insertStmt.run(q.id, sourceUrl, JSON.stringify(q));
      }
    });

    insertMany(questions);
  }

  *getQuestionsAfterId(lastId: number, limit: number) {
    const stmt = this.db.prepare(
      "SELECT id, data FROM questions WHERE id > ? ORDER BY id ASC LIMIT ?",
    );

    const rows = stmt.all(lastId, limit) as { id: number; data: string }[];

    for (const row of rows) {
      yield {
        dbId: row.id,
        question: JSON.parse(row.data) as Question,
      };
    }
  }

  getTotalCount(): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM questions");
    const result = stmt.get() as { count: number };
    return result.count;
  }

  getCountBefore(id: number): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM questions WHERE id <= ?",
    );
    const result = stmt.get(id) as { count: number };
    return result.count;
  }

  getAllUrls(): Set<string> {
    const stmt = this.db.prepare("SELECT url FROM questions");
    const rows = stmt.all() as { url: string }[];
    return new Set(rows.map((r) => r.url));
  }

  close() {
    this.db.close();
  }
}
