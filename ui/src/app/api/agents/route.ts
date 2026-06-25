import { toAgentResponseDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/chat/repositories";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const worldId = url.searchParams.get("domain_id") || undefined;
  const agents = new AgentRepository(getDatabase()).listActive(worldId).map(toAgentResponseDto);
  return Response.json(agents);
}

export async function POST(): Promise<Response> {
  return Response.json({ detail: "manual agent creation is not implemented in Phase 1-3" }, { status: 501 });
}
