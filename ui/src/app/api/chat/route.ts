import { getDatabase } from "@/server/db/client";
import { createChatFlow } from "@/server/flow/chat-flow";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    user_id?: string;
    message?: string;
    agent_id?: string;
    domain_id?: string;
    conversation_id?: string;
  };

  if (!body.user_id || !body.message || !body.agent_id) {
    return Response.json({ detail: "user_id, message and agent_id are required" }, { status: 400 });
  }
  const userId = body.user_id;
  const message = body.message;
  const agentId = body.agent_id;
  const worldId = body.domain_id || "default";

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const flow = createChatFlow({ db: getDatabase() });
        const result = await flow.run(
          {
            userId,
            agentId,
            worldId,
            input: message,
          },
          (event) => {
            if (event.type === "delta") {
              emit(event);
            }
          },
        );

        if (result.reply) {
          emit({ type: "delta", content: result.reply });
        }
        emit(result.doneEvent);
      } catch (error) {
        emit({
          type: "done",
          agent_id: agentId,
          agent_name: agentId,
          emotion_label: "neutral",
          mood_intensity: 0.2,
          heartbeat_bpm: 72,
          risk_level: "low",
          recalled_memories: [],
          persisted_memory_count: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
