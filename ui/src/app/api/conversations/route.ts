import { toConversationTurnDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { ConversationRepository } from "@/server/domain/conversation/conversation-repository";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id") || "u001";
  const agentId = url.searchParams.get("agent_id");
  const limit = Number(url.searchParams.get("limit") || "100");
  const worldId = url.searchParams.get("domain_id") || "default";
  if (!agentId) {
    return Response.json({ detail: "agent_id is required" }, { status: 400 });
  }

  const rows = new ConversationRepository(getDatabase())
    .recentMessagesForScope({ userId, agentId, worldId, limit: Number.isFinite(limit) ? limit : 100 })
    .filter((item) => item.role === "user" || item.role === "assistant")
    .map(toConversationTurnDto);
  return Response.json(rows);
}
