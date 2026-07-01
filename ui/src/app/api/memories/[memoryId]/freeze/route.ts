import { toMemoryResponseDto } from "@/server/api/dto";
import { apiRequestErrorResponse, ApiRequestError, parseJsonBody } from "@/server/api/request";
import { MemoryScopeRequestSchema } from "@/server/api/schemas";
import { getDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/memory/memory-repository";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ memoryId: string }> }): Promise<Response> {
  const { memoryId } = await context.params;
  let body;
  try {
    body = await parseJsonBody(req, MemoryScopeRequestSchema);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
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
