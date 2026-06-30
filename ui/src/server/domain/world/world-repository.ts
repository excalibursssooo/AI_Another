import type { AppDatabase } from "@/server/db/client";

export interface WorldRecord {
  id: string;
  name: string;
  lore: string;
  tone: string;
  constraints: string[];
  seedMemories: string[];
}

interface WorldRow {
  id: string;
  name: string;
  lore: string;
  tone: string;
  constraints_json: string;
  seed_memories_json: string;
}

export class WorldRepository {
  constructor(private readonly db: AppDatabase) {}

  list(): WorldRecord[] {
    const rows = this.db.sqlite.prepare("SELECT * FROM worlds ORDER BY updated_at DESC").all() as WorldRow[];
    return rows.map(mapWorld);
  }

  get(worldId: string): WorldRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM worlds WHERE id = ?").get(worldId) as WorldRow | undefined;
    return row ? mapWorld(row) : null;
  }

  upsert(input: WorldRecord): WorldRecord {
    const now = Date.now();
    this.db.sqlite
      .prepare(
        `INSERT INTO worlds
          (id, name, lore, tone, constraints_json, seed_memories_json, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           lore = excluded.lore,
           tone = excluded.tone,
           constraints_json = excluded.constraints_json,
           seed_memories_json = excluded.seed_memories_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.lore,
        input.tone,
        JSON.stringify(input.constraints),
        JSON.stringify(input.seedMemories),
        now,
        now,
      );
    return this.get(input.id) as WorldRecord;
  }
}

function mapWorld(row: WorldRow): WorldRecord {
  return {
    id: row.id,
    name: row.name,
    lore: row.lore,
    tone: row.tone,
    constraints: parseStringArray(row.constraints_json),
    seedMemories: parseStringArray(row.seed_memories_json),
  };
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
