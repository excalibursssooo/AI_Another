import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type {
  ActorCommandRecord,
  ActorCommandType,
  ActorCommandPriority,
  ActorCommandStatus,
  VisibilityScope,
} from "./types";

interface ActorCommandRow {
  id: string;
  decision_id: string;
  world_run_id: string;
  user_id: string;
  world_id: string;
  target_agent_id: string;
  command_type: ActorCommandType;
  priority: ActorCommandPriority;
  visibility: VisibilityScope["mode"];
  visible_to_actor_ids_json: string;
  visible_to_user: number;
  actor_instruction: string;
  private_reason: string | null;
  cause_json: string;
  payload_json: string;
  related_event_id: string | null;
  status: ActorCommandStatus;
  run_after: number;
  expires_at: number | null;
  idempotency_key: string;
  claimed_by: string | null;
  claimed_at: number | null;
  claim_expires_at: number | null;
  result_event_id: string | null;
  created_at: number;
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

function mapActorCommand(row: ActorCommandRow): ActorCommandRecord {
  return {
    id: row.id,
    decisionId: row.decision_id,
    worldRunId: row.world_run_id,
    userId: row.user_id,
    worldId: row.world_id,
    targetAgentId: row.target_agent_id,
    commandType: row.command_type,
    priority: row.priority,
    visibility: {
      mode: row.visibility,
      visibleToActorIds: parseJson(row.visible_to_actor_ids_json, []),
      visibleToUser: row.visible_to_user === 1,
    },
    actorInstruction: row.actor_instruction,
    privateReason: row.private_reason,
    cause: parseJson(row.cause_json, { type: "source_action", sourceActionId: "" }),
    payload: parseJson(row.payload_json, {}),
    relatedEventId: row.related_event_id,
    status: row.status,
    runAfter: row.run_after,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    resultEventId: row.result_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateActorCommandInput = Omit<
  ActorCommandRecord,
  | "id"
  | "status"
  | "claimedBy"
  | "claimedAt"
  | "claimExpiresAt"
  | "resultEventId"
  | "createdAt"
  | "updatedAt"
> & { idempotencyKey: string };

export class ActorCommandRepository {
  constructor(private readonly db: AppDatabase) {}

  createMany(commands: CreateActorCommandInput[]): ActorCommandRecord[] {
    const now = Date.now();
    const results: ActorCommandRecord[] = [];

    for (const input of commands) {
      const existing = this.getByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        results.push(existing);
        continue;
      }

      const id = `acmd-${randomUUID()}`;
      this.db.sqlite
        .prepare(
          `INSERT INTO actor_commands
            (id, decision_id, world_run_id, user_id, world_id, target_agent_id, command_type, priority,
             visibility, visible_to_actor_ids_json, visible_to_user, actor_instruction, private_reason,
             cause_json, payload_json, related_event_id, status, run_after, expires_at, idempotency_key,
             created_at, updated_at)
           VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.decisionId,
          input.worldRunId,
          input.userId,
          input.worldId,
          input.targetAgentId,
          input.commandType,
          input.priority,
          input.visibility.mode,
          stringifyJson(input.visibility.visibleToActorIds),
          input.visibility.visibleToUser ? 1 : 0,
          input.actorInstruction,
          input.privateReason,
          stringifyJson(input.cause),
          stringifyJson(input.payload),
          input.relatedEventId,
          input.runAfter,
          input.expiresAt,
          input.idempotencyKey,
          now,
          now,
        );

      const created = this.getById(id);
      if (created) {
        results.push(created);
      }
    }

    return results;
  }

  claimVisibleSpeakCommand(input: {
    userId: string;
    worldId: string;
    agentId: string;
    claimedBy: string;
    leaseMs: number;
  }): ActorCommandRecord | null {
    const now = Date.now();
    const expiresAt = now + input.leaseMs;

    const claimed = this.db.sqlite.transaction(() => {
      // Find a pending speak_to_user command visible to the target
      const row = this.db.sqlite
        .prepare(
          `SELECT * FROM actor_commands
           WHERE user_id = ?
             AND world_id = ?
             AND target_agent_id = ?
             AND command_type = 'speak_to_user'
             AND status = 'pending'
             AND (
               visibility = 'public'
               OR (visibility = 'private' AND ? IN (SELECT value FROM json_each(visible_to_actor_ids_json)))
             )
             AND (expires_at IS NULL OR expires_at > ?)
             AND run_after <= ?
           ORDER BY
             (CASE priority WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END) DESC,
             run_after ASC,
             created_at ASC
           LIMIT 1`,
        )
        .get(
          input.userId,
          input.worldId,
          input.agentId,
          input.agentId,
          now,
          now,
        ) as ActorCommandRow | undefined;

      if (!row) {
        return null;
      }

      this.db.sqlite
        .prepare(
          `UPDATE actor_commands
           SET status = 'claimed', claimed_by = ?, claimed_at = ?, claim_expires_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.claimedBy, now, expiresAt, now, row.id);

      return this.getById(row.id);
    })();

    return claimed;
  }

  markDone(input: { commandId: string; resultEventId?: string | null }): ActorCommandRecord | null {
    const now = Date.now();
    // Only update if not already done
    const result = this.db.sqlite
      .prepare(
        `UPDATE actor_commands
         SET status = 'done', result_event_id = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'claimed')`,
      )
      .run(input.resultEventId ?? null, now, input.commandId);

    if (result.changes === 0) {
      // Already done — return existing record (idempotent)
      return this.getById(input.commandId);
    }

    return this.getById(input.commandId);
  }

  releaseClaim(input: { commandId: string; claimedBy: string }): ActorCommandRecord | null {
    const now = Date.now();
    const result = this.db.sqlite
      .prepare(
        `UPDATE actor_commands
         SET status = 'pending', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE id = ? AND claimed_by = ?`,
      )
      .run(now, input.commandId, input.claimedBy);

    if (result.changes === 0) {
      return null;
    }

    return this.getById(input.commandId);
  }

  claimNextExecutableCommand(input: {
    workerId: string;
    leaseMs: number;
    commandTypes?: ActorCommandType[];
  }): ActorCommandRecord | null {
    const now = Date.now();
    const claimExpiresAt = now + input.leaseMs;
    const commandTypes = input.commandTypes ?? ["move_location", "investigate", "remember", "publish_post", "initiate_event"];

    return this.db.sqlite.transaction(() => {
      const row = this.db.sqlite
        .prepare(
          `SELECT * FROM actor_commands
           WHERE command_type IN (${commandTypes.map(() => "?").join(", ")})
             AND run_after <= ?
             AND (expires_at IS NULL OR expires_at > ?)
             AND (
               status = 'pending'
               OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
             )
           ORDER BY
             (CASE priority WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END) DESC,
             run_after ASC,
             created_at ASC
           LIMIT 1`,
        )
        .get(...commandTypes, now, now, now) as ActorCommandRow | undefined;
      if (!row) {
        return null;
      }

      const result = this.db.sqlite
        .prepare(
          `UPDATE actor_commands
           SET status = 'claimed',
               claimed_by = ?,
               claimed_at = ?,
               claim_expires_at = ?,
               updated_at = ?
           WHERE id = ?
             AND (
               status = 'pending'
               OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
             )`,
        )
        .run(input.workerId, now, claimExpiresAt, now, row.id, now);

      return result.changes === 0 ? null : this.getById(row.id);
    })();
  }

  markDoneByWorker(input: {
    commandId: string;
    claimedBy: string;
    resultEventId?: string | null;
  }): ActorCommandRecord | null {
    const now = Date.now();
    const result = this.db.sqlite
      .prepare(
        `UPDATE actor_commands
         SET status = 'done',
             result_event_id = ?,
             claimed_at = NULL,
             claim_expires_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'claimed'
           AND claimed_by = ?`,
      )
      .run(input.resultEventId ?? null, now, input.commandId, input.claimedBy);
    return result.changes === 0 ? null : this.getById(input.commandId);
  }

  markFailed(input: { commandId: string; claimedBy: string; reason: string }): ActorCommandRecord | null {
    const now = Date.now();
    const current = this.getById(input.commandId);
    const nextPrivateReason = [current?.privateReason, `failure: ${input.reason}`].filter(Boolean).join("\n");
    const result = this.db.sqlite
      .prepare(
        `UPDATE actor_commands
         SET status = 'failed',
             private_reason = ?,
             claimed_at = NULL,
             claim_expires_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'claimed'
           AND claimed_by = ?`,
      )
      .run(nextPrivateReason, now, input.commandId, input.claimedBy);
    return result.changes === 0 ? null : this.getById(input.commandId);
  }

  getById(id: string): ActorCommandRecord | null {
    const row = this.db.sqlite.prepare("SELECT * FROM actor_commands WHERE id = ?").get(id) as ActorCommandRow | undefined;
    return row ? mapActorCommand(row) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): ActorCommandRecord | null {
    const row = this.db.sqlite
      .prepare("SELECT * FROM actor_commands WHERE idempotency_key = ?")
      .get(idempotencyKey) as ActorCommandRow | undefined;
    return row ? mapActorCommand(row) : null;
  }
}
