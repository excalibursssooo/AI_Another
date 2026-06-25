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

export async function PUT(req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  const body = (await req.json()) as {
    name?: string;
    persona?: string;
    background?: string;
    domain_id?: string;
    hobbies?: string[];
    speaking_style?: string;
    status?: "active" | "inactive";
  };
  const updated = new AgentRepository(getDatabase()).update(agentId, {
    ...(body.name ? { name: body.name, displayName: body.name } : {}),
    ...(body.persona ? { persona: body.persona } : {}),
    ...(body.background ? { background: body.background } : {}),
    ...(body.domain_id ? { worldId: body.domain_id } : {}),
    ...(Array.isArray(body.hobbies) ? { hobbies: body.hobbies } : {}),
    ...(body.speaking_style ? { speakingStyle: body.speaking_style } : {}),
    ...(body.status ? { status: body.status } : {}),
  });
  if (!updated) {
    return Response.json({ detail: "agent not found" }, { status: 404 });
  }
  return Response.json(toAgentResponseDto(updated));
}

export async function DELETE(_req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  const deleted = new AgentRepository(getDatabase()).deactivate(agentId);
  if (!deleted) {
    return Response.json({ detail: "agent not found or protected" }, { status: 404 });
  }
  return Response.json(toAgentResponseDto(deleted));
}
