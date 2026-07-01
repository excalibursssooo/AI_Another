import { apiRequestErrorResponse, ApiRequestError, readRequiredSearchParam } from "@/server/api/request";
import { toConversationTurnDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { ConversationRepository } from "@/server/domain/conversation/conversation-repository";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let userId: string;
  let agentId: string;
  try {
    userId = readRequiredSearchParam(url, "user_id");
    agentId = readRequiredSearchParam(url, "agent_id");
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }
  const limit = Number(url.searchParams.get("limit") || "100");
  const worldId = url.searchParams.get("domain_id")?.trim() || "default";

  const rows = new ConversationRepository(getDatabase())
    .recentMessagesForScope({ userId, agentId, worldId, limit: Number.isFinite(limit) ? limit : 100 })
    .filter((item) => item.role === "user" || item.role === "assistant")
    .map(toConversationTurnDto);
  return Response.json(rows);
}
