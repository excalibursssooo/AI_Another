import { toAgentResponseDto } from "@/server/api/dto";
import { apiRequestErrorResponse, ApiRequestError, parseJsonBody } from "@/server/api/request";
import { AgentUpdateRequestSchema } from "@/server/api/schemas";
import { getDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/agent/agent-repository";
import { WorldRepository } from "@/server/domain/world/world-repository";

export const runtime = "nodejs";

export async function GET(_req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  const db = getDatabase();
  const agent = new AgentRepository(db).get(agentId);
  if (!agent) {
    return Response.json({ detail: "agent not found" }, { status: 404 });
  }
  const world = new WorldRepository(db).get(agent.worldId);
  return Response.json(toAgentResponseDto(agent, world));
}

export async function PUT(req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  let body;
  try {
    body = await parseJsonBody(req, AgentUpdateRequestSchema);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }

  const db = getDatabase();
  const updated = new AgentRepository(db).update(agentId, {
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
  const world = new WorldRepository(db).get(updated.worldId);
  return Response.json(toAgentResponseDto(updated, world));
}

export async function DELETE(_req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  const db = getDatabase();
  const deleted = new AgentRepository(db).deactivate(agentId);
  if (!deleted) {
    return Response.json({ detail: "agent not found or protected" }, { status: 404 });
  }
  const world = new WorldRepository(db).get(deleted.worldId);
  return Response.json(toAgentResponseDto(deleted, world));
}
