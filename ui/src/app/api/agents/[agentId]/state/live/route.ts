import { toAgentLiveStateDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { AgentLiveStateRepository, AgentRepository } from "@/server/domain/chat/repositories";

export const runtime = "nodejs";

export async function GET(req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id") || "u001";
  const db = getDatabase();
  const agent = new AgentRepository(db).get(agentId);
  const state = new AgentLiveStateRepository(db).get(userId, agentId, agent?.displayName || agent?.name || agentId);
  return Response.json(toAgentLiveStateDto(state));
}
