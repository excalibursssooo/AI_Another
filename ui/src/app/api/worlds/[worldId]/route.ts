import { toWorldDetailDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/chat/repositories";

export const runtime = "nodejs";

export async function GET(_req: Request, context: { params: Promise<{ worldId: string }> }): Promise<Response> {
  const { worldId } = await context.params;
  const world = new WorldRepository(getDatabase()).get(worldId);
  if (!world) {
    return Response.json({ detail: "world not found" }, { status: 404 });
  }
  return Response.json(toWorldDetailDto(world));
}

export async function PUT(): Promise<Response> {
  return Response.json({ detail: "world update is not implemented in Phase 1-3" }, { status: 501 });
}
