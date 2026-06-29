import { getDatabase } from "@/server/db/client";
import { createChatFlow } from "@/server/flow/chat-flow";
import { createWorldInteractionFlow } from "@/server/flow/world-interaction-flow";
import { drainChatTasks } from "@/server/flow/task-worker";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    user_id?: string;
    message?: string;
    agent_id?: string;
    domain_id?: string;
    conversation_id?: string;
    client_action_id?: string;
  };

  if (!body.user_id || !body.message || !body.agent_id) {
    return Response.json({ detail: "user_id, message and agent_id are required" }, { status: 400 });
  }
  const userId = body.user_id;
  const message = body.message;
  const agentId = body.agent_id;
  const worldId = body.domain_id || "default";

  // WorldMind mode: requires client_action_id and routes through world interaction flow
  if (process.env.ENABLE_WORLD_MIND === "true") {
    if (!body.client_action_id) {
      return Response.json({ error: "missing client_action_id" }, { status: 400 });
    }
    const clientActionId = body.client_action_id;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const emit = (event: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        try {
          const db = getDatabase();
          const result = await createWorldInteractionFlow(
            {
              userId,
              worldId,
              message,
              targetAgentId: agentId,
              clientActionId,
            },
            { db },
          );

          if (result.reply) {
            emit({ type: "delta", content: result.reply });
          }
          if (result.doneEvent) {
            emit(result.doneEvent);
          }
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

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const db = getDatabase();
        const flow = createChatFlow({ db });
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
        void drainChatTasks({ db }).catch(() => undefined);
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
