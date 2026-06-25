import { toWorldDetailDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { createWorldFlow } from "@/server/flow/world-flow";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { prompt?: string; world_id?: string; base_domain_id?: string };
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
