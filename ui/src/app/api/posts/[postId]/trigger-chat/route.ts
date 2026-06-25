export const runtime = "nodejs";

export async function POST(req: Request, context: { params: Promise<{ postId: string }> }): Promise<Response> {
  const { postId } = await context.params;
  const url = new URL(req.url);
  return Response.json({
    post_id: postId,
    user_id: url.searchParams.get("user_id") || "u001",
    agent_id: "agent-default",
    suggested_message: "我们聊聊这条动态吧。",
  });
}
