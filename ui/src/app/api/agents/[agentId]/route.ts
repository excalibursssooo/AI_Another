import { toAgentResponseDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/chat/repositories";

export const runtime = "nodejs";

export async function GET(_req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  const agent = new AgentRepository(getDatabase()).get(agentId);
  if (!agent) {
    return Response.json({ detail: "agent not found" }, { status: 404 });
  }
  return Response.json(toAgentResponseDto(agent));
}

export async function PUT(): Promise<Response> {
  return Response.json({ detail: "agent update is not implemented in Phase 1-3" }, { status: 501 });
}

export async function DELETE(): Promise<Response> {
  return Response.json({ detail: "agent deletion is not implemented in Phase 1-3" }, { status: 501 });
}
