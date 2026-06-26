export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    memory_repository: "sqlite",
    memory_vector: "disabled",
    emotion_backend: "chatflow",
    emotion_model: process.env.CHAT_MODEL || "mock",
    postgres: { enabled: false, configured: false, reachable: false, detail: "disabled by TypeScript SQLite refactor" },
    qdrant: { enabled: false, configured: false, reachable: false, detail: "disabled by TypeScript SQLite refactor" },
  });
}
