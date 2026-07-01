import { toWorldDetailDto } from "@/server/api/dto";
import { apiRequestErrorResponse, ApiRequestError, parseOptionalJsonBody } from "@/server/api/request";
import { WorldAiCreateRequestSchema } from "@/server/api/schemas";
import { getDatabase } from "@/server/db/client";
import { createWorldFlow } from "@/server/flow/world-flow";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let body;
  try {
    body = await parseOptionalJsonBody(req, WorldAiCreateRequestSchema);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }

  const result = await createWorldFlow({ db: getDatabase() }).run({
    mode: "ai",
    prompt: body.prompt || null,
    worldId: body.world_id || body.base_domain_id || null,
  });
  return Response.json({
    world: toWorldDetailDto(result.world!),
    backend: result.backend || "mock",
    model: result.model || "local-world-generator",
    used_prompt: body.prompt || "",
    raw_text: result.rawText || "",
  });
}
