import { toPostItemDto } from "@/server/api/dto";
import { apiRequestErrorResponse, ApiRequestError, parseOptionalJsonBody } from "@/server/api/request";
import { FeedGenerateRequestSchema } from "@/server/api/schemas";
import { getDatabase } from "@/server/db/client";
import { createFeedGenerateFlow } from "@/server/flow/feed-flow";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  let body;
  try {
    body = await parseOptionalJsonBody(req, FeedGenerateRequestSchema);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }

  const result = await createFeedGenerateFlow({ db: getDatabase() }).run({
    userId: body.user_id,
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
