import { toPostItemDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { createFeedGenerateFlow } from "@/server/flow/feed-flow";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  const body = (await req.json().catch(() => ({}))) as {
    user_id?: string;
    domain_id?: string;
    source_task_id?: string | null;
  };
  const result = await createFeedGenerateFlow({ db: getDatabase() }).run({
    userId: body.user_id || "u001",
    agentId,
    worldId: body.domain_id || "default",
    sourceTaskId: body.source_task_id ?? null,
  });
  return Response.json({
    skipped: Boolean(result.skipped),
    reason: result.reason || "generated",
    post: result.post ? toPostItemDto(result.post) : null,
  });
}
