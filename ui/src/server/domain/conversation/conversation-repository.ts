import { randomUUID } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";

export interface ConversationMessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at: number;
}

export class ConversationRepository {
  constructor(private readonly db: AppDatabase) {}

  ensureConversation(input: { userId: string; agentId: string; worldId: string }): string {
    const existing = this.db.sqlite
      .prepare("SELECT id FROM conversations WHERE user_id = ? AND agent_id = ? AND world_id = ?")
      .get(input.userId, input.agentId, input.worldId) as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }

    const now = Date.now();
    const id = `conv-${randomUUID()}`;
    this.db.sqlite
      .prepare(
        `INSERT INTO conversations (id, user_id, agent_id, world_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.userId, input.agentId, input.worldId, now, now);
    return id;
  }

  appendMessage(input: {
    conversationId: string;
    role: ConversationMessageRecord["role"];
    content: string;
    metadataJson?: string;
  }): ConversationMessageRecord {
    const now = Date.now();
    const message: ConversationMessageRecord = {
      id: `msg-${randomUUID()}`,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      createdAt: now,
    };
    this.db.sqlite
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.conversationId, message.role, message.content, input.metadataJson ?? "{}", now);
    this.db.sqlite
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(now, input.conversationId);
    return message;
  }

  recentMessages(conversationId: string, limit: number): ConversationMessageRecord[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT id, conversation_id, role, content, created_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY rowid DESC
         LIMIT ?`,
      )
      .all(conversationId, limit) as MessageRow[];
    return rows.reverse().map(mapMessage);
  }

  recentMessagesForScope(input: { userId: string; agentId: string; worldId?: string; limit: number }): ConversationMessageRecord[] {
    const row = this.db.sqlite
      .prepare(
        `SELECT id
         FROM conversations
         WHERE user_id = ?
           AND agent_id = ?
           AND world_id = ?
         LIMIT 1`,
      )
      .get(input.userId, input.agentId, input.worldId ?? "default") as { id: string } | undefined;
    return row ? this.recentMessages(row.id, input.limit) : [];
  }
}

function mapMessage(row: MessageRow): ConversationMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}
