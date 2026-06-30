import type { AppDatabase } from "@/server/db/client";

export interface AgentLiveStateRecord {
  agentId: string;
  userId: string;
  agentName: string;
  moodLabel: string;
  moodIntensity: number;
  heartbeatBpm: number;
  riskLevel: string;
  updatedAt: number;
}

export class AgentLiveStateRepository {
  constructor(private readonly db: AppDatabase) {}

  upsert(input: AgentLiveStateRecord): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO agent_live_states
         (agent_id, user_id, agent_name, mood_label, mood_intensity, heartbeat_bpm, risk_level, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, agent_id) DO UPDATE SET
           agent_name = excluded.agent_name,
           mood_label = excluded.mood_label,
           mood_intensity = excluded.mood_intensity,
           heartbeat_bpm = excluded.heartbeat_bpm,
           risk_level = excluded.risk_level,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.agentId,
        input.userId,
        input.agentName,
        input.moodLabel,
        input.moodIntensity,
        input.heartbeatBpm,
        input.riskLevel,
        input.updatedAt,
      );
  }

  get(userId: string, agentId: string, fallbackName: string): AgentLiveStateRecord {
    const row = this.db.sqlite
      .prepare("SELECT * FROM agent_live_states WHERE user_id = ? AND agent_id = ?")
      .get(userId, agentId) as
      | {
          agent_id: string;
          user_id: string;
          agent_name: string;
          mood_label: string;
          mood_intensity: number;
          heartbeat_bpm: number;
          risk_level: string;
          updated_at: number;
        }
      | undefined;
    if (row) {
      return {
        agentId: row.agent_id,
        userId: row.user_id,
        agentName: row.agent_name,
        moodLabel: row.mood_label,
        moodIntensity: row.mood_intensity,
        heartbeatBpm: row.heartbeat_bpm,
        riskLevel: row.risk_level,
        updatedAt: row.updated_at,
      };
    }
    return {
      agentId,
      userId,
      agentName: fallbackName,
      moodLabel: "calm",
      moodIntensity: 0.35,
      heartbeatBpm: 72,
      riskLevel: "low",
      updatedAt: Date.now(),
    };
  }
}
