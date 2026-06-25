export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    memory_repository: "sqlite",
    memory_vector: "disabled",
    emotion_backend: "chatflow",
    emotion_model: process.env.CHAT_MODEL || "mock",
    openrouter_api_key_present: false,
    postgres: { enabled: false, configured: false, reachable: false, detail: "disabled in Phase 1-3" },
    qdrant: { enabled: false, configured: false, reachable: false, detail: "disabled in Phase 1-3" },
  });
}
