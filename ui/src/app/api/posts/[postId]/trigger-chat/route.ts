import { getDatabase } from "@/server/db/client";
import { createPostTrigger } from "@/server/flow/feed-flow";

export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ postId: string }> }): Promise<Response> {
  const { postId } = await context.params;
  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id") || "u001";
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
