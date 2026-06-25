export const runtime = "nodejs";

export async function POST(_req: Request, context: { params: Promise<{ agentId: string }> }): Promise<Response> {
  const { agentId } = await context.params;
  return Response.json({
    agent_id: agentId,
    agent_name: agentId,
    dry_run: true,
    force_reextract: false,
    skipped_existing: true,
    existing_count: 0,
    used_fallback: true,
    extraction_backend: "stub",
    extraction_model: "phase-1-3",
    extraction_is_llm: false,
    extraction_reason: "memory seed debug is not implemented in Phase 1-3",
    raw_text: "",
    candidate_count: 0,
    persisted_count: 0,
  });
}
