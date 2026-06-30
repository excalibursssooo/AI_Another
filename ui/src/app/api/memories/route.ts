import { toMemoryResponseDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/memory/memory-repository";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id") || "u001";
  const agentId = url.searchParams.get("agent_id");
  const worldId = url.searchParams.get("domain_id") || "default";
  const status = url.searchParams.get("status") || "all";
  if (!agentId) {
    return Response.json({ detail: "agent_id is required" }, { status: 400 });
  }
  return Response.json(new MemoryRepository(getDatabase()).list({ userId, agentId, worldId, status }).map(toMemoryResponseDto));
}
