import { toMemoryResponseDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/chat/repositories";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ memoryId: string }> }): Promise<Response> {
  const { memoryId } = await context.params;
  const body = (await req.json()) as { user_id?: string; agent_id?: string; domain_id?: string };
  if (!body.user_id || !body.agent_id) {
    return Response.json({ detail: "user_id and agent_id are required" }, { status: 400 });
  }
  const memory = new MemoryRepository(getDatabase()).setStatus({
    userId: body.user_id,
    agentId: body.agent_id,
    worldId: body.domain_id || "default",
    memoryId,
    status: "frozen",
  });
  if (!memory) {
    return Response.json({ detail: "memory not found" }, { status: 404 });
  }
  return Response.json(toMemoryResponseDto(memory));
}
