import { createHash } from "node:crypto";

import type { AppDatabase } from "@/server/db/client";
import type { WorldRecord } from "@/server/domain/world/world-repository";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { CharacterStateRepository } from "./character-state-repository";
import type { DirectorContext, WorldEventRecord } from "./types";
import { WorldEventRepository } from "./world-event-repository";
import { WorldMemoryRepository } from "./world-memory-repository";
import { WorldStateRepository } from "./world-state-repository";

export interface BuildDirectorContextInput {
  userId: string;
  worldId: string;
  sourceInput?: { message: string; targetAgentId: string };
  targetAgentId?: string;
  audience?: "director" | "actor";
  db: AppDatabase;
}

export function buildWorldDirectorContext(input: BuildDirectorContextInput): DirectorContext {
  const { userId, worldId, sourceInput, targetAgentId, db } = input;
  const audience = input.audience ?? "director";

  // Honor both top-level targetAgentId and sourceInput.targetAgentId for actor slices.
  const effectiveTargetAgentId = targetAgentId ?? sourceInput?.targetAgentId;

  // Strict world loading — never fallback to "default"
  const worldRepo = new WorldRepository(db);
  const world = worldRepo.get(worldId);
  if (!world) {
    throw new Error(`World not found: ${worldId}`);
  }

  // Build system prompt with immutable canon and output contract
  const system = buildSystemPrompt(world);

  // Load latest snapshot
  const snapshotRepo = new WorldStateRepository(db);
  const snapshot = snapshotRepo.getLatest({ userId, worldId });

  // Load recent world events
  const eventRepo = new WorldEventRepository(db);
  const allRecentWorldEvents = eventRepo.listRecentForWorld({ userId, worldId, limit: 24 });

  const promptWorldEvents = audience === "actor" && effectiveTargetAgentId
    ? allRecentWorldEvents.filter((event) => isVisibleToActor(event, effectiveTargetAgentId))
    : allRecentWorldEvents;

  const allRecentActorEvents = effectiveTargetAgentId
    ? eventRepo.listRecentForActor({ userId, worldId, agentId: effectiveTargetAgentId, limit: 8 })
    : [];
  const recentActorEvents = audience === "actor" && effectiveTargetAgentId
    ? allRecentActorEvents.filter((event) => isVisibleToActor(event, effectiveTargetAgentId))
    : allRecentActorEvents;

  // Load world memory
  const memoryRepo = new WorldMemoryRepository(db);
  const directorMemories = memoryRepo.recallForDirector({ userId, worldId, subjectType: "world" });

  // hiddenFactSummaries is always the full list available to the validator.
  // Collect hidden memories from director recall
  const hiddenMemorySummaries = directorMemories.filter((m) => m.visibility === "hidden").map((m) => m.content);
  const hiddenFactSummaries = [
    ...hiddenMemorySummaries,
    ...(snapshot?.state.hiddenFacts.map((fact) => fact.summary) ?? []),
    ...allRecentWorldEvents.filter((event) => event.visibility.mode === "hidden").map((event) => event.summary),
  ];

  const promptMemories =
    audience === "actor" && effectiveTargetAgentId
      ? memoryRepo.recallForActor({
          userId,
          worldId,
          agentId: effectiveTargetAgentId,
          subjectType: "world",
        })
      : directorMemories;

  // Load character states
  const charRepo = new CharacterStateRepository(db);
  const characterStates = charRepo.listForWorld({ userId, worldId });

  // Build the prompt with layered sections
  const prompt = buildPrompt({
    world,
    snapshot,
    audience,
    recentEvents: promptWorldEvents,
    recentActorEvents,
    promptMemories,
    characterStates,
    sourceInput,
  });

  // Compute deterministic hash
  const hashInput = system + "\n\n" + prompt;
  const promptContextHash = createHash("sha256").update(hashInput).digest("hex");

  // Active agents from character states
  const activeAgentIds = characterStates.map((c) => c.agentId);

  return {
    system,
    prompt,
    promptContextHash,
    hiddenFactSummaries,
    activeAgentIds,
  };
}

function isVisibleToActor(event: WorldEventRecord, agentId: string): boolean {
  if (event.visibility.mode === "public") {
    return true;
  }
  if (event.visibility.mode === "private") {
    return event.visibility.visibleToActorIds.includes(agentId);
  }
  return false;
}

function buildSystemPrompt(world: WorldRecord): string {
  const lines = [
    `# 世界信息`,
    ``,
    `## ${world.name}`,
    ``,
    world.lore ? `${world.lore}` : "",
    ``,
    world.tone ? `**基调**: ${world.tone}` : "",
    ``,
    world.constraints.length > 0 ? `**约束**: ${world.constraints.join("; ")}` : "",
    ``,
    `## 活跃角色`,
    ``,
  ].filter((line) => line !== "");

  const outputContract = [
    `## Output Contract`,
    ``,
    `Return JSON matching WorldMindDecision:`,
    `- observations: string[], max 6`,
    `- intent: no_op | advance_scene | trigger_event | dispatch_commands`,
    `- events: ProposedWorldEvent[], max 3`,
    `- commands: ProposedActorCommand[], max 5`,
    `- memories: WorldMemoryCandidate[], max 8`,
    `- nextTick: { delayMs, reason } | null`,
    `Do not include statePatch.`,
    `Commands are intent records, not facts.`,
  ];

  return [...lines, ...outputContract].join("\n");
}

interface BuildPromptOptions {
  world: WorldRecord;
  snapshot: ReturnType<WorldStateRepository["getLatest"]>;
  audience: "director" | "actor";
  recentEvents: ReturnType<WorldEventRepository["listRecentForWorld"]>;
  recentActorEvents: ReturnType<WorldEventRepository["listRecentForActor"]>;
  promptMemories: ReturnType<WorldMemoryRepository["recallForDirector"]>;
  characterStates: ReturnType<CharacterStateRepository["listForWorld"]>;
  sourceInput?: { message: string; targetAgentId: string };
}

function buildPrompt(opts: BuildPromptOptions): string {
  const { world, snapshot, audience, recentEvents, recentActorEvents, promptMemories, characterStates, sourceInput } = opts;

  const sections: string[] = [];

  // 1. Immutable Canon (lore and constraints from world — already in system, but brief expects it in prompt too)
  sections.push(`## Immutable Canon`);
  sections.push(``);
  sections.push(`**基调**: ${world.tone ?? "未指定"}`);
  sections.push(`**约束**: ${world.constraints.join("; ")}`);
  sections.push(``);

  // 2. Runtime Snapshot
  if (snapshot) {
    const { clock, stability, tension, publicFacts, hiddenFacts } = snapshot.state;
    sections.push(`## Runtime Snapshot`);
    sections.push(``);
    sections.push(`**时间**: 第 ${clock.day} 天 - ${clock.phase}`);
    sections.push(`**稳定度**: ${stability.toFixed(2)}`);
    sections.push(`**紧张度**: ${tension.toFixed(2)}`);
    if (publicFacts.length > 0) {
      sections.push(``);
      sections.push(`**已知事实**:`);
      for (const fact of publicFacts) {
        sections.push(`- ${fact.summary}`);
      }
    }
    if (audience === "director" && hiddenFacts.length > 0) {
      sections.push(``);
      sections.push(`**导演隐藏事实**:`);
      for (const fact of hiddenFacts) {
        sections.push(`- ${fact.summary}`);
      }
    }
    sections.push(``);
  }

  // 3. Actor Slice
  if (characterStates.length > 0) {
    sections.push(`## Actor Slice`);
    sections.push(``);
    for (const char of characterStates) {
      sections.push(`**${char.agentId}** @ ${char.locationKey}`);
      sections.push(`  目标: ${char.currentGoal}`);
    }
    sections.push(``);
  }

  // 4. Recent World Events
  if (recentEvents.length > 0) {
    sections.push(`## Recent World Events`);
    sections.push(``);
    for (const event of recentEvents) {
      sections.push(`- [Tick ${event.tick}] ${event.summary}`);
    }
    sections.push(``);
  }

  // 5. Recent Actor Events
  if (recentActorEvents.length > 0) {
    sections.push(`## Recent Actor Events`);
    sections.push(``);
    for (const event of recentActorEvents) {
      sections.push(`- [Tick ${event.tick}] ${event.summary}`);
    }
    sections.push(``);
  }

  // 6. Retrieved World Memory
  if (promptMemories.length > 0) {
    sections.push(`## Retrieved World Memory`);
    sections.push(``);
    for (const mem of promptMemories) {
      const vis = mem.visibility === "public" ? "" : `[${mem.visibility}] `;
      sections.push(`- ${vis}${mem.content}`);
    }
    sections.push(``);
  }

  // 7. Current Source
  if (sourceInput) {
    sections.push(`## Current Source`);
    sections.push(``);
    sections.push(`> ${sourceInput.message}`);
    sections.push(``);
  }

  // 8. Output Contract
  sections.push(`## Output Contract`);
  sections.push(``);
  sections.push(`Return JSON matching WorldMindDecision:`);
  sections.push(`- observations: string[], max 6`);
  sections.push(`- intent: no_op | advance_scene | trigger_event | dispatch_commands`);
  sections.push(`- events: ProposedWorldEvent[], max 3`);
  sections.push(`- commands: ProposedActorCommand[], max 5`);
  sections.push(`- memories: WorldMemoryCandidate[], max 8`);
  sections.push(`- nextTick: { delayMs, reason } | null`);
  sections.push(`Do not include statePatch.`);
  sections.push(`Commands are intent records, not facts.`);

  return sections.join("\n");
}
