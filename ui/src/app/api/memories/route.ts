import { apiRequestErrorResponse, ApiRequestError, readRequiredSearchParam } from "@/server/api/request";
import { toMemoryResponseDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/memory/memory-repository";

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
  const worldId = url.searchParams.get("domain_id")?.trim() || "default";
  const status = url.searchParams.get("status") || "all";
  return Response.json(new MemoryRepository(getDatabase()).list({ userId, agentId, worldId, status }).map(toMemoryResponseDto));
}
