import { apiRequestErrorResponse, ApiRequestError, parseJsonBody } from "@/server/api/request";
import { DrainTasksRequestSchema } from "@/server/api/schemas";
import { getDatabase } from "@/server/db/client";
import { drainChatTasks } from "@/server/flow/task-worker";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let body;
  try {
    body = await parseJsonBody(req, DrainTasksRequestSchema);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }

  const result = await drainChatTasks({
    db: getDatabase(),
    limit: body.limit,
  });

  return Response.json(result);
}
