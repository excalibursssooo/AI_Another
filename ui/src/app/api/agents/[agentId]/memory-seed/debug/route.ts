import { apiRequestErrorResponse, ApiRequestError, parseOptionalJsonBody } from "@/server/api/request";
import { AgentMemorySeedDebugRequestSchema } from "@/server/api/schemas";
import { getDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/agent/agent-repository";
import { MemoryRepository } from "@/server/domain/memory/memory-repository";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  let body;
  try {
    body = await parseOptionalJsonBody(req, AgentMemorySeedDebugRequestSchema);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }

  const db = getDatabase();
  const agent = new AgentRepository(db).get(agentId);
  if (!agent) {
    return Response.json({ detail: "agent not found" }, { status: 404 });
  }
  const userId = body.user_id || process.env.DEV_USER_ID || "u001";
  const worldId = body.domain_id || agent.worldId || "default";
  const memories = new MemoryRepository(db);
  const existing = memories.list({ userId, agentId, worldId, status: "active" });
  const rawText = [agent.persona, agent.background, agent.greeting, agent.hobbies.join("、")].filter(Boolean).join("\n");
  const candidates = [
    { type: "profile", content: `${agent.displayName}: ${agent.persona}` },
    { type: "profile", content: agent.background },
    { type: "preference", content: agent.hobbies.length ? `${agent.displayName}关注: ${agent.hobbies.join("、")}` : "" },
  ].filter((item) => item.content.trim());
  let persistedCount = 0;
  const shouldPersist = !body.dry_run && (body.force_reextract || existing.length === 0);
  if (shouldPersist) {
    for (const candidate of candidates) {
      memories.create({
        userId,
        agentId,
        worldId,
        subject: "agent",
        memoryType: candidate.type,
        content: candidate.content,
        confidence: 0.78,
        importance: 0.62,
      });
      persistedCount += 1;
    }
  }
  return Response.json({
    agent_id: agentId,
    agent_name: agent.displayName || agent.name,
    dry_run: Boolean(body.dry_run),
    force_reextract: Boolean(body.force_reextract),
    skipped_existing: !body.force_reextract && existing.length > 0,
    existing_count: existing.length,
    used_fallback: true,
    extraction_backend: "local",
    extraction_model: "rule-seed",
    extraction_is_llm: false,
    extraction_reason: shouldPersist ? "seeded from agent profile" : "dry run or existing active seed memories",
    raw_text: rawText,
    candidate_count: candidates.length,
    persisted_count: persistedCount,
  });
}
