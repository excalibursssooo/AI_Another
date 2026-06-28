import type { AppDatabase } from "@/server/db/client";
import type { CharacterStateRecord } from "./types";

interface CharacterStateRow {
  user_id: string;
  world_id: string;
  agent_id: string;
  location_key: string;
  current_goal: string;
  emotional_state_json: string;
  relationship_to_user_json: string;
  knowledge_keys_json: string;
  active_command_id: string | null;
  last_acted_at: number | null;
  updated_at: number;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function mapCharacterState(row: CharacterStateRow): CharacterStateRecord {
  return {
    userId: row.user_id,
    worldId: row.world_id,
    agentId: row.agent_id,
    locationKey: row.location_key,
    currentGoal: row.current_goal,
    emotionalState: parseJson(row.emotional_state_json, { label: "neutral", intensity: 0.35 }),
    relationshipToUser: parseJson(row.relationship_to_user_json, { affinity: 0, trust: 0, tension: 0 }),
    knowledgeKeys: parseJson(row.knowledge_keys_json, []),
    activeCommandId: row.active_command_id,
    lastActedAt: row.last_acted_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterStateRepository {
  constructor(private readonly db: AppDatabase) {}

  getOrCreateDefault(input: { userId: string; worldId: string; agentId: string }): CharacterStateRecord {
    const existing = this.findByScope(input);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const defaultState: CharacterStateRecord = {
      userId: input.userId,
      worldId: input.worldId,
      agentId: input.agentId,
      locationKey: "default",
      currentGoal: "保持当前互动并等待世界指令",
      emotionalState: { label: "neutral", intensity: 0.35 },
      relationshipToUser: { affinity: 0, trust: 0, tension: 0 },
      knowledgeKeys: [],
      activeCommandId: null,
      lastActedAt: null,
      updatedAt: now,
    };

    this.db.sqlite
      .prepare(
        `INSERT INTO character_states
          (user_id, world_id, agent_id, location_key, current_goal, emotional_state_json,
           relationship_to_user_json, knowledge_keys_json, active_command_id, last_acted_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        defaultState.userId,
        defaultState.worldId,
        defaultState.agentId,
        defaultState.locationKey,
        defaultState.currentGoal,
        stringifyJson(defaultState.emotionalState),
        stringifyJson(defaultState.relationshipToUser),
        stringifyJson(defaultState.knowledgeKeys),
        defaultState.activeCommandId,
        defaultState.lastActedAt,
        defaultState.updatedAt,
      );

    return this.findByScope(input)!;
  }

  listForWorld(input: { userId: string; worldId: string }): CharacterStateRecord[] {
    const rows = this.db.sqlite
      .prepare("SELECT * FROM character_states WHERE user_id = ? AND world_id = ?")
      .all(input.userId, input.worldId) as CharacterStateRow[];
    return rows.map(mapCharacterState);
  }

  upsertMany(states: CharacterStateRecord[]): CharacterStateRecord[] {
    const now = Date.now();
    for (const state of states) {
      this.db.sqlite
        .prepare(
          `INSERT INTO character_states
            (user_id, world_id, agent_id, location_key, current_goal, emotional_state_json,
             relationship_to_user_json, knowledge_keys_json, active_command_id, last_acted_at, updated_at)
           VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, world_id, agent_id) DO UPDATE SET
             location_key = excluded.location_key,
             current_goal = excluded.current_goal,
             emotional_state_json = excluded.emotional_state_json,
             relationship_to_user_json = excluded.relationship_to_user_json,
             knowledge_keys_json = excluded.knowledge_keys_json,
             active_command_id = excluded.active_command_id,
             last_acted_at = excluded.last_acted_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          state.userId,
          state.worldId,
          state.agentId,
          state.locationKey,
          state.currentGoal,
          stringifyJson(state.emotionalState),
          stringifyJson(state.relationshipToUser),
          stringifyJson(state.knowledgeKeys),
          state.activeCommandId,
          state.lastActedAt,
          now,
        );
    }
    return states;
  }

  private findByScope(input: { userId: string; worldId: string; agentId: string }): CharacterStateRecord | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM character_states WHERE user_id = ? AND world_id = ? AND agent_id = ?")
      .get(input.userId, input.worldId, input.agentId) as CharacterStateRow | undefined;
    return row ? mapCharacterState(row) : null;
  }
}
