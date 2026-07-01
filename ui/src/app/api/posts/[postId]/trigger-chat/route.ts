import { apiRequestErrorResponse, ApiRequestError, readRequiredSearchParam } from "@/server/api/request";
import { getDatabase } from "@/server/db/client";
import { createPostTrigger } from "@/server/flow/feed-flow";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ postId: string }> }): Promise<Response> {
  const { postId } = await context.params;
  const url = new URL(req.url);
  let userId: string;
  try {
    userId = readRequiredSearchParam(url, "user_id");
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }
  const trigger = createPostTrigger({ db: getDatabase(), postId, userId });
  if (!trigger) {
    return Response.json({ detail: "post not found" }, { status: 404 });
  }
  return Response.json({
    post_id: trigger.postId,
    user_id: trigger.userId,
    agent_id: trigger.agentId,
    suggested_message: trigger.suggestedMessage,
  });
}
