import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

export interface AppDatabase {
  sqlite: Database.Database;
  orm: ReturnType<typeof drizzle<typeof schema>>;
}

let cachedDatabase: AppDatabase | null = null;

export function createTestDatabase(): AppDatabase {
  return createDatabase(":memory:");
}

export function getDatabase(): AppDatabase {
  if (cachedDatabase) {
    return cachedDatabase;
  }

  const resolvedPath = resolveDatabasePath(process.env.DATABASE_URL);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  cachedDatabase = createDatabase(resolvedPath);
  return cachedDatabase;
}

function resolveDatabasePath(databaseUrl?: string): string {
  const configured = databaseUrl?.trim();
  if (!configured) {
    return path.join(process.cwd(), "data", "another-world.sqlite");
  }

  const filePath = configured.startsWith("file:") ? configured.slice("file:".length) : configured;
  return path.isAbsolute(filePath) ? filePath : path.join(/*turbopackIgnore: true*/ process.cwd(), filePath);
}

function createDatabase(filename: string): AppDatabase {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const appDb: AppDatabase = { sqlite, orm: drizzle(sqlite, { schema }) };
  initializeDatabase(appDb);
  seedDefaults(appDb);
  return appDb;
}

function initializeDatabase(db: AppDatabase): void {
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lore TEXT NOT NULL DEFAULT '',
      tone TEXT NOT NULL DEFAULT '',
      constraints_json TEXT NOT NULL DEFAULT '[]',
      seed_memories_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      persona TEXT NOT NULL,
      background TEXT NOT NULL,
      greeting TEXT NOT NULL,
      speaking_style TEXT NOT NULL,
      hobbies_json TEXT NOT NULL DEFAULT '[]',
      world_id TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      world_id TEXT NOT NULL DEFAULT 'default',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS conversations_user_agent_world_idx
      ON conversations (user_id, agent_id, world_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
      ON messages (conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      world_id TEXT NOT NULL DEFAULT 'default',
      subject TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS memories_scope_idx
      ON memories (user_id, agent_id, world_id, status);

    CREATE TABLE IF NOT EXISTS agent_live_states (
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      mood_label TEXT NOT NULL,
      mood_intensity REAL NOT NULL,
      heartbeat_bpm INTEGER NOT NULL,
      risk_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS feed_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      world_id TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL,
      topic_seed TEXT NOT NULL,
      post_type TEXT NOT NULL DEFAULT 'status',
      status TEXT NOT NULL DEFAULT 'published',
      source_task_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS feed_posts_user_world_created_idx
      ON feed_posts (user_id, world_id, status, created_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      run_after INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS tasks_status_kind_run_after_idx
      ON tasks (status, kind, run_after);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='rowid'
    );

    INSERT OR IGNORE INTO memories_fts(rowid, content) SELECT rowid, content FROM memories;

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    -- v1.1-r3: append-only observability log
    CREATE TABLE IF NOT EXISTS memory_operation_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT,
      source_task_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mol_kind_time ON memory_operation_logs(kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mol_scope_time ON memory_operation_logs(user_id, agent_id, world_id, created_at DESC);

    -- v1.1-r3: feed topic clusters, scoped by user/world/agent
    CREATE TABLE IF NOT EXISTS feed_topics (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '__shared__',
      topic_key TEXT NOT NULL,
      representative_embedding_json TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_quality TEXT NOT NULL,
      embedding_dimension INTEGER NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      UNIQUE (user_id, world_id, agent_id, topic_key)
    );
    CREATE INDEX IF NOT EXISTS idx_feed_topics_scope_last_used
      ON feed_topics(user_id, world_id, agent_id, last_used_at DESC);
  `);
  migrateMemoryEmbeddingColumns(db);
  migrateAgentLiveStatesScope(db);
}

function migrateMemoryEmbeddingColumns(db: AppDatabase): void {
  const columns = db.sqlite.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const addColumn = (name: string, definition: string) => {
    if (!names.has(name)) {
      db.sqlite.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
      names.add(name);
    }
  };

  addColumn("canonical_key", "TEXT");
  addColumn("topic", "TEXT");
  addColumn("embedding_json", "TEXT");
  addColumn("embedding_model", "TEXT");
  addColumn("embedding_backend", "TEXT");
  addColumn("embedding_quality", "TEXT");
  addColumn("embedding_dimension", "INTEGER");
  addColumn("embedding_status", "TEXT NOT NULL DEFAULT 'missing'");
  addColumn("embedding_text_hash", "TEXT");
  addColumn("embedding_version", "INTEGER NOT NULL DEFAULT 1");
  addColumn("embedding_needs_refresh", "INTEGER NOT NULL DEFAULT 1");
  addColumn("embedding_updated_at", "INTEGER");
  addColumn("superseded_by", "TEXT");
  addColumn("superseded_reason", "TEXT");
  addColumn("last_observed_at", "INTEGER");
  addColumn("source_message_id", "TEXT");
  addColumn("source_task_id", "TEXT");
}

function migrateAgentLiveStatesScope(db: AppDatabase): void {
  const columns = db.sqlite.prepare("PRAGMA table_info(agent_live_states)").all() as Array<{
    name: string;
    pk: number;
  }>;
  const agentId = columns.find((column) => column.name === "agent_id");
  const userId = columns.find((column) => column.name === "user_id");
  if (!agentId || !userId || agentId.pk === 0 || userId.pk > 0) {
    return;
  }

  db.sqlite.exec(`
    ALTER TABLE agent_live_states RENAME TO agent_live_states_legacy;

    CREATE TABLE agent_live_states (
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      mood_label TEXT NOT NULL,
      mood_intensity REAL NOT NULL,
      heartbeat_bpm INTEGER NOT NULL,
      risk_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, agent_id)
    );

    INSERT OR IGNORE INTO agent_live_states
      (agent_id, user_id, agent_name, mood_label, mood_intensity, heartbeat_bpm, risk_level, updated_at)
    SELECT agent_id, user_id, agent_name, mood_label, mood_intensity, heartbeat_bpm, risk_level, updated_at
    FROM agent_live_states_legacy;

    DROP TABLE agent_live_states_legacy;
  `);
}

function seedDefaults(db: AppDatabase): void {
  const now = Date.now();
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO worlds
        (id, name, lore, tone, constraints_json, seed_memories_json, created_at, updated_at)
       VALUES
        (@id, @name, @lore, @tone, @constraintsJson, @seedMemoriesJson, @createdAt, @updatedAt)`,
    )
    .run({
      id: "default",
      name: "默认世界",
      lore: "一个适合长期陪伴对话的日常世界。",
      tone: "温和、自然、真诚",
      constraintsJson: JSON.stringify(["保持角色一致", "优先回应用户当下表达"]),
      seedMemoriesJson: JSON.stringify([]),
      createdAt: now,
      updatedAt: now,
    });

  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO agents
        (id, name, display_name, persona, background, greeting, speaking_style, hobbies_json, world_id, status, created_at, updated_at)
       VALUES
        (@id, @name, @displayName, @persona, @background, @greeting, @speakingStyle, @hobbiesJson, @worldId, @status, @createdAt, @updatedAt)`,
    )
    .run({
      id: "agent-default",
      name: "小伴",
      displayName: "小伴",
      persona: "温和、细心、适合长期对话的 AI 角色。",
      background: "作为默认角色存在，帮助验证 TypeScript ChatFlow 主链路。",
      greeting: "你好，我在这里。",
      speakingStyle: "自然、简洁、有陪伴感",
      hobbiesJson: JSON.stringify(["聊天", "观察日常", "整理记忆"]),
      worldId: "default",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
}
