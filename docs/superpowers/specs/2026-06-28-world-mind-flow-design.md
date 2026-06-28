# WorldMind Flow Design

Date: 2026-06-28

## Goal

Build a long-running, closed-loop world director for Another-World. The director is the system-level mind of a virtual otherworld: it observes world state, interprets user actions, proposes world events, creates commands for characters, preserves long-term world memory, and keeps the world internally consistent over time.

The first version must fit the current Next.js + TypeScript + SQLite architecture. It must extend the existing lightweight Flow Runner instead of replacing it.

## Core Correction

WorldMind v1 is not an agent that directly pushes the world forward. It is a proposal engine. The world changes only through a validated event ledger, a deterministic reducer, and command records that can be executed later.

The governing rule is:

```text
LLM proposes.
Validator accepts or rejects.
One transaction commits events, snapshots, character states, command records, and decision logs.
Reducers derive state only from committed events.
Workers execute commands later and report effects as new events.
```

This keeps the world auditable, replayable, recoverable, and resistant to prompt/context leakage.

## Non-Goals

The first version will not implement a full simulation engine with economy, geography pathfinding, combat, calendars, or multi-process actor autonomy. It will not let language models directly mutate database state. It will not replace the existing chat, memory, feed, world, or agent flows.

The first version must prove the core loop:

1. A user action is committed exactly once as a world event.
2. A director decision can create derived events.
3. A deterministic reducer can rebuild snapshots from ordered events.
4. A director decision can persist actor commands without executing them inline.
5. A visible actor directive can be injected into chat without leaking hidden facts.
6. World memory can influence future director decisions without becoming the source of state truth.

## Current System Fit

The existing codebase has the right foundation:

- `server/flow/runner.ts` provides a simple linear `Flow<TContext>`.
- `server/flow/chat-flow.ts` handles agent chat, memory recall, live state update, persistence, and async memory extraction.
- `server/flow/feed-flow.ts` generates character posts and can later execute `publish_post` commands.
- `server/flow/memory-extract-flow.ts` and `MemoryConsolidator` provide useful patterns, but world memory needs its own consolidation rules.
- `domain/chat/task-repository.ts` provides a basic task queue, but it must be upgraded before it can safely run world ticks.
- SQLite is the default persistence layer.

The world layer should live beside the current chat layer:

```text
ui/src/server/domain/world/
  world-event-repository.ts
  world-state-repository.ts
  character-state-repository.ts
  actor-command-repository.ts
  world-decision-log-repository.ts
  world-memory-repository.ts
  world-memory-consolidator.ts
  world-reducer.ts
  world-replay-service.ts
  world-context-builder.ts
  world-decision-validator.ts

ui/src/server/flow/
  world-mind-flow.ts
  world-interaction-flow.ts
  actor-command-worker.ts
  world-tick-worker.ts
```

The existing `domain/chat/repositories.ts` is already broad. New world concepts should not be added to that file except through narrow adapters.

## Hard Invariants

These invariants are mandatory for the first implementation:

1. `world_events` is the source of truth for world and character state.
2. Every state-changing action must first become a committed `world_event`.
3. `WorldMindDecision` must not include free-floating state patches.
4. Commands are intent records, not facts. Commands do not update `world_state_snapshots` or `character_states` directly.
5. Command execution effects must be reported as new committed events.
6. User action events and director-derived events from the same run share one `decision_id` and one `world_run_id`.
7. User action event creation, derived event creation, reducer application, actor command persistence, and decision log insertion happen in one SQLite transaction.
8. World memory consolidation and next tick scheduling happen after the core transaction and cannot invalidate committed world state.
9. Event replay order is logical and deterministic, based on `sequence`, not `created_at`.
10. Visibility is enforced with explicit ACL fields, not only a `public/private/hidden` enum.
11. Safety screening runs before WorldMind sees user input.
12. Legal user actions are recorded even when the director model fails or validation rejects its output; unsafe or invalid inputs are not recorded in the world ledger.

## Flow Runner Boundary

The current `Flow<TCtx>` is intentionally thin. It only orders nodes and emits node lifecycle events. It must not be treated as a transaction manager, retry engine, checkpoint engine, rollback engine, or compensation system.

World state consistency belongs inside one explicit transaction node:

```text
CommitWorldRunTransaction
```

All earlier nodes prepare data. All later nodes handle secondary effects.

## Entry Points

### Chat Route Integration

The current `/api/chat` route should branch by feature flag:

```text
if ENABLE_WORLD_MIND:
  route -> createWorldInteractionFlow()
else:
  route -> createChatFlow()
```

In WorldMind mode, world loading is strict:

```text
LoadWorldStrict(worldId)
```

The existing `ChatFlow` may keep its `default` fallback for non-WorldMind mode. WorldMind mode must not fallback to `default`, because that can mutate the wrong world.

### User Interaction

`WorldInteractionFlow` must not pre-commit a `user_action` event. It normalizes user input, runs safety before WorldMind, creates a stable run envelope, and delegates all world mutation to `WorldMindFlow`.

```text
WorldInteractionFlow
  -> NormalizeUserActionInput
  -> PreSafetyCheck
  -> if high risk: RunChatFlowSafetyOnly / return safety response
  -> RequireClientActionId
  -> CreateWorldRunEnvelope
  -> RunWorldMind(source = "user_action", sourceActionId)
  -> ClaimVisibleSpeakCommand
  -> RunChatFlowWithWorldDirective
  -> if chat success: MarkSpeakCommandDone
  -> if chat failure: ReleaseSpeakCommandClaim or let claimExpiresAt expire
  -> ReturnChatResult
```

`PreSafetyCheck` uses the same risk semantics as the current `ChatFlow` safety gate. High-risk input must not be sent to WorldMind and must not create `world_events`, `actor_commands`, `world_memories`, or director context. The response can reuse a safety-only chat path so the user still receives the existing safety response.

WorldMind mode requires a client-provided `client_action_id`. The server maps it to `sourceActionId`. A WorldMind chat request without `client_action_id` must return `400` before creating a world run envelope. The first implementation must update the frontend to generate a UUID per outbound user action.

### Background Tick

The world advances without user input through scheduled tasks:

```text
task kind: world_tick
payload: { worldId, userId, reason, scheduledTick }
```

World ticks must create the same run envelope, but with:

```text
source = "scheduled_tick"
sourceActionId = task.id or task.idempotency_key
```

### System Trigger

World creation, role creation, feed interaction, and debug endpoints may enqueue system triggers:

```text
task kind: world_trigger
payload: { worldId, userId, triggerType, payload }
```

System triggers use the same transaction rules as user actions and ticks.

## World Run Envelope

Every WorldMind attempt gets a stable envelope before model generation.

```ts
WorldRunEnvelope {
  worldRunId: string;
  decisionId: string;
  sourceType: "user_action" | "scheduled_tick" | "system_trigger";
  sourceActionId: string;
  idempotencyKey: string;
  userId: string;
  worldId: string;
  agentId?: string;
  startedAt: number;
}
```

The envelope is created after `PreSafetyCheck` for user input and before `GenerateDirectorDecision`. Model failures, validation failures, transaction failures, and accepted decisions all use the same `worldRunId` and `decisionId`.

Phase 1 can skip persistent envelopes because it does not expose `/api/chat` retry behavior. Phase 2 must persist envelopes in `world_runs` before enabling WorldInteractionFlow. The same `client_action_id` retry must load the existing run instead of creating a different `worldRunId` or `decisionId`.

## WorldMind Flow

`WorldMindFlow` is linear, but only one node mutates primary world state.

```text
LoadWorldRunEnvelope
LoadWorldRuntime
LoadWorldStateSnapshot
LoadActiveActors
LoadRecentEventLedger
RecallWorldMemory
BuildDirectorContext
GenerateDirectorDecision
ValidateDirectorDecision
CommitWorldRunTransaction
ConsolidateWorldMemorySecondary
ScheduleNextTickSecondary
```

### LoadWorldRunEnvelope

Loads the stable envelope prepared by `WorldInteractionFlow`, a tick worker, or a system trigger. This node does not generate new ids. If the envelope is missing, the flow fails before model generation.

### LoadWorldRuntime

Loads the `WorldRecord` from the existing `WorldRepository`. If no world exists, fail fast. This node never falls back to `default`.

### LoadWorldStateSnapshot

Loads the latest snapshot for `worldId` and `userId`. If no snapshot exists, prepare an initial state in memory. The initial state is persisted only inside `CommitWorldRunTransaction`.

```ts
WorldStateSnapshot {
  worldId: string;
  userId: string;
  tick: number;
  snapshotKind: "latest" | "checkpoint" | "rebuild";
  appliedEventSequence: number;
  appliedEventIds: string[];
  reducerVersion: number;
  state: {
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
  };
  checksum: string | null;
  createdAt: number;
  updatedAt: number;
}
```

First-version snapshots are compact. History belongs in `world_events`; durable non-state facts belong in `world_memories`.

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
  knowledgeKeys: string[]; // stable factKey values known by this character
  activeCommandId: string | null;
  lastActedAt: number | null;
  updatedAt: number;
}
```

If a character has no state yet, prepare a default state in memory. Persist it only through `CommitWorldRunTransaction`.

### LoadRecentEventLedger

Loads recent committed events for context:

- Last 24 committed events for the world.
- Last 8 committed events involving the selected agent.
- Last 8 unresolved event or thread events.

The query order must be:

```sql
ORDER BY sequence ASC
```

`created_at` is only observability metadata and must not determine replay order.

### RecallWorldMemory

Uses `WorldMemoryRepository`, not the chat-scoped `MemoryRepository`.

World memory stores durable facts that help context construction. It is not the source of replayable state.

```ts
WorldMemory {
  id: string;
  worldId: string;
  userId: string;
  subjectType: "world" | "arc" | "faction" | "location" | "character" | "user";
  subjectKey: string;
  memoryType: "lore" | "rule" | "relationship" | "secret" | "unresolved_thread";
  canonicalKey: string | null;
  content: string;
  visibility: VisibilityScope;
  importance: number;
  confidence: number;
  validFromTick: number;
  sourceEventId: string | null;
  sourceDecisionId: string | null;
  supersededBy: string | null;
  embeddingJson: string | null;
  embeddingQuality: string | null;
  createdAt: number;
  updatedAt: number;
}
```

`sourceEventId` is required for memories derived from world activity. It may be null only for seed memories created during system initialization.

`event` is deliberately not a `memoryType`. Events belong in `world_events`; memories may reference events.

### BuildDirectorContext

The director context is layered and visibility-aware:

```text
1. Immutable canon
2. Runtime snapshot
3. Actor slice
4. Recent committed event ledger
5. Retrieved world memory
6. Current source input or tick reason
7. Output contract and hard constraints
```

Budget guidance:

- Canon and world rules: 1200 tokens.
- Runtime snapshot: 1000 tokens.
- Actor slice: 1200 tokens.
- Recent events: 1500 tokens.
- Retrieved memory: 1200 tokens.
- Current input: uncropped unless it exceeds a hard request limit.
- Output schema instructions: fixed and short.

The context builder may use `world_summaries` for older event windows. It must not summarize the current user action or immutable canon.

`world_summaries` must be generated per visibility scope. A director summary may include hidden facts. Actor-facing and user-facing summaries must be ACL-filtered and must never be reused as director-hidden context. Summary rows therefore need the same `VisibilityScope` fields as events and memories.

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

Environment mapping must include:

```env
WORLD_DIRECTOR_MODEL=
```

The decision schema deliberately excludes `statePatch`:

```ts
WorldMindDecision {
  observations: string[];
  intent:
    | "no_op"
    | "advance_scene"
    | "trigger_event"
    | "dispatch_commands";
  events: ProposedWorldEvent[];
  commands: ProposedActorCommand[];
  memories: WorldMemoryCandidate[];
  nextTick: {
    delayMs: number;
    reason: string;
  } | null;
}
```

If a future design needs patch-like behavior, it must be represented as a typed event payload, not a free-floating patch:

```ts
ProposedWorldEvent {
  clientEventId: string;
  type: "arc_progress";
  payload: {
    patchType: "resolve_thread";
    threadKey: string;
    resolution: string;
  };
  visibility: VisibilityScope;
  actorIds: string[];
  summary: string;
}
```

Hard output limits:

- `observations`: max 6.
- `events`: max 3.
- `commands`: max 5.
- `memories`: max 8.
- `delayMs`: 30 seconds to 24 hours.

### ValidateDirectorDecision

Validation rejects unsafe or incoherent decisions before the transaction.

Rules:

- All `agentId` values must exist and belong to the target world.
- Events must use known event types.
- Commands must use known command types.
- Event payloads must match typed schemas for their event type.
- `decision.events[].clientEventId` must be unique inside one `WorldMindDecision`.
- Commands must include a typed `CommandCause`.
- Every command cause with `{ type: "proposed_event" }` must reference an existing `clientEventId`.
- Hidden facts cannot be included in public command instructions, public events, feed content, or actor-visible memory.
- Command `actorInstruction` must be safe to inject into the target actor prompt after ACL filtering.
- Command `privateReason` must never be injected into chat prompts.
- Event count and command count must stay within schema limits.
- A user action may create at most one major event unless an event is explicitly marked as a chain reaction.
- Scheduled ticks may create zero events; no-op is valid.

If validation fails for a legal user action, `CommitWorldRunTransaction` commits the source `user_action` event as `observed_only`, applies the reducer to that source event, writes a rejected decision log, and commits no derived events or commands.

If validation fails for a scheduled tick or system trigger, the transaction writes a rejected decision log and commits no derived events, commands, or snapshot changes unless a source event was already required by that source type.

### Failure Ledger Policy

WorldMind uses this policy for source user actions:

```text
A. Parameter invalid or PreSafetyCheck high risk:
   Do not create a world run envelope.
   Do not commit user_action.
   Do not run WorldMind.

B. User input is legal but director model generation fails:
   Commit user_action as observed_only.
   Apply reducer to the source event only.
   Write decision log with validationStatus = "model_failed".
   Commit no derived events and no actor commands.

C. Director output is invalid:
   Commit user_action as observed_only.
   Apply reducer to the source event only.
   Write decision log with validationStatus = "rejected".
   Commit no derived events and no actor commands.

D. Director output is valid:
   Commit user_action and derived events.
   Apply reducer to all events in sequence order.
   Persist actor commands and accepted decision log.
```

`observed_only` means the event is part of the audit ledger and replay sequence, but reducers must not treat it as a narrative world incident unless a later valid director event interprets it.

The source `user_action` event remains `status = "committed"` when it is recorded. Its payload carries interpretation state:

```ts
UserActionPayload {
  clientActionId: string;
  normalizedMessage: string;
  targetAgentId: string;
  interpretationStatus: "pending" | "accepted" | "observed_only";
  failureReason?: "model_failed" | "validation_failed";
}
```

### CommitWorldRunTransaction

This is the only primary state mutation node.

Inside one SQLite transaction:

```text
1. Load the pre-created decision_id and world_run_id from the run envelope.
2. Commit the source event if required and absent.
3. Commit validated derived events with stable sequences.
4. Apply reducer over [source event + derived events] in sequence order.
5. Insert/update world_state_snapshots.
6. Insert/update character_states.
7. Insert actor_commands.
8. Insert world_decision_logs for accepted/rejected/model_failed outcomes.
9. Commit transaction.
```

If any step fails, the full transaction rolls back.

The transaction owns user action submission. `WorldInteractionFlow` must not pre-commit `user_action`.

If the transaction itself fails, `transaction_failed` cannot be written inside the rolled-back transaction. The caller must perform a separate best-effort log insert after rollback:

```ts
try {
  db.transaction(() => {
    commitEvents();
    applyReducer();
    persistCommands();
    insertDecisionLog("accepted");
  })();
} catch (error) {
  insertDecisionLogBestEffort("transaction_failed", error);
  throw error;
}
```

### ConsolidateWorldMemorySecondary

World memory consolidation happens after the core transaction. It may fail without rolling back committed events or snapshots.

The consolidator receives:

- committed event ids,
- `decision_id`,
- accepted memory candidates,
- current world state metadata.

Failures are logged in `world_decision_logs` or a dedicated operation log.

### ScheduleNextTickSecondary

Next tick scheduling happens after the core transaction. It may fail without rolling back committed events or snapshots.

Ticks are scheduled only when there is a committed event, unresolved thread, or explicit accepted `nextTick`. Quiet worlds do not schedule endless work.

## Event Ledger

Events are immutable facts. Reducers replay events in `sequence` order.

```ts
WorldEvent {
  id: string;
  decisionId: string;
  worldRunId: string;
  worldId: string;
  userId: string;
  tick: number;
  sequence: number;
  schemaVersion: number;
  reducerVersion: number;
  type:
    | "user_action"
    | "world_incident"
    | "character_action"
    | "relationship_shift"
    | "knowledge_reveal"
    | "fact_correction"
    | "arc_progress"
    | "system_note";
  visibility: VisibilityScope;
  actorIds: string[];
  locationKey: string | null;
  payload: unknown;
  summary: string;
  causedByEventId: string | null;
  causedByUserActionId: string | null;
  idempotencyKey: string;
  status: "committed";
  createdAt: number;
}
```

`world_events` does not store rejected proposals. Rejected proposals live only in `world_decision_logs`.

Committed events are immutable. They must not be rewritten to `superseded`. If later interpretation corrects or overturns an old fact, the system commits a new `system_note`, `arc_progress`, `fact_correction`, or `knowledge_reveal` event that references the old event. Replay keeps the old event and applies the correction event after it in sequence order.

Required constraints:

```text
UNIQUE(user_id, world_id, sequence)
UNIQUE(idempotency_key)
```

Recommended replay query:

```sql
SELECT *
FROM world_events
WHERE user_id = ?
  AND world_id = ?
ORDER BY sequence ASC
```

`tick` is a world-clock concept. `sequence` is the total order for replay.

Committed event idempotency keys for proposed events are derived from:

```text
worldRunId:clientEventId
```

### Stable Fact Keys

Facts that can be hidden, revealed, summarized, or known by a character require a stable `factKey`.

```ts
WorldFact {
  factKey: string;
  summary: string;
  visibility: VisibilityScope;
  sourceEventId: string;
}
```

Rules:

- `knowledge_reveal` events reveal an existing `factKey` or create a new public/private `factKey`.
- `character_states.knowledgeKeys` stores only `factKey` values.
- Hidden facts become actor-visible only after a committed `knowledge_reveal` event updates ACL and reducer state.
- Event payloads that create or reveal facts must include `factKey`.

## Reducer

Reducers are deterministic TypeScript functions. They consume committed events and return new state.

Reducer input:

```ts
WorldReducerInput {
  previousSnapshot: WorldStateSnapshot;
  previousCharacterStates: CharacterState[];
  events: WorldEvent[];
  reducerVersion: number;
}
```

Reducer output:

```ts
WorldReductionResult {
  worldSnapshot: WorldStateSnapshot;
  characterStates: CharacterState[];
  appliedEventIds: string[];
  warnings: string[];
}
```

Reducer responsibilities:

- Increment world tick when event semantics require it.
- Update clock phase.
- Update `stability` and `tension`.
- Add or resolve unresolved events.
- Update public and hidden facts.
- Update active arcs.
- Update character states.
- Record `appliedEventSequence` and `appliedEventIds`.

No command may directly update state. If a command changes location, knowledge, relationship, or arc progress, command execution must create a new `world_event`, and the reducer handles that event.

## Actor Commands

Commands are pending intents. Persisting a command does not mean the action happened.

```ts
ActorCommand {
  id: string;
  decisionId: string;
  worldRunId: string;
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
  visibility: VisibilityScope;
  actorInstruction: string;
  privateReason: string | null;
  cause: CommandCause;
  payload: unknown;
  relatedEventId: string | null;
  status: "pending" | "claimed" | "done" | "failed" | "expired";
  runAfter: number;
  expiresAt: number | null;
  idempotencyKey: string;
  claimedBy: string | null;
  claimedAt: number | null;
  claimExpiresAt: number | null;
  resultEventId: string | null;
  createdAt: number;
  updatedAt: number;
}
```

```ts
CommandCause =
  | { type: "proposed_event"; clientEventId: string }
  | { type: "committed_event"; eventId: string }
  | { type: "source_action"; sourceActionId: string }
  | { type: "director_no_event"; reasonCode: string };
```

Required constraints:

```text
UNIQUE(idempotency_key)
INDEX(user_id, world_id, target_agent_id, status, priority, run_after)
INDEX(status, run_after)
```

`actorInstruction` is the only field that may be injected into a character prompt, and only after ACL filtering. `privateReason` is for director/debug context only.

`CommandCause` is required for every command. A command's content is not its cause. Even `speak_to_user` without a derived event must reference the source action or use a specific `director_no_event` reason code.

### Command Execution

Command execution is separate from command persistence.

Workers and adapters:

- `ChatFlow` command adapter handles visible `speak_to_user` commands.
- `ActorCommandWorker` handles `move_location`, `investigate`, `remember`, and `initiate_event`.
- Feed worker handles `publish_post`.

State-changing command results must create committed events:

```text
ActorCommand(move_location)
  -> worker claims command
  -> worker creates character_action event
  -> reducer updates character_states.locationKey
  -> command.result_event_id points to the committed event
```

`speak_to_user` is the narrow exception because it mainly affects conversation. If the speech reveals knowledge, changes a relationship, or advances an arc, that effect must later be represented as a `world_event` through a transcript extraction or command-result event.

### `speak_to_user` Claim Semantics

`speak_to_user` commands must be claimed before they are injected into ChatFlow.

Required flow:

```text
ClaimVisibleSpeakCommand
  -> status: pending -> claimed
  -> claimed_by = current request/run id
  -> claimed_at = now
  -> claim_expires_at = now + short lease
RunChatFlowWithWorldDirective
if chat success:
  MarkSpeakCommandDone
else:
  ReleaseSpeakCommandClaim or let claimExpiresAt expire
```

Rules:

- Only a claimed `speak_to_user` command can become `VisibleActorDirective`.
- A claimed command must have `claimExpiresAt`.
- A done `speak_to_user` command must not be injected again.
- If ChatFlow fails before producing a response, the command must return to `pending` or become claimable after `claimExpiresAt`.
- Claiming and marking done are separate operations; neither is part of the WorldMind core transaction that created the command.

## ChatFlow Integration Contract

`ChatContext` needs a filtered directive field:

```ts
ChatContext {
  worldDirective?: VisibleActorDirective | null;
}

VisibleActorDirective {
  commandId: string;
  actorInstruction: string;
  relatedEventSummary?: string;
}
```

`buildSystemPrompt` and `buildUserPrompt` may only receive `VisibleActorDirective`, never raw `ActorCommand`.

WorldMind mode route behavior:

```text
if ENABLE_WORLD_MIND:
  createWorldInteractionFlow({
    strictWorld: true,
    chatFlowFactory: createChatFlow
  })
else:
  createChatFlow()
```

This contract prevents hidden `privateReason` or hidden world facts from leaking into character prompts.

The WorldMind chat request DTO must include a client action id:

```ts
{
  user_id: string;
  agent_id: string;
  domain_id: string;
  message: string;
  client_action_id: string;
}
```

The frontend generates `client_action_id` before sending. It must remain stable across retries for the same outbound user action. Without this client-provided id, WorldMind mode cannot claim exactly-once semantics and must reject the request.

## Visibility and ACL

Visibility is explicit:

```ts
VisibilityScope {
  level: "public" | "private" | "hidden";
  visibleToActorIds: string[];
  visibleToUser: boolean;
}
```

Database representation:

```text
visibility TEXT NOT NULL
visible_to_actor_ids_json TEXT NOT NULL DEFAULT '[]'
visible_to_user INTEGER NOT NULL DEFAULT 0
```

Rules:

- `public` is visible to all actors and the user.
- `private` is visible only to listed actors and/or the user.
- `hidden` is visible only to the director unless later revealed by a committed `knowledge_reveal` event.
- Hidden facts cannot appear in actor prompt context.
- Hidden facts cannot appear in `actorInstruction`.
- `privateReason` can include hidden director rationale, but it is never actor-visible.

Example:

```text
Hidden fact: The queen ordered the fire.
Public event: The port warehouse burned at night.
Actor instruction: Ask the user what they saw near the port.
Private reason: The director is testing whether the user saw signs of the queen's agents.
```

Only the actor instruction can reach the guard's prompt.

## World Memory

World memory cannot reuse chat memory rules wholesale. Chat memory consolidation is optimized for user/agent preferences, boundaries, goals, and semantic deduplication. World memory has different semantics.

First-version `WorldMemoryConsolidator` strategies:

- `rule`: `canonicalKey` is strongly unique. Conflicts supersede old rules.
- `secret`: default no semantic merge. Update only by `canonicalKey`.
- `relationship`: store structured relationship dimensions where possible; avoid text concatenation.
- `unresolved_thread`: merge into a thread timeline keyed by `canonicalKey`.
- `lore`: low-frequency; prefer seed/system-confirmed facts and conservative supersession.

`event` is not a memory type. Events remain in `world_events`.

Each world memory should include:

```text
source_event_id
source_decision_id
```

Only seed/system initialization memories may omit `source_event_id`.

## Decision Logs

Decision logs are required for debugging why the world changed.

```ts
WorldDecisionLog {
  id: string;
  decisionId: string;
  worldRunId: string;
  worldId: string;
  userId: string;
  sourceType: "user_action" | "scheduled_tick" | "system_trigger";
  sourceEventId: string | null;
  sourceTaskId: string | null;
  modelProvider: string;
  modelName: string;
  promptContextHash: string;
  rawDecisionJson: string | null;
  validatedDecisionJson: string | null;
  validationStatus: "accepted" | "rejected" | "model_failed" | "transaction_failed";
  validationErrorsJson: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdEventIdsJson: string;
  createdCommandIdsJson: string;
  createdAt: number;
}
```

Rejected decisions are logged even when no events or commands are committed.

`rawDecisionJson` is null when the model fails before returning a structured decision. `validatedDecisionJson` is null for rejected, model_failed, and transaction_failed outcomes. `errorCode` and `errorMessage` carry model and transaction failures so those failures are not hidden inside validation errors.

## Database Changes

Add these tables in runtime initialization and Drizzle schema:

```text
world_runs
world_state_snapshots
character_states
world_events
actor_commands
world_memories
world_decision_logs
world_summaries
```

### world_runs

Required from Phase 2 onward:

```text
id TEXT PRIMARY KEY
idempotency_key TEXT NOT NULL UNIQUE
user_id TEXT NOT NULL
world_id TEXT NOT NULL
source_type TEXT NOT NULL
source_action_id TEXT NOT NULL
decision_id TEXT NOT NULL
status TEXT NOT NULL -- running | committed | failed | rejected
result_json TEXT
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
```

`world_runs` is the authoritative retry envelope store. If two requests share the same `client_action_id`, they must resolve to the same `world_runs` row.

### world_events

Required fields:

```text
id TEXT PRIMARY KEY
decision_id TEXT NOT NULL
world_run_id TEXT NOT NULL
user_id TEXT NOT NULL
world_id TEXT NOT NULL
tick INTEGER NOT NULL
sequence INTEGER NOT NULL
schema_version INTEGER NOT NULL DEFAULT 1
reducer_version INTEGER NOT NULL DEFAULT 1
type TEXT NOT NULL
payload_json TEXT NOT NULL
summary TEXT NOT NULL
visibility TEXT NOT NULL
visible_to_actor_ids_json TEXT NOT NULL DEFAULT '[]'
visible_to_user INTEGER NOT NULL DEFAULT 0
actor_ids_json TEXT NOT NULL DEFAULT '[]'
location_key TEXT
caused_by_event_id TEXT
caused_by_user_action_id TEXT
idempotency_key TEXT NOT NULL
status TEXT NOT NULL DEFAULT 'committed'
created_at INTEGER NOT NULL
UNIQUE(user_id, world_id, sequence)
UNIQUE(idempotency_key)
```

`status` is reserved for the literal value `committed` in normal operation. Rejected proposals are not inserted into this table. Correction is represented by later committed events, not by mutating old event status.

### world_state_snapshots

Required fields:

```text
id TEXT PRIMARY KEY
user_id TEXT NOT NULL
world_id TEXT NOT NULL
tick INTEGER NOT NULL
snapshot_kind TEXT NOT NULL DEFAULT 'latest'
is_latest INTEGER NOT NULL DEFAULT 0
applied_event_sequence INTEGER NOT NULL
applied_event_ids_json TEXT NOT NULL
reducer_version INTEGER NOT NULL
state_json TEXT NOT NULL
checksum TEXT
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
UNIQUE(user_id, world_id, snapshot_kind, applied_event_sequence)
```

The latest snapshot is enforced with a partial unique index:

```sql
CREATE UNIQUE INDEX latest_world_snapshot_idx
ON world_state_snapshots(user_id, world_id)
WHERE is_latest = 1;
```

This permits multiple snapshots in the same tick when `applied_event_sequence` changes and permits checkpoint/rebuild rows for the same tick.

### character_states

Required fields:

```text
id TEXT PRIMARY KEY
user_id TEXT NOT NULL
world_id TEXT NOT NULL
agent_id TEXT NOT NULL
state_json TEXT NOT NULL
updated_at INTEGER NOT NULL
UNIQUE(user_id, world_id, agent_id)
```

### actor_commands

Required fields:

```text
id TEXT PRIMARY KEY
decision_id TEXT NOT NULL
world_run_id TEXT NOT NULL
user_id TEXT NOT NULL
world_id TEXT NOT NULL
target_agent_id TEXT NOT NULL
command_type TEXT NOT NULL
priority TEXT NOT NULL
visibility TEXT NOT NULL
visible_to_actor_ids_json TEXT NOT NULL DEFAULT '[]'
visible_to_user INTEGER NOT NULL DEFAULT 0
actor_instruction TEXT NOT NULL
private_reason TEXT
cause_json TEXT NOT NULL
payload_json TEXT NOT NULL
related_event_id TEXT
status TEXT NOT NULL
run_after INTEGER NOT NULL
expires_at INTEGER
idempotency_key TEXT NOT NULL
claimed_by TEXT
claimed_at INTEGER
claim_expires_at INTEGER
result_event_id TEXT
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
UNIQUE(idempotency_key)
```

### world_memories

Required fields:

```text
id TEXT PRIMARY KEY
user_id TEXT NOT NULL
world_id TEXT NOT NULL
subject_type TEXT NOT NULL
subject_key TEXT NOT NULL
memory_type TEXT NOT NULL
canonical_key TEXT
content TEXT NOT NULL
visibility TEXT NOT NULL
visible_to_actor_ids_json TEXT NOT NULL DEFAULT '[]'
visible_to_user INTEGER NOT NULL DEFAULT 0
importance REAL NOT NULL
confidence REAL NOT NULL
valid_from_tick INTEGER NOT NULL
source_event_id TEXT
source_decision_id TEXT
superseded_by TEXT
embedding_json TEXT
embedding_quality TEXT
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
```

### world_decision_logs

Use the fields defined in the Decision Logs section. Phase 2 may start with the minimal fields needed for mock-director accepted/rejected runs; Phase 3 extends the same table with model/context details if those columns were not already created.

### world_summaries

Stores compressed summaries of older event windows. Summary rows must include visibility ACL fields:

```text
visibility TEXT NOT NULL
visible_to_actor_ids_json TEXT NOT NULL DEFAULT '[]'
visible_to_user INTEGER NOT NULL DEFAULT 0
summary_scope TEXT NOT NULL -- director | actor | user
source_event_sequence_from INTEGER NOT NULL
source_event_sequence_to INTEGER NOT NULL
```

Director summaries may include hidden facts. Actor and user summaries are ACL-filtered. A summary generated for one scope must not be reused for another scope. Phase 1 can skip automatic summarization; the table becomes necessary when context compression is implemented.

## Task Queue Requirements

The existing `tasks` table is sufficient for memory extraction but not for long-running world ticks. It needs leasing and idempotency.

Required fields:

```text
idempotency_key TEXT UNIQUE
locked_by TEXT
locked_at INTEGER
lock_expires_at INTEGER
max_attempts INTEGER NOT NULL DEFAULT 3
next_attempt_at INTEGER
completed_at INTEGER
failed_permanently_at INTEGER
```

Required behavior:

- `enqueue` accepts optional `idempotencyKey`.
- Duplicate `idempotencyKey` returns the existing task.
- `claimNext` uses a SQLite transaction or atomic update, not select-then-update.
- Claimable tasks are pending or retryable and either unlocked or lock-expired.
- Claiming sets `status = 'running'`, `locked_by`, `locked_at`, and `lock_expires_at`.
- Failed tasks retry with bounded backoff until `max_attempts`.
- Permanently failed tasks remain inspectable.

Worker modes:

- Development: route-triggered drain with small limits for easy testing.
- Long-running: independent worker loop, cron, or Electron background process.

World tick correctness must not rely on best-effort `void drain...` calls after HTTP responses.

## Error Handling

Core transaction failures roll back the run.

Rules:

- If parameter validation fails or `PreSafetyCheck` returns high risk, do not create a world run envelope and do not write world ledger rows.
- If model generation fails for a legal user action, commit only the source `user_action` as `observed_only`, apply the reducer to that source event, and write a `model_failed` decision log in the core transaction.
- If validation fails for a legal user action, commit only the source `user_action` as `observed_only`, apply the reducer to that source event, and write a rejected decision log in the core transaction.
- If model generation or validation fails for a scheduled tick or system trigger, write the relevant failure decision log and do not commit derived events or commands unless that source type explicitly requires a source event.
- If `CommitWorldRunTransaction` fails, roll back events, snapshots, character states, commands, and in-transaction decision logs for that run.
- After a transaction rollback, write `transaction_failed` with an independent best-effort insert using the existing run envelope.
- Command row creation is part of the core transaction.
- Command execution is outside the core transaction and may fail or retry independently.
- Memory consolidation failure does not roll back committed events or snapshots.
- Next tick scheduling failure does not roll back committed events or snapshots.

## Safety and Product Boundaries

The existing safety behavior remains required, but WorldMind cannot rely on the downstream `ChatFlow` safety node because WorldMind runs before chat generation. `PreSafetyCheck` is therefore a mandatory WorldInteractionFlow node before `CreateWorldRunEnvelope` and `RunWorldMind`.

Additional constraints:

- The director must not create events that instruct self-harm, real-world illegal action, or manipulation of the user.
- World events can be fictional and dramatic, but user-facing output must preserve user safety.
- Character autonomy is fictional. The product should not claim that characters are conscious or independently alive.
- Hidden world facts are allowed, but user personal data must remain scoped to that user.

## Phased Implementation

### Phase 1: Event Ledger and Replayable Reducer

Goal:

```text
user_action event can be committed
world_incident event can be committed
snapshot can be rebuilt from events
```

Build:

- `world_events`
- `world_state_snapshots`
- `world_event_repository`
- `world_reducer`
- `world_replay_service`
- deterministic sequence allocator

No ChatFlow integration, no tick, no memory, no feed, no real LLM.

### Phase 2: Mock WorldMind and Chat Contract

Goal:

```text
WorldInteractionFlow behind flag
mock director outputs fixed event and command
selected actor receives only visible directive
```

Build:

- `actor_commands`
- `character_states`
- `world_runs`
- `world_decision_logs` minimal repository
- `WorldInteractionFlow`
- `WorldMindFlow` with mock director
- `ChatContext.worldDirective`
- strict world loading in WorldMind mode
- visible directive adapter

### Phase 3: Structured Director and Validator

Goal:

```text
real LLM only proposes
validator rejects invalid agents, visibility violations, over-limit events, and invalid commands
decision logs explain accepted and rejected runs
```

Build:

- `WorldMindDecisionSchema`
- `worldDirector` model purpose and `WORLD_DIRECTOR_MODEL`
- enhanced `world_decision_logs` fields for context hash, raw decision JSON, validated decision JSON, and model error details
- `world_context_builder`
- `world_decision_validator`
- `world_memories` repository with read-only recall; before memories exist, the adapter returns an empty list.

### Phase 4: Background Tick and Long-Term Loop

Goal:

```text
leased world_tick tasks
idempotent tick execution
unresolved_thread can advance without user input
quiet worlds do not consume tasks forever
```

Build:

- task lease/idempotency upgrade
- `world_tick_worker`
- `ActorCommandWorker`
- `WorldMemoryConsolidator`
- world memory embedding, supersession, and type-specific merge strategies
- optional feed command integration

## Testing Strategy

### Phase 1 Tests

- `world-event-repository.test.ts`: sequence allocation, idempotent inserts, ordered reads.
- `world-reducer.test.ts`: deterministic events produce expected snapshots.
- `world-replay-service.test.ts`: rebuild snapshot from committed events.
- `world-state-repository.test.ts`: multiple snapshots in one tick can coexist by `applied_event_sequence`, with only one latest snapshot.

### Phase 2 Tests

- `world-interaction-flow.test.ts`: mock director commits user action, event, command, and snapshot in one transaction.
- `world-interaction-safety.test.ts`: high-risk input returns safety response before WorldMind and creates no world ledger rows.
- `world-interaction-idempotency.test.ts`: same `client_action_id` retries do not duplicate source events.
- `chat-world-directive.test.ts`: only `actorInstruction` reaches prompt construction.
- `visibility-acl.test.ts`: hidden/private facts are filtered.
- `knowledge-reveal.test.ts`: character `knowledgeKeys` change only through committed `knowledge_reveal` events with `factKey`.

### Phase 3 Tests

- `world-decision-validator.test.ts`: rejects invalid agents, hidden leakage, over-limit events, invalid command references.
- `world-decision-log-repository.test.ts`: accepted, rejected, model_failed, and transaction_failed runs are inspectable under the same run envelope.
- `world-director-structured-output.test.ts`: model purpose and schema are wired.
- `world-summary-visibility.test.ts`: summaries are scoped by visibility and actor/user summaries cannot include hidden facts.

### Phase 4 Tests

- `task-repository-lease.test.ts`: atomic claim, lock expiry, retry backoff, permanent failure.
- `world-tick-worker.test.ts`: tick advances unresolved thread and schedules next tick idempotently.
- `actor-command-worker.test.ts`: command execution creates result events before state changes.

### Integration Tests

- Chat route with `ENABLE_WORLD_MIND=false` keeps existing behavior.
- Chat route with `ENABLE_WORLD_MIND=true` uses strict world loading.
- Chat route with `ENABLE_WORLD_MIND=true` requires stable `client_action_id` for exactly-once semantics.
- A hidden event is not visible in selected character response.
- Retried user action does not duplicate events or commands.
- Retried tick task does not duplicate events or commands.

## Acceptance Criteria

The design is implemented when:

1. PreSafetyCheck runs before WorldMind and high-risk input creates no world ledger rows.
2. A request with stable `client_action_id` records exactly one committed `user_action` event inside `CommitWorldRunTransaction`.
3. Legal user input with model_failed or validation_failed records the source `user_action` as `observed_only` and creates no derived events or commands.
4. The director can commit a `world_incident` event in the same transaction as the source event.
5. All committed events in a run share `decision_id` and `world_run_id`.
6. Every committed event has a stable `sequence`.
7. Snapshot rebuild uses `ORDER BY sequence ASC`.
8. Multiple snapshots can exist in the same tick by `applied_event_sequence`, with only one `is_latest = 1` row per user/world.
9. Reducer updates world snapshot and character states only from committed events.
10. Actor commands are persisted in the same transaction as events and snapshots.
11. Command execution effects create new committed events before state changes.
12. Every command has a typed `CommandCause`.
13. `privateReason` never enters ChatFlow prompt construction.
14. Visibility ACL controls private and hidden context.
15. `knowledgeKeys` refer to stable `factKey` values and change only through committed events.
16. WorldMind mode forbids fallback to `default` world.
17. Transaction failure is logged with best-effort `transaction_failed` after rollback.
18. Task claiming is lease-based and idempotent before world ticks run in background.

## Resolved Design Choices

The first version uses one world director per user/world scope. It does not run a global cross-user world. This preserves privacy and keeps SQLite state manageable.

The first version keeps the Flow Runner linear. Transaction semantics live in `CommitWorldRunTransaction`, not in the runner.

The first version removes free-floating `statePatch`. State changes are expressed as typed event payloads and applied by reducers.

The first version treats role autonomy as command-driven. Characters can appear autonomous because the director schedules commands, but persistence and causality remain centralized through events and reducers.

The first version starts with event ledger and reducer, then mock director, then structured LLM director, then background ticks. It should not start by connecting a real model to an autonomous world tick loop.
