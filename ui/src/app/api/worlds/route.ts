import { toWorldDetailDto } from "@/server/api/dto";
import { apiRequestErrorResponse, ApiRequestError, parseJsonBody } from "@/server/api/request";
import { WorldUpsertRequestSchema } from "@/server/api/schemas";
import { getDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { createWorldFlow } from "@/server/flow/world-flow";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json(new WorldRepository(getDatabase()).list().map(toWorldDetailDto));
}

export async function POST(req: Request): Promise<Response> {
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
      id: body.id,
      name: body.name,
      lore: body.lore || "",
      tone: body.tone || "",
      constraints: Array.isArray(body.constraints) ? body.constraints : [],
      seedMemories: Array.isArray(body.seed_memories) ? body.seed_memories : [],
    },
  });
  return Response.json(toWorldDetailDto(result.world!));
}
