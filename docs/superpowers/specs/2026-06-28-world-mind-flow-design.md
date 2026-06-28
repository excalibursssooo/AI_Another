# WorldMind Flow Design

Date: 2026-06-28

## Goal

Build a long-running, closed-loop world director for Another-World. The director is the system-level mind of a virtual otherworld: it observes world state, interprets user actions, advances events, dispatches commands to characters, preserves long-term world memory, and keeps the world internally consistent over time.

The first version must fit the current Next.js + TypeScript + SQLite architecture. It must extend the existing lightweight Flow Runner instead of replacing it.

## Non-Goals

The first version will not implement a full simulation engine with economy, geography pathfinding, combat, calendars, or multi-process actor autonomy. It will not let language models directly mutate database state. It will not replace the existing chat, memory, feed, world, or agent flows.

The first version must prove the core loop:

1. A user action can affect world state.
2. The world director can create committed world events.
3. The world director can dispatch commands to any character in the same world.
4. Character-facing replies and posts can be driven by director commands.
5. World memory can influence future director decisions.
6. World state can be replayed from committed events.

## Current System Fit

The existing codebase already has the right foundation:

- `server/flow/runner.ts` provides a simple linear `Flow<TContext>`.
- `server/flow/chat-flow.ts` handles agent chat, memory recall, live state update, persistence, and async memory extraction.
- `server/flow/feed-flow.ts` generates character posts and can be reused as an outward signal for world events.
- `server/flow/memory-extract-flow.ts` and `MemoryConsolidator` provide a pattern for extracting and consolidating long-term facts.
- `domain/chat/task-repository.ts` provides a basic task queue.
- SQLite is already the default persistence layer.

The new world layer should live beside the current chat layer:

```text
ui/src/server/domain/world/
  world-event-repository.ts
  world-state-repository.ts
  character-state-repository.ts
  actor-command-repository.ts
  world-memory-repository.ts
  world-reducer.ts
  world-context-builder.ts

ui/src/server/flow/
  world-mind-flow.ts
  world-interaction-flow.ts
  world-tick-worker.ts
```

The existing `domain/chat/repositories.ts` is already broad. New world concepts should not be added to that file except through narrow adapter calls.

## Core Architecture

The central rule is:

```text
LLM proposes. Code validates. Events commit. Reducer mutates state.
```

The world director must never directly update `world_state`, `character_states`, or memories. It emits a structured `WorldMindDecision`. The system validates that decision, writes committed events and commands transactionally, and applies deterministic reducers to update snapshots.

The control loop is:

```text
WorldInput
  -> Load runtime state
  -> Build director context
  -> Generate structured decision
  -> Validate decision
  -> Commit event ledger entries
  -> Apply deterministic world reducer
  -> Dispatch actor commands
  -> Consolidate world memory
  -> Schedule next tick
```

This makes the world debuggable, replayable, and recoverable after failures.

## Entry Points

### User Interaction

User messages should pass through `WorldInteractionFlow` before normal character chat.

```text
POST /api/chat
  -> WorldInteractionFlow(source = "user_action")
    -> WorldMindFlow
    -> Actor command lookup for selected character
    -> ChatFlow or CharacterCommandFlow
    -> SSE response
```

For the first version, `ChatFlow` can remain the response generator. The integration point is prompt construction: if a pending actor command exists for the selected agent, the command is injected into the chat prompt as a high-priority world directive.

### Background Tick

The world also advances without user input through scheduled tasks.

```text
task kind: world_tick
payload: { worldId, userId, reason, scheduledTick }
```

`world-tick-worker.ts` drains these tasks and runs `WorldMindFlow(source = "scheduled_tick")`.

### System Trigger

World creation, role creation, feed interaction, and debug endpoints may enqueue system triggers.

```text
task kind: world_trigger
payload: { worldId, userId, triggerType, payload }
```

This gives the director a uniform way to react to new characters, newly created worlds, and feed-triggered topics.

## WorldMind Flow

`WorldMindFlow` should be a linear flow at first:

```text
LoadWorldRuntime
LoadWorldStateSnapshot
LoadActiveActors
LoadRecentEventLedger
RecallWorldMemory
BuildDirectorContext
GenerateDirectorDecision
ValidateDirectorDecision
CommitWorldEvents
ApplyWorldReducer
DispatchActorCommands
ConsolidateWorldMemory
ScheduleNextTick
```

### LoadWorldRuntime

Loads the `WorldRecord` from the existing `WorldRepository`. If no world exists, fail fast. The director must not silently fall back to `default`, because hidden cross-world mutation is worse than a failed tick.

### LoadWorldStateSnapshot

Loads the latest snapshot for the target `worldId` and `userId`. If no snapshot exists, create an initial snapshot from the persisted world record:

```ts
WorldStateSnapshot {
  worldId: string;
  userId: string;
  tick: number;
  clock: {
    day: number;
    phase: "dawn" | "day" | "dusk" | "night";
    updatedAt: number;
  };
  stability: number;
  tension: number;
  activeArcIds: string[];
  publicFacts: WorldFact[];
  hiddenFacts: WorldFact[];
  unresolvedEventIds: string[];
  createdAt: number;
  updatedAt: number;
}
```

First-version state should stay compact. Large historical detail belongs in the event ledger and world memory, not the snapshot.

### LoadActiveActors

Loads active agents in the world and their `CharacterState`.

```ts
CharacterState {
  worldId: string;
  userId: string;
  agentId: string;
  locationKey: string;
  currentGoal: string;
  emotionalState: {
    label: string;
    intensity: number;
  };
  relationshipToUser: {
    affinity: number;
    trust: number;
    tension: number;
  };
  knowledgeKeys: string[];
  activeCommandId: string | null;
  lastActedAt: number | null;
  updatedAt: number;
}
```

If a character has no state yet, create one from the existing agent profile with conservative defaults.

### LoadRecentEventLedger

Loads committed events for the same world/user scope.

First-version limits:

- Last 24 committed events.
- Last 8 events involving the selected agent.
- Last 8 unresolved events.

Events beyond this window are retrieved through world memory or summaries.

### RecallWorldMemory

Uses a dedicated `WorldMemoryRepository`, not the existing chat-scoped `MemoryRepository`.

World memory stores durable facts:

```ts
WorldMemory {
  id: string;
  worldId: string;
  userId: string;
  subjectType: "world" | "arc" | "faction" | "location" | "character" | "user";
  subjectKey: string;
  memoryType: "lore" | "event" | "rule" | "relationship" | "secret" | "unresolved_thread";
  canonicalKey: string | null;
  content: string;
  visibility: "public" | "private" | "hidden";
  importance: number;
  confidence: number;
  validFromTick: number;
  supersededBy: string | null;
  embeddingJson: string | null;
  embeddingQuality: string | null;
  createdAt: number;
  updatedAt: number;
}
```

World memory is queried by:

- current user action text,
- active arc names,
- involved actor names,
- unresolved event topics,
- pending command reasons.

### BuildDirectorContext

The director context is deliberately layered:

```text
1. Immutable canon
2. Runtime snapshot
3. Actor slice
4. Recent committed event ledger
5. Retrieved world memory
6. Current input or tick reason
7. Output contract and hard constraints
```

The context builder owns compression and budget limits. Flow nodes must not assemble prompts ad hoc.

Recommended first-version budget:

- Canon and world rules: 1200 tokens.
- Runtime snapshot: 1000 tokens.
- Actor slice: 1200 tokens.
- Recent events: 1500 tokens.
- Retrieved memory: 1200 tokens.
- Current input: uncropped unless it exceeds a hard request limit.
- Output schema instructions: fixed and short.

The context builder may summarize recent events into `world_summaries` once the event ledger grows, but it must not summarize the current user action or immutable canon.

### GenerateDirectorDecision

The director uses AI SDK structured output with a new model purpose:

```ts
type ModelPurpose =
  | "chat"
  | "memory"
  | "agentCreator"
  | "worldCreator"
  | "feed"
  | "worldDirector";
```

The decision schema:

```ts
WorldMindDecision {
  observations: string[];
  intent:
    | "no_op"
    | "advance_scene"
    | "trigger_event"
    | "dispatch_commands"
    | "update_state";
  events: ProposedWorldEvent[];
  commands: ProposedActorCommand[];
  statePatch: ProposedWorldStatePatch | null;
  memories: WorldMemoryCandidate[];
  nextTick: {
    delayMs: number;
    reason: string;
  } | null;
}
```

Hard output limits:

- `observations`: max 6.
- `events`: max 3.
- `commands`: max 5.
- `memories`: max 8.
- `delayMs`: 30 seconds to 24 hours.

### ValidateDirectorDecision

Validation must reject unsafe or incoherent decisions before commit.

Rules:

- All `agentId` values must exist and belong to the target world.
- Events must use known event types.
- Commands must use known command types.
- Hidden facts cannot be included in public commands or feed content.
- `statePatch` cannot mutate immutable canon.
- `statePatch` cannot remove committed event references.
- Event count and command count must stay within schema limits.
- A user action may create at most one major event unless explicitly marked as a chain reaction.
- Scheduled ticks may create zero events; no-op is valid.
- Every command must reference either a committed event id, proposed event client id, or a clear reason.

If validation fails, the flow writes a rejected decision log and falls back to `no_op`; it does not partially commit.

### CommitWorldEvents

Events are the source of truth.

```ts
WorldEvent {
  id: string;
  worldId: string;
  userId: string;
  tick: number;
  type:
    | "user_action"
    | "world_incident"
    | "character_action"
    | "relationship_shift"
    | "knowledge_reveal"
    | "arc_progress"
    | "system_note";
  visibility: "public" | "private" | "hidden";
  actorIds: string[];
  locationKey: string | null;
  payload: unknown;
  summary: string;
  causedByEventId: string | null;
  causedByUserActionId: string | null;
  idempotencyKey: string;
  status: "committed" | "rejected" | "superseded";
  createdAt: number;
}
```

`idempotencyKey` is required. For user actions:

```text
worldId:userId:source:userActionId:proposedEventClientId
```

For scheduled ticks:

```text
worldId:userId:scheduledTick:tick:proposedEventClientId
```

The repository enforces uniqueness on `idempotency_key`. This prevents duplicate events when tasks retry.

### ApplyWorldReducer

Reducers are deterministic TypeScript functions. They consume committed events and validated patches.

Reducer responsibilities:

- Increment world tick.
- Update clock phase.
- Update `stability` and `tension`.
- Add or resolve unresolved events.
- Update public and hidden facts.
- Update active arcs.
- Update character states.
- Record which event ids affected each snapshot.

Reducer output:

```ts
WorldReductionResult {
  worldSnapshot: WorldStateSnapshot;
  characterStates: CharacterState[];
  appliedEventIds: string[];
  warnings: string[];
}
```

Reducers must be pure with respect to inputs. Repository code persists the result inside a transaction.

### DispatchActorCommands

Commands translate world-level intent into actor-level work.

```ts
ActorCommand {
  id: string;
  worldId: string;
  userId: string;
  targetAgentId: string;
  commandType:
    | "speak_to_user"
    | "move_location"
    | "investigate"
    | "remember"
    | "publish_post"
    | "initiate_event";
  priority: "low" | "normal" | "high";
  visibility: "public" | "private" | "hidden";
  payload: unknown;
  reason: string;
  relatedEventId: string | null;
  status: "pending" | "claimed" | "done" | "failed" | "expired";
  runAfter: number;
  expiresAt: number | null;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
}
```

First-version command handling:

- `speak_to_user`: injected into the selected character's chat prompt.
- `publish_post`: calls or enqueues the existing feed generation flow with director-provided topic and event context.
- `remember`: writes a world memory candidate or character-scoped memory.
- `move_location`, `investigate`, and `initiate_event`: update character state or enqueue a future `world_trigger`.

### ConsolidateWorldMemory

The director can output `WorldMemoryCandidate` records, but consolidation must be deterministic.

```ts
WorldMemoryCandidate {
  subjectType: "world" | "arc" | "faction" | "location" | "character" | "user";
  subjectKey: string;
  memoryType: "lore" | "event" | "rule" | "relationship" | "secret" | "unresolved_thread";
  canonicalKey?: string;
  content: string;
  visibility: "public" | "private" | "hidden";
  importance: number;
  confidence: number;
}
```

Consolidation mirrors the existing memory consolidator:

- Empty content is skipped.
- Similar semantic memories are merged.
- Contradictory high-confidence facts supersede old facts.
- Hidden memories remain hidden during prompt construction unless the target actor is allowed to know them.
- Every created or merged memory references a source event id or task id.

### ScheduleNextTick

If `nextTick` is present, enqueue a `world_tick` task. The scheduler clamps delay:

- Minimum: 30 seconds.
- Default if absent: no automatic tick.
- Maximum: 24 hours.

For the first version, worlds should only auto-schedule a next tick after a committed event or unresolved arc. A quiet world should not consume background work forever.

## WorldInteractionFlow

`WorldInteractionFlow` wraps user-facing chat. It creates a `user_action` event, asks the director to interpret it, then hands any relevant actor command to chat generation.

Flow:

```text
ValidateInput
RecordUserActionEvent
RunWorldMind
LoadSelectedActorCommand
RunChatFlowWithWorldDirective
MarkActorCommandDone
ReturnChatResult
```

This keeps the existing SSE route simple while introducing world causality.

If the director returns `no_op`, chat proceeds normally. If the director commits an event, the assistant response should know the event happened only if the selected character has visibility.

## Context Visibility Rules

Visibility is the hardest correctness boundary.

World director can see all world facts. Characters cannot.

Prompt builders must enforce:

- Public facts are visible to everyone.
- Private facts are visible only to listed actors or the user.
- Hidden facts are visible only to the director unless explicitly revealed by a committed event.
- A character cannot act on a hidden fact by accident.
- A command with hidden reason must provide a separate public-facing instruction if it reaches a character prompt.

Example:

```text
Hidden fact: The queen ordered the fire.
Public event: The port warehouse burned at night.
Command to guard: Ask the user what they saw near the port.
The guard prompt must not include that the queen ordered the fire.
```

## Database Changes

Add these tables in runtime initialization and Drizzle schema:

```text
world_state_snapshots
character_states
world_events
actor_commands
world_memories
world_decision_logs
world_summaries
```

### world_state_snapshots

Stores the latest compact state and optional historical snapshots.

Indexes:

- `(user_id, world_id, tick DESC)`
- unique `(user_id, world_id, tick)`

### character_states

Stores one row per user/world/agent.

Indexes:

- unique `(user_id, world_id, agent_id)`
- `(user_id, world_id, updated_at DESC)`

### world_events

Stores immutable event ledger entries.

Indexes:

- unique `(idempotency_key)`
- `(user_id, world_id, tick, created_at)`
- `(user_id, world_id, status, created_at DESC)`

### actor_commands

Stores director commands.

Indexes:

- unique `(idempotency_key)`
- `(user_id, world_id, target_agent_id, status, priority, run_after)`
- `(status, run_after)`

### world_memories

Stores durable world facts with embedding metadata.

Indexes:

- `(user_id, world_id, subject_type, subject_key)`
- `(user_id, world_id, visibility, updated_at DESC)`
- optional FTS5 table for `content`

### world_decision_logs

Stores raw structured decisions and validation outcomes for observability.

This table is append-only and can be pruned later.

### world_summaries

Stores compressed summaries of older event windows.

The first version can create this table without automatic summarization. Summarization can be added when event volume justifies it.

## Task Queue Requirements

The existing `tasks` table needs small but important extensions before background world ticks are reliable:

```text
idempotency_key TEXT
locked_at INTEGER
lock_expires_at INTEGER
max_attempts INTEGER NOT NULL DEFAULT 3
next_attempt_at INTEGER
```

Required behavior:

- `enqueue` accepts an optional idempotency key.
- duplicate idempotency keys return the existing task.
- `claimNext` only claims unlocked or expired-lock tasks.
- failed tasks retry with bounded backoff until `max_attempts`.
- permanently failed tasks remain inspectable.

Without this, a long-running world can duplicate events or stall after a transient failure.

## Error Handling

World ticks must prefer safe no-op over partial mutation.

Rules:

- If model generation fails, log a failed decision and do not change world state.
- If validation fails, commit no proposed events and write a rejected decision log.
- If event commit succeeds but reducer fails, the transaction must roll back both event and reducer state.
- If command dispatch fails after event commit, mark the decision partially failed and enqueue a repair task.
- If memory consolidation fails, keep committed events and state, then log memory failure; memory is secondary.

## Safety and Product Boundaries

The existing safety check in chat remains required. WorldMind must not bypass it.

Additional constraints:

- The director must not create events that instruct self-harm, real-world illegal action, or manipulation of the user.
- World events can be fictional and dramatic, but user-facing output must preserve user safety.
- Character autonomy is fictional. The product should not claim that characters are conscious or independently alive.
- Hidden world facts are allowed, but user personal data must remain scoped to that user.

## Testing Strategy

### Unit Tests

- `world-reducer.test.ts`: replay deterministic events into expected snapshots.
- `world-context-builder.test.ts`: visibility filtering and token-budget truncation.
- `world-decision-validator.test.ts`: rejects invalid agents, hidden leakage, over-limit events, invalid patches.
- `world-event-repository.test.ts`: idempotent inserts and transaction behavior.
- `actor-command-repository.test.ts`: command claim, expiration, idempotency.
- `world-memory-repository.test.ts`: visibility, merge, supersede, FTS recall.

### Flow Tests

- `world-mind-flow.test.ts`: user action creates event, command, state update, memory, next tick.
- `world-interaction-flow.test.ts`: selected actor receives only visible command context.
- `world-tick-worker.test.ts`: tick task advances unresolved event and schedules next tick.

### Integration Tests

- Chat route with world layer enabled still returns SSE done event.
- A hidden event is not visible in selected character response.
- Retried tick task does not create duplicate world events.
- Snapshot can be rebuilt from committed event ledger.

## Migration Strategy

Use feature flags:

```env
ENABLE_WORLD_MIND=false
ENABLE_WORLD_TICKS=false
WORLD_DIRECTOR_MODEL=
```

Rollout:

1. Add schema, repositories, reducer, validator, and tests behind flags.
2. Add `WorldMindFlow` and run it from tests only.
3. Add `WorldInteractionFlow` behind `ENABLE_WORLD_MIND`.
4. Add `world_tick` worker behind `ENABLE_WORLD_TICKS`.
5. Add minimal debug endpoints for event ledger, snapshots, and commands.
6. Update UI only after backend behavior is verified.

## First Implementation Slice

The first implementation plan should be limited to:

1. Schema and repositories for event ledger, snapshots, character states, commands, memories, decision logs.
2. Deterministic reducer and validator.
3. Structured AI schema and mock director.
4. `WorldMindFlow`.
5. `WorldInteractionFlow` adapter for `/api/chat` behind a flag.
6. Tick worker and idempotent task queue improvements.
7. Tests proving replay, visibility, idempotency, and command dispatch.

Feed integration and UI visualization can follow after the loop is correct.

## Acceptance Criteria

The design is complete when these behaviors are implemented and tested:

1. A user action records a committed `user_action` event.
2. The world director can commit a `world_incident` event in response.
3. The reducer updates world snapshot and at least one character state.
4. The director can dispatch a command to a non-selected character.
5. A selected character can receive a visible `speak_to_user` command in chat.
6. Hidden facts do not enter character prompts unless revealed.
7. A scheduled tick can advance an unresolved event without user input.
8. Retrying a task does not duplicate events or commands.
9. World memory recall changes a later director decision in a test-controlled way.
10. A world snapshot can be rebuilt from committed events.

## Open Design Choices Resolved

The first version will use one world director per user/world scope. It will not run a global cross-user world. This preserves privacy and keeps SQLite state manageable.

The first version will keep the Flow Runner linear. Branching belongs inside validated node logic for now. A graph runner can be introduced only if multiple world flows become hard to maintain.

The first version will use structured output for director decisions. Free-form model text is only allowed inside event summaries, memory content, and command reasons after schema validation.

The first version will treat role autonomy as command-driven. Characters can appear autonomous because the director schedules actions, but persistence and causality remain centralized through the event ledger.
