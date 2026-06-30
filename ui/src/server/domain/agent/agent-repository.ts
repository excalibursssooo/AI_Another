import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";

export interface AgentRecord {
  id: string;
  name: string;
  displayName: string;
  persona: string;
  background: string;
  greeting: string;
  speakingStyle: string;
  hobbies: string[];
  worldId: string;
  status: "active" | "inactive";
  createdAt: number;
  updatedAt: number;
}

interface AgentRow {
  id: string;
  name: string;
  display_name: string;
  persona: string;
  background: string;
  greeting: string;
  speaking_style: string;
  hobbies_json: string;
  world_id: string;
  status: "active" | "inactive";
  created_at: number;
  updated_at: number;
}

export class AgentRepository {
  constructor(private readonly db: AppDatabase) {}

  listActive(worldId?: string): AgentRecord[] {
    const rows = this.db.sqlite
      .prepare(
        worldId
          ? "SELECT * FROM agents WHERE status = 'active' AND world_id = ? ORDER BY updated_at DESC"
          : "SELECT * FROM agents WHERE status = 'active' ORDER BY updated_at DESC",
      )
      .all(...(worldId ? [worldId] : [])) as AgentRow[];
    return rows.map(mapAgent);
  }

  get(agentId: string): AgentRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
    return row ? mapAgent(row) : null;
  }

  create(input: {
    name: string;
    displayName?: string;
    persona: string;
    background: string;
    greeting?: string;
    speakingStyle: string;
    hobbies: string[];
    worldId: string;
  }): AgentRecord {
    const now = Date.now();
    const id = `agent-${randomUUID()}`;
    const displayName = input.displayName ?? input.name;
    this.db.sqlite
      .prepare(
        `INSERT INTO agents
          (id, name, display_name, persona, background, greeting, speaking_style, hobbies_json, world_id, status, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        input.name,
        displayName,
        input.persona,
        input.background,
        input.greeting ?? `你好，我是${displayName}。`,
        input.speakingStyle,
        JSON.stringify(input.hobbies),
        input.worldId,
        now,
        now,
      );
    return this.get(id) as AgentRecord;
  }

  update(agentId: string, input: Partial<Omit<AgentRecord, "id" | "createdAt" | "updatedAt">>): AgentRecord | null {
    const current = this.get(agentId);
    if (!current) {
      return null;
    }
    const next = { ...current, ...input };
    const now = Date.now();
    this.db.sqlite
      .prepare(
        `UPDATE agents
         SET name = ?,
             display_name = ?,
             persona = ?,
             background = ?,
             greeting = ?,
             speaking_style = ?,
             hobbies_json = ?,
             world_id = ?,
             status = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.displayName,
        next.persona,
        next.background,
        next.greeting,
        next.speakingStyle,
        JSON.stringify(next.hobbies),
        next.worldId,
        next.status,
        now,
        agentId,
      );
    return this.get(agentId);
  }

  deactivate(agentId: string): AgentRecord | null {
    if (agentId === "agent-default") {
      return null;
    }
    return this.update(agentId, { status: "inactive" });
  }
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    persona: row.persona,
    background: row.background,
    greeting: row.greeting,
    speakingStyle: row.speaking_style,
    hobbies: parseStringArray(row.hobbies_json),
    worldId: row.world_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
