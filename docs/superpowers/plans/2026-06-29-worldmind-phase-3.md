# WorldMind Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 2 mock-director contract with a structured WorldMind director path where the LLM only proposes, the validator rejects invalid decisions, and decision logs explain accepted and rejected runs.

**Architecture:** Phase 3 keeps the Phase 2 transaction boundary: `WorldMindFlow` remains the only primary writer for source events, derived events, snapshots, character states, commands, and decision logs. The phase tightens the structured output schema, builds a layered director context from committed state and read-only world memory recall, validates proposal semantics before commit, and records prompt/model/output details for observability. It does not add background workers, command execution workers, memory consolidation, or autonomous tick leasing.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, better-sqlite3, Zod, AI SDK structured output, SQLite.

---

## Phase 3 Scope

Implement:

- Spec-aligned `WorldMindDecisionSchema` with `events`, `commands`, and `memories` field names.
- Backward-compatible parsing only where needed to migrate existing Phase 2 tests, then update tests and flow code to use spec names.
- `worldDirector` structured-output wiring with `WORLD_DIRECTOR_MODEL`.
- Validator rules for invalid agents, invalid event and command types, duplicate client event ids, invalid command causes, basic typed payload schemas, count limits, public/private leakage, and hidden fact leakage.
- Layered director context with strict world loading, latest snapshot, active actors, recent world ledger, recent actor ledger, read-only world memory recall, current source input, output contract, and prompt hash.
- Enhanced decision logs for accepted, rejected, model_failed, and transaction_failed runs using the same run envelope.
- WorldMindFlow integration that logs raw decisions for rejected output and validated decisions only for accepted output.

Do not implement:

- `world_tick_worker`, `ActorCommandWorker`, feed command execution, or task leasing.
- `WorldMemoryConsolidator` merge/supersession logic.
- Memory candidate persistence from director decisions.
- `world_summaries` generation or context compression.
- Any path where an LLM directly patches world state.

## Current State To Preserve

Phase 2 already created these Phase 3-adjacent files:

- `ui/src/server/domain/world/world-decision.ts`
- `ui/src/server/domain/world/world-decision-validator.ts`
- `ui/src/server/domain/world/world-context-builder.ts`
- `ui/src/server/domain/world/world-memory-repository.ts`
- `ui/src/server/domain/world/world-decision-log-repository.ts`
- `ui/src/server/ai/world-director.ts`
- `ui/src/server/flow/world-mind-flow.ts`

Treat them as starting points. Do not delete and recreate them unless the file is smaller and clearer after replacement.

## File Structure

Modify:

- `ui/src/server/domain/world/world-decision.ts`  
  Owns the spec-aligned structured output schema and exported inferred types.

- `ui/src/server/domain/world/world-decision-validator.ts`  
  Owns semantic validation after Zod parsing and before transaction commit.

- `ui/src/server/domain/world/world-decision-validator.test.ts`  
  Covers accepted decisions and each rejection class.

- `ui/src/server/domain/world/world-context-builder.ts`  
  Builds strict, layered, visibility-aware director prompts and returns context metadata.

- `ui/src/server/domain/world/world-context-builder.test.ts`  
  Covers strict world loading, ledger ordering, memory recall, ACL filtering, and prompt hash stability.

- `ui/src/server/domain/world/world-event-repository.ts`  
  Adds or verifies recent actor/world ledger helpers used by the context builder.

- `ui/src/server/domain/world/world-event-repository.test.ts`  
  Covers recent ledger helpers ordered by `sequence ASC`.

- `ui/src/server/domain/world/world-memory-repository.ts`  
  Keeps read-only recall behavior stable for director and actor scopes.

- `ui/src/server/domain/world/world-memory-repository.test.ts`  
  Covers empty recall, hidden director recall, actor ACL filtering, and superseded memory exclusion.

- `ui/src/server/ai/models.ts`  
  Verifies `worldDirector` maps to `WORLD_DIRECTOR_MODEL`.

- `ui/src/server/ai/chat.test.ts`  
  Keeps provider/model purpose coverage.

- `ui/src/server/ai/world-director.ts`  
  Adds a structured generation boundary with model metadata.

- `ui/src/server/ai/world-director.test.ts`  
  Tests schema, model purpose, and structured-output call parameters.

- `ui/src/server/flow/world-mind-flow.ts`  
  Uses the new decision contract, validator, context metadata, model metadata, and logging semantics.

- `ui/src/server/flow/world-mind-flow.test.ts`  
  Updates accepted/rejected/model_failed/transaction_failed tests for the Phase 3 contract.

---

### Task 1: Align The WorldMind Decision Contract With The Spec

**Files:**
- Modify: `ui/src/server/domain/world/world-decision.ts`
- Modify: `ui/src/server/domain/world/world-decision-validator.test.ts`
- Modify: `ui/src/server/flow/world-mind-flow.test.ts`

- [ ] **Step 1: Write failing schema tests for spec field names**

In `ui/src/server/domain/world/world-decision-validator.test.ts`, add this test near the schema tests:

```typescript
it("parses the spec-aligned decision field names", () => {
  const parsed = WorldMindDecisionSchema.parse({
    observations: ["The user greeted the guard."],
    intent: "dispatch_commands",
    events: [
      {
        clientEventId: "evt-1",
        type: "world_incident",
        actorIds: ["agent-default"],
        payload: {
          title: "A guard notices the user",
          description: "The guard pauses and studies the user.",
          tensionDelta: 0.05,
        },
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        summary: "The guard notices the user.",
      },
    ],
    commands: [
      {
        commandType: "speak_to_user",
        targetAgentId: "agent-default",
        priority: "normal",
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        actorInstruction: "Ask the user what business brings them here.",
        privateReason: null,
        cause: { type: "proposed_event", clientEventId: "evt-1" },
        payload: {},
        relatedEventSummary: "The guard notices the user.",
      },
    ],
    memories: [],
    nextTick: null,
  });

  expect(parsed.events).toHaveLength(1);
  expect(parsed.commands).toHaveLength(1);
  expect(parsed.memories).toEqual([]);
});
```

- [ ] **Step 2: Run the failing schema test**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-decision-validator.test.ts
```

Expected: fail because the current schema uses `proposedEvents`, `proposedCommands`, and `memoryCandidates`.

- [ ] **Step 3: Replace the schema exports with spec-aligned names**

In `ui/src/server/domain/world/world-decision.ts`, replace the current object schemas with this shape. Keep the import from `zod`.

```typescript
import { z } from "zod";

export const VisibilityScopeSchema = z.object({
  mode: z.enum(["public", "private", "hidden"]),
  visibleToActorIds: z.array(z.string()).default([]),
  visibleToUser: z.boolean().default(false),
});

export type VisibilityScopeDecision = z.infer<typeof VisibilityScopeSchema>;

export const CommandCauseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proposed_event"), clientEventId: z.string().min(1) }),
  z.object({ type: z.literal("committed_event"), eventId: z.string().min(1) }),
  z.object({ type: z.literal("source_action"), sourceActionId: z.string().min(1) }),
  z.object({ type: z.literal("director_no_event"), reasonCode: z.string().min(1) }),
]);

export type CommandCauseDecision = z.infer<typeof CommandCauseSchema>;

export const WorldMindIntentSchema = z.enum(["no_op", "advance_scene", "trigger_event", "dispatch_commands"]);

export const ProposedWorldEventSchema = z.object({
  clientEventId: z.string().min(1),
  type: z.enum([
    "world_incident",
    "character_action",
    "relationship_shift",
    "knowledge_reveal",
    "fact_correction",
    "arc_progress",
    "system_note",
  ]),
  payload: z.unknown(),
  visibility: VisibilityScopeSchema,
  actorIds: z.array(z.string()).default([]),
  locationKey: z.string().nullable().optional(),
  summary: z.string().min(1),
});

export type ProposedWorldEvent = z.infer<typeof ProposedWorldEventSchema>;

export const ProposedActorCommandSchema = z.object({
  commandType: z.enum(["speak_to_user", "move_location", "investigate", "remember", "publish_post", "initiate_event"]),
  targetAgentId: z.string().min(1),
  priority: z.enum(["low", "normal", "high"]),
  visibility: VisibilityScopeSchema,
  actorInstruction: z.string().min(1),
  privateReason: z.string().nullable(),
  cause: CommandCauseSchema,
  payload: z.unknown().default({}),
  relatedEventSummary: z.string().nullable().optional(),
});

export type ProposedActorCommand = z.infer<typeof ProposedActorCommandSchema>;

export const WorldMemoryCandidateSchema = z.object({
  subjectType: z.enum(["world", "arc", "faction", "location", "character", "user"]),
  subjectKey: z.string().min(1),
  memoryType: z.enum(["lore", "rule", "relationship", "secret", "unresolved_thread"]),
  canonicalKey: z.string().nullable(),
  content: z.string().min(1),
  visibility: VisibilityScopeSchema,
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  sourceEventId: z.string().nullable(),
});

export type WorldMemoryCandidate = z.infer<typeof WorldMemoryCandidateSchema>;

export const WorldMindDecisionSchema = z.object({
  observations: z.array(z.string().min(1)).max(6),
  intent: WorldMindIntentSchema,
  events: z.array(ProposedWorldEventSchema).max(3),
  commands: z.array(ProposedActorCommandSchema).max(5),
  memories: z.array(WorldMemoryCandidateSchema).max(8),
  nextTick: z
    .object({
      delayMs: z.number().min(30_000).max(86_400_000),
      reason: z.string().min(1),
    })
    .nullable(),
});

export type WorldMindDecision = z.infer<typeof WorldMindDecisionSchema>;
```

- [ ] **Step 4: Update test helpers to use the new field names**

In `world-decision-validator.test.ts` and `world-mind-flow.test.ts`, update helper decisions:

```typescript
function makeDecision(overrides: Partial<WorldMindDecision> = {}): WorldMindDecision {
  return {
    observations: [],
    intent: "dispatch_commands",
    events: [],
    commands: [],
    memories: [],
    nextTick: null,
    ...overrides,
  };
}
```

Replace these old names everywhere:

```text
proposedEvents -> events
proposedCommands -> commands
memoryCandidates -> memories
visibleToUser sibling on command -> visibility.visibleToUser
```

- [ ] **Step 5: Verify the contract tests pass**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-decision-validator.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/domain/world/world-decision.ts ui/src/server/domain/world/world-decision-validator.test.ts ui/src/server/flow/world-mind-flow.test.ts
git commit -m "feat(world): align director decision schema"
```

### Task 2: Harden The Director Decision Validator

**Files:**
- Modify: `ui/src/server/domain/world/world-decision-validator.ts`
- Modify: `ui/src/server/domain/world/world-decision-validator.test.ts`

- [ ] **Step 1: Add validator rejection tests**

Add tests to `world-decision-validator.test.ts` for these cases:

```typescript
it("rejects proposed event actor ids outside the active actor set", () => {
  const decision = makeDecision({
    events: [
      {
        clientEventId: "evt-1",
        type: "world_incident",
        actorIds: ["ghost-agent"],
        payload: { title: "Incident", description: "Unknown actor appears." },
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        summary: "Unknown actor appears.",
      },
    ],
  });

  const result = validateWorldMindDecision({ decision, activeAgentIds: ["agent-default"], hiddenFactSummaries: [] });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toContain("Event evt-1 references unknown actor: ghost-agent");
  }
});

it("rejects invalid world_incident payloads", () => {
  const decision = makeDecision({
    events: [
      {
        clientEventId: "evt-1",
        type: "world_incident",
        actorIds: [],
        payload: { title: "Missing description" },
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        summary: "Invalid incident.",
      },
    ],
  });

  const result = validateWorldMindDecision({ decision, activeAgentIds: [], hiddenFactSummaries: [] });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.some((error) => error.includes("world_incident payload"))).toBe(true);
  }
});

it("rejects knowledge_reveal events without a factKey", () => {
  const decision = makeDecision({
    events: [
      {
        clientEventId: "evt-1",
        type: "knowledge_reveal",
        actorIds: ["agent-default"],
        payload: { summary: "A secret is revealed." },
        visibility: { mode: "private", visibleToActorIds: ["agent-default"], visibleToUser: false },
        summary: "A secret is revealed.",
      },
    ],
  });

  const result = validateWorldMindDecision({ decision, activeAgentIds: ["agent-default"], hiddenFactSummaries: [] });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.some((error) => error.includes("knowledge_reveal payload"))).toBe(true);
  }
});

it("rejects public events that include hidden fact summaries", () => {
  const decision = makeDecision({
    events: [
      {
        clientEventId: "evt-1",
        type: "world_incident",
        actorIds: [],
        payload: { title: "Leak", description: "The queen ordered the fire." },
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        summary: "The queen ordered the fire.",
      },
    ],
  });

  const result = validateWorldMindDecision({
    decision,
    activeAgentIds: [],
    hiddenFactSummaries: ["The queen ordered the fire."],
  });

  expect(result.ok).toBe(false);
});

it("rejects a user action that creates more than one major event without a chain reaction", () => {
  const decision = makeDecision({
    events: [
      {
        clientEventId: "evt-1",
        type: "world_incident",
        actorIds: [],
        payload: { title: "First", description: "First major event." },
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        summary: "First major event.",
      },
      {
        clientEventId: "evt-2",
        type: "arc_progress",
        actorIds: [],
        payload: { patchType: "resolve_thread", threadKey: "thread-1", resolution: "Resolved." },
        visibility: { mode: "public", visibleToActorIds: [], visibleToUser: true },
        summary: "Second major event.",
      },
    ],
  });

  const result = validateWorldMindDecision({
    decision,
    activeAgentIds: [],
    hiddenFactSummaries: [],
    sourceType: "user_action",
  });

  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: Update the validator input type**

In `world-decision-validator.ts`, change the function input to include source type:

```typescript
export function validateWorldMindDecision(input: {
  decision: WorldMindDecision;
  activeAgentIds: string[];
  hiddenFactSummaries: string[];
  sourceType?: "user_action" | "scheduled_tick" | "system_trigger";
}): { ok: true; decision: WorldMindDecision } | { ok: false; errors: string[] } {
```

- [ ] **Step 3: Add payload schemas inside the validator module**

Add these Zod helpers near the top of `world-decision-validator.ts`:

```typescript
import { z } from "zod";
import type { WorldMindDecision, ProposedWorldEvent, ProposedActorCommand } from "./world-decision";

const WorldIncidentPayloadSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  tensionDelta: z.number().min(-1).max(1).optional(),
  stabilityDelta: z.number().min(-1).max(1).optional(),
  unresolved: z.boolean().optional(),
  factKey: z.string().min(1).optional(),
  chainReaction: z.boolean().optional(),
});

const KnowledgeRevealPayloadSchema = z.object({
  factKey: z.string().min(1),
  summary: z.string().min(1).optional(),
});

const CharacterActionPayloadSchema = z.object({
  action: z.enum(["move_location", "investigate", "remember", "speak", "initiate_event"]),
  locationKey: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
});

const RelationshipShiftPayloadSchema = z.object({
  targetAgentId: z.string().min(1).optional(),
  affinityDelta: z.number().min(-1).max(1).optional(),
  trustDelta: z.number().min(-1).max(1).optional(),
  tensionDelta: z.number().min(-1).max(1).optional(),
});

const ArcProgressPayloadSchema = z.object({
  patchType: z.enum(["resolve_thread", "advance_arc", "open_thread"]),
  threadKey: z.string().min(1).optional(),
  arcId: z.string().min(1).optional(),
  resolution: z.string().min(1).optional(),
  chainReaction: z.boolean().optional(),
});

const FactCorrectionPayloadSchema = z.object({
  factKey: z.string().min(1),
  correction: z.string().min(1),
  correctedEventId: z.string().min(1).optional(),
});

const SystemNotePayloadSchema = z.object({
  note: z.string().min(1),
});
```

- [ ] **Step 4: Implement validation rules**

Replace the validator body with logic equivalent to:

```typescript
const errors: string[] = [];
const eventIds = new Set<string>();
const activeAgents = new Set(input.activeAgentIds);

for (const event of decision.events) {
  if (eventIds.has(event.clientEventId)) {
    errors.push(`Duplicate clientEventId: ${event.clientEventId}`);
  }
  eventIds.add(event.clientEventId);

  for (const actorId of event.actorIds) {
    if (!activeAgents.has(actorId)) {
      errors.push(`Event ${event.clientEventId} references unknown actor: ${actorId}`);
    }
  }

  validateEventPayload(event, errors);
  rejectHiddenLeakage({
    text: `${event.summary}\n${JSON.stringify(event.payload)}`,
    visibilityMode: event.visibility.mode,
    hiddenFactSummaries: input.hiddenFactSummaries,
    errors,
    label: `Event ${event.clientEventId}`,
  });
}

for (const command of decision.commands) {
  if (!activeAgents.has(command.targetAgentId)) {
    errors.push(`Command references unknown agent: ${command.targetAgentId}`);
  }
  if (command.cause.type === "proposed_event" && !eventIds.has(command.cause.clientEventId)) {
    errors.push(`Command references unknown proposed event: ${command.cause.clientEventId}`);
  }
  rejectHiddenLeakage({
    text: command.actorInstruction,
    visibilityMode: command.visibility.mode,
    hiddenFactSummaries: input.hiddenFactSummaries,
    errors,
    label: `Command for ${command.targetAgentId}`,
  });
}

if ((input.sourceType ?? "user_action") === "user_action") {
  const majorEvents = decision.events.filter((event) => event.type === "world_incident" || event.type === "arc_progress");
  const hasChainReaction = decision.events.some((event) => {
    const payload = event.payload as { chainReaction?: unknown };
    return payload.chainReaction === true;
  });
  if (majorEvents.length > 1 && !hasChainReaction) {
    errors.push("User actions may create at most one major event unless an event is marked as a chain reaction");
  }
}

return errors.length === 0 ? { ok: true, decision } : { ok: false, errors };
```

Add helper functions in the same file:

```typescript
function validateEventPayload(event: ProposedWorldEvent, errors: string[]): void {
  const schemaByType = {
    world_incident: WorldIncidentPayloadSchema,
    character_action: CharacterActionPayloadSchema,
    relationship_shift: RelationshipShiftPayloadSchema,
    knowledge_reveal: KnowledgeRevealPayloadSchema,
    fact_correction: FactCorrectionPayloadSchema,
    arc_progress: ArcProgressPayloadSchema,
    system_note: SystemNotePayloadSchema,
  } satisfies Record<ProposedWorldEvent["type"], z.ZodTypeAny>;

  const result = schemaByType[event.type].safeParse(event.payload);
  if (!result.success) {
    errors.push(`${event.type} payload for ${event.clientEventId} is invalid: ${result.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
  }
}

function rejectHiddenLeakage(input: {
  text: string;
  visibilityMode: "public" | "private" | "hidden";
  hiddenFactSummaries: string[];
  errors: string[];
  label: string;
}): void {
  if (input.visibilityMode === "hidden") {
    return;
  }
  const normalizedText = input.text.toLowerCase();
  for (const summary of input.hiddenFactSummaries) {
    const normalizedSummary = summary.trim().toLowerCase();
    if (normalizedSummary.length >= 8 && normalizedText.includes(normalizedSummary)) {
      input.errors.push(`${input.label} leaks hidden fact: ${summary}`);
    }
  }
}
```

- [ ] **Step 5: Run validator tests**

Run:

```bash
cd ui && npm run test:run -- src/server/domain/world/world-decision-validator.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/server/domain/world/world-decision-validator.ts ui/src/server/domain/world/world-decision-validator.test.ts
git commit -m "feat(world): validate director decisions"
```

### Task 3: Build A Layered Director Context

**Files:**
- Modify: `ui/src/server/domain/world/world-context-builder.ts`
- Modify: `ui/src/server/domain/world/world-context-builder.test.ts`
- Modify: `ui/src/server/domain/world/world-event-repository.ts`
- Modify: `ui/src/server/domain/world/world-event-repository.test.ts`
- Modify: `ui/src/server/domain/world/world-memory-repository.test.ts`

- [ ] **Step 1: Add event repository coverage for recent actor ledger**

In `world-event-repository.test.ts`, ensure this assertion exists:

```typescript
const recent = events.listRecentForActor({ userId: "u001", worldId: "myworld", agentId: "alice", limit: 2 });
expect(recent.map((event) => event.sequence)).toEqual([2, 4]);
expect(recent.every((event) => event.actorIds.includes("alice"))).toBe(true);
```

If the exact sequence setup differs, keep the assertion equivalent: limited actor events must be returned in ascending `sequence` order.

- [ ] **Step 2: Add empty world memory recall tests**

In `world-memory-repository.test.ts`, add:

```typescript
it("returns an empty list when no director memories exist", () => {
  const repo = new WorldMemoryRepository(createTestDatabase());

  expect(repo.recallForDirector({ userId: "u001", worldId: "default", subjectType: "world" })).toEqual([]);
});

it("returns an empty list when no actor memories exist", () => {
  const repo = new WorldMemoryRepository(createTestDatabase());

  expect(
    repo.recallForActor({
      userId: "u001",
      worldId: "default",
      agentId: "agent-default",
      subjectType: "world",
    }),
  ).toEqual([]);
});
```

- [ ] **Step 3: Add context builder tests for layered sections**

In `world-context-builder.test.ts`, add a test that creates:

- a world with lore and constraints,
- a latest snapshot with public and hidden facts,
- one character state,
- one public world event,
- one actor-specific event,
- one hidden event,
- one public world memory,
- one hidden world memory.

Assert:

```typescript
expect(context.system).toContain("Output contract");
expect(context.prompt).toContain("## Immutable Canon");
expect(context.prompt).toContain("## Runtime Snapshot");
expect(context.prompt).toContain("## Actor Slice");
expect(context.prompt).toContain("## Recent World Events");
expect(context.prompt).toContain("## Retrieved World Memory");
expect(context.prompt).toContain("## Current Source");
expect(context.prompt).toContain("## Output Contract");
expect(context.prompt).toContain("public world memory");
expect(context.prompt).not.toContain("hidden director memory");
expect(context.hiddenFactSummaries).toContain("hidden director memory");
```

- [ ] **Step 4: Keep strict world loading**

Do not use `WorldRepository.getDefault()` or fallback to `"default"` in `buildWorldDirectorContext`. The existing behavior:

```typescript
const world = worldRepo.get(worldId);
if (!world) {
  throw new Error(`World not found: ${worldId}`);
}
```

must remain.

- [ ] **Step 5: Update the context builder return value**

Ensure `DirectorContext` in `ui/src/server/domain/world/types.ts` stays:

```typescript
export interface DirectorContext {
  system: string;
  prompt: string;
  promptContextHash: string;
  hiddenFactSummaries: string[];
  activeAgentIds: string[];
}
```

- [ ] **Step 6: Rework `buildWorldDirectorContext` sections**

In `world-context-builder.ts`, make `buildPrompt` produce these sections in this order:

```text
## Immutable Canon
## Runtime Snapshot
## Actor Slice
## Recent World Events
## Recent Actor Events
## Retrieved World Memory
## Current Source
## Output Contract
```

Use `eventRepo.listRecentForWorld({ limit: 24 })` and, when `sourceInput?.targetAgentId` or `targetAgentId` is present, `eventRepo.listRecentForActor({ limit: 8 })`.

The output contract section must contain the exact field names:

```text
Return JSON matching WorldMindDecision:
- observations: string[], max 6
- intent: no_op | advance_scene | trigger_event | dispatch_commands
- events: ProposedWorldEvent[], max 3
- commands: ProposedActorCommand[], max 5
- memories: WorldMemoryCandidate[], max 8
- nextTick: { delayMs, reason } | null
Do not include statePatch.
Commands are intent records, not facts.
```

- [ ] **Step 7: Enforce actor-facing memory filtering**

When `targetAgentId` is set, use only `memoryRepo.recallForActor(...)` for prompt memories. Hidden memories must still be included in `hiddenFactSummaries` by separately calling `recallForDirector(...)`.

- [ ] **Step 8: Run context and repository tests**

Run:

```bash
cd ui && npm run test:run -- \
  src/server/domain/world/world-event-repository.test.ts \
  src/server/domain/world/world-memory-repository.test.ts \
  src/server/domain/world/world-context-builder.test.ts
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add ui/src/server/domain/world/world-context-builder.ts ui/src/server/domain/world/world-context-builder.test.ts ui/src/server/domain/world/world-event-repository.ts ui/src/server/domain/world/world-event-repository.test.ts ui/src/server/domain/world/world-memory-repository.test.ts ui/src/server/domain/world/types.ts
git commit -m "feat(world): build layered director context"
```

### Task 4: Add Structured Director Metadata

**Files:**
- Modify: `ui/src/server/ai/world-director.ts`
- Create: `ui/src/server/ai/world-director.test.ts`
- Modify: `ui/src/server/ai/models.ts`
- Modify: `ui/src/server/ai/chat.test.ts`

- [ ] **Step 1: Add world director wrapper tests**

Create `ui/src/server/ai/world-director.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("./structured-output", () => ({
  withStructuredOutput: vi.fn(),
}));

vi.mock("./models", () => ({
  getActiveProviderInfo: vi.fn(() => ({ provider: "minimax", model: "director-model-v1" })),
}));

const { withStructuredOutput } = await import("./structured-output");
const { generateWorldDecision } = await import("./world-director");

describe("generateWorldDecision", () => {
  it("uses structured output with the worldDirector purpose and returns model metadata", async () => {
    vi.mocked(withStructuredOutput).mockResolvedValueOnce({
      observations: ["ok"],
      intent: "no_op",
      events: [],
      commands: [],
      memories: [],
      nextTick: null,
    });

    const result = await generateWorldDecision({ system: "system", prompt: "prompt" });

    expect(withStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "worldDirector",
        system: "system",
        prompt: "prompt",
        temperature: 0.4,
      }),
    );
    expect(result.modelProvider).toBe("minimax");
    expect(result.modelName).toBe("director-model-v1");
    expect(result.rawDecisionJson).toContain("\"intent\":\"no_op\"");
  });
});
```

- [ ] **Step 2: Update the director generation type**

In `world-director.ts`, replace the current return type with:

```typescript
import { getActiveProviderInfo } from "./models";
import { withStructuredOutput } from "./structured-output";
import { WorldMindDecisionSchema, type WorldMindDecision } from "@/server/domain/world/world-decision";

export interface GeneratedWorldDecision {
  decision: WorldMindDecision;
  rawDecisionJson: string;
  modelProvider: string;
  modelName: string;
}

export type GenerateWorldDecision = (input: { system: string; prompt: string }) => Promise<GeneratedWorldDecision>;

export const generateWorldDecision: GenerateWorldDecision = async ({ system, prompt }) => {
  const provider = getActiveProviderInfo();
  const decision = await withStructuredOutput({
    schema: WorldMindDecisionSchema,
    purpose: "worldDirector",
    system,
    prompt,
    temperature: 0.4,
  });

  return {
    decision,
    rawDecisionJson: JSON.stringify(decision),
    modelProvider: provider.provider,
    modelName: provider.model,
  };
};
```

- [ ] **Step 3: Keep model purpose tests passing**

`ui/src/server/ai/models.ts` should already include:

```typescript
export type ModelPurpose = "chat" | "memory" | "agentCreator" | "worldCreator" | "feed" | "worldDirector";
```

and:

```typescript
worldDirector: "WORLD_DIRECTOR_MODEL",
```

in `purposeEnvKeyByPurpose`.

`ui/src/server/ai/chat.test.ts` should include:

```typescript
it("uses WORLD_DIRECTOR_MODEL for the world director purpose", () => {
  stubProviderEnv({
    AI_PROVIDER: "minimax",
    CHAT_MODEL: "MiniMax-M3",
    WORLD_DIRECTOR_MODEL: "director-model-v1",
    MINIMAX_API_KEY: "sk-test",
    MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
  });
  getLanguageModel("worldDirector");
  expect(openaiChatSpy).toHaveBeenCalledWith("director-model-v1");
});
```

- [ ] **Step 4: Run AI tests**

Run:

```bash
cd ui && npm run test:run -- src/server/ai/chat.test.ts src/server/ai/world-director.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/server/ai/models.ts ui/src/server/ai/chat.test.ts ui/src/server/ai/world-director.ts ui/src/server/ai/world-director.test.ts
git commit -m "feat(world): generate structured director decisions"
```

### Task 5: Integrate Phase 3 Contract Into WorldMindFlow

**Files:**
- Modify: `ui/src/server/flow/world-mind-flow.ts`
- Modify: `ui/src/server/flow/world-mind-flow.test.ts`
- Modify: `ui/src/server/domain/world/world-decision-log-repository.test.ts`

- [ ] **Step 1: Update flow tests to use `GeneratedWorldDecision`**

In `world-mind-flow.test.ts`, change fake generators from:

```typescript
generateDecision: async () => decision,
```

to:

```typescript
generateDecision: async () => ({
  decision,
  rawDecisionJson: JSON.stringify(decision),
  modelProvider: "test",
  modelName: "test-director",
}),
```

- [ ] **Step 2: Add rejected decision log assertions**

In the rejected decision test, assert:

```typescript
expect(logs[0].rawDecisionJson).toContain("\"commands\"");
expect(logs[0].validatedDecisionJson).toBeNull();
expect(logs[0].validationErrorsJson.length).toBeGreaterThan(0);
expect(logs[0].modelProvider).toBe("test");
expect(logs[0].modelName).toBe("test-director");
```

- [ ] **Step 3: Add accepted decision log assertions**

In the accepted decision test, assert:

```typescript
expect(logs[0].rawDecisionJson).toContain("\"intent\"");
expect(logs[0].validatedDecisionJson).toContain("\"events\"");
expect(logs[0].promptContextHash).toMatch(/^[a-f0-9]{64}$/);
expect(logs[0].modelProvider).toBe("test");
expect(logs[0].modelName).toBe("test-director");
```

- [ ] **Step 4: Update `WorldMindContext` for generation results**

In `world-mind-flow.ts`, keep the context shape but change generation handling:

```typescript
let decision: WorldMindDecision;
let rawDecisionJson: string | null = null;
let modelProvider = "mock";
let modelName = "mock";

if (ctx.decision) {
  decision = ctx.decision;
  rawDecisionJson = JSON.stringify(ctx.decision);
} else {
  try {
    const generator = ctx.generateDecision ?? generateWorldDecision;
    const generated = await generator({ system: dirContext.system, prompt: dirContext.prompt });
    decision = generated.decision;
    rawDecisionJson = generated.rawDecisionJson;
    modelProvider = generated.modelProvider;
    modelName = generated.modelName;
  } catch (err) {
    return commitFailedPath({
      db,
      envelope,
      validationStatus: "model_failed",
      dirContext,
      ctx,
      characterStates,
      modelProvider,
      modelName,
      rawDecisionJson: null,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
```

- [ ] **Step 5: Pass source type into validation**

Update the validator call:

```typescript
const validation = validateWorldMindDecision({
  decision,
  activeAgentIds,
  hiddenFactSummaries: dirContext.hiddenFactSummaries,
  sourceType: envelope.sourceType,
});
```

- [ ] **Step 6: Replace all old decision field names in flow code**

In `world-mind-flow.ts`, replace:

```text
decision.proposedEvents -> decision.events
decision.proposedCommands -> decision.commands
decision.memoryCandidates -> decision.memories
cmd.visibleToUser -> cmd.visibility.visibleToUser
```

In command visibility normalization, call:

```typescript
visibility: normalizeVisibility(cmd.visibility),
```

- [ ] **Step 7: Preserve raw rejected output and accepted validated output**

Update `commitAcceptedPath` input to include `modelProvider`, `modelName`, and `rawDecisionJson`. Insert accepted logs with:

```typescript
rawDecisionJson,
validatedDecisionJson: JSON.stringify(decision),
validationStatus: "accepted",
validationErrorsJson: [],
modelProvider,
modelName,
```

Update rejected `commitFailedPath` calls with:

```typescript
rawDecisionJson,
modelProvider,
modelName,
validationErrors: validation.errors,
```

Insert rejected logs with:

```typescript
rawDecisionJson,
validatedDecisionJson: null,
validationStatus: "rejected",
validationErrorsJson: validationErrors ?? [],
modelProvider,
modelName,
```

For `model_failed`, use `rawDecisionJson: null`, `validatedDecisionJson: null`, `errorCode: "MODEL_ERROR"`, and the thrown error message.

For `transaction_failed`, use `rawDecisionJson` if generation succeeded, `validatedDecisionJson: null`, and `errorCode: "TRANSACTION_FAILED"`.

- [ ] **Step 8: Keep memory candidates read-only**

Do not persist `decision.memories` in Phase 3. Add this comment in the accepted path before the decision log:

```typescript
// Phase 3 only logs director memory candidates. Consolidation and persistence
// are Phase 4 work and must not affect the core transaction.
```

- [ ] **Step 9: Run flow and decision log tests**

Run:

```bash
cd ui && npm run test:run -- \
  src/server/flow/world-mind-flow.test.ts \
  src/server/domain/world/world-decision-log-repository.test.ts
```

Expected: pass.

- [ ] **Step 10: Commit**

```bash
git add ui/src/server/flow/world-mind-flow.ts ui/src/server/flow/world-mind-flow.test.ts ui/src/server/domain/world/world-decision-log-repository.test.ts
git commit -m "feat(world): wire structured director into world mind flow"
```

### Task 6: Final Phase 3 Verification

**Files:**
- No code changes unless verification reveals a regression.

- [ ] **Step 1: Run the focused Phase 3 suite**

Run:

```bash
cd ui && npm run test:run -- \
  src/server/domain/world/world-decision-validator.test.ts \
  src/server/domain/world/world-context-builder.test.ts \
  src/server/domain/world/world-event-repository.test.ts \
  src/server/domain/world/world-memory-repository.test.ts \
  src/server/domain/world/world-decision-log-repository.test.ts \
  src/server/ai/chat.test.ts \
  src/server/ai/world-director.test.ts \
  src/server/flow/world-mind-flow.test.ts
```

Expected: pass.

- [ ] **Step 2: Run the full unit suite**

Run:

```bash
cd ui && npm run test:run
```

Expected: pass.

- [ ] **Step 3: Run the build**

Run:

```bash
cd ui && npm run build
```

Expected: pass.

- [ ] **Step 4: Check formatting-sensitive whitespace**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Commit any verification-only fixes**

If verification required fixes, commit them:

```bash
git add ui/src/server/domain/world ui/src/server/ai ui/src/server/flow
git commit -m "fix(world): stabilize phase 3 director checks"
```

If no fixes were required, do not create an empty commit.

---

## Acceptance Criteria

- `WorldMindDecisionSchema` accepts `observations`, `intent`, `events`, `commands`, `memories`, and `nextTick`.
- The schema rejects output that exceeds the event, command, observation, memory, or next tick limits.
- `WORLD_DIRECTOR_MODEL` is used for `worldDirector` model selection.
- `generateWorldDecision` calls AI SDK structured output and returns model provider/name metadata.
- The validator rejects duplicate event ids, invalid actor ids, invalid command causes, invalid typed payloads, over-limit major user events, and hidden fact leakage.
- The context builder never falls back to the `default` world in WorldMind mode.
- The context builder reads recent ledger rows by `sequence`, not `created_at`.
- Actor-facing context excludes hidden events and hidden memory.
- Director hidden summaries remain available to the validator.
- Accepted runs log raw and validated decision JSON.
- Rejected runs log raw decision JSON, validation errors, and no validated decision JSON.
- Model failures log `model_failed` with no raw or validated decision JSON.
- Transaction failures roll back primary world writes and write a best-effort `transaction_failed` log.
- Phase 3 does not persist director memory candidates or execute actor commands.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-29-worldmind-phase-3.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
