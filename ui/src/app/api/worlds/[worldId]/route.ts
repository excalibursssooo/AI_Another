import { toWorldDetailDto } from "@/server/api/dto";
import { apiRequestErrorResponse, ApiRequestError, parseJsonBody } from "@/server/api/request";
import { WorldUpsertRequestSchema } from "@/server/api/schemas";
import { getDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { createWorldFlow } from "@/server/flow/world-flow";

export const runtime = "nodejs";

export async function GET(_req: Request, context: { params: Promise<{ worldId: string }> }): Promise<Response> {
  const { worldId } = await context.params;
  const world = new WorldRepository(getDatabase()).get(worldId);
  if (!world) {
    return Response.json({ detail: "world not found" }, { status: 404 });
  }
  return Response.json(toWorldDetailDto(world));
}

export async function PUT(req: Request, context: { params: Promise<{ worldId: string }> }): Promise<Response> {
  const { worldId } = await context.params;
  let body;
  try {
    body = await parseJsonBody(req, WorldUpsertRequestSchema);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }

  const result = await createWorldFlow({ db: getDatabase() }).run({
    mode: "manual",
    input: {
      id: worldId,
      name: body.name,
      lore: body.lore || "",
      tone: body.tone || "",
      constraints: Array.isArray(body.constraints) ? body.constraints : [],
      seedMemories: Array.isArray(body.seed_memories) ? body.seed_memories : [],
    },
  });
  return Response.json(toWorldDetailDto(result.world!));
}
