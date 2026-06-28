import { createHash } from "node:crypto";

import { createTestDatabase } from "@/server/db/client";
import type { AppDatabase } from "@/server/db/client";
import type { WorldRecord } from "@/server/domain/chat/repositories";
import { WorldRepository } from "@/server/domain/chat/repositories";
import { CharacterStateRepository } from "./character-state-repository";
import type { DirectorContext } from "./types";
import { WorldEventRepository } from "./world-event-repository";
import { WorldMemoryRepository } from "./world-memory-repository";
import { WorldStateRepository } from "./world-state-repository";

export interface BuildDirectorContextInput {
  userId: string;
  worldId: string;
  sourceInput?: { message: string; targetAgentId: string };
  targetAgentId?: string; // for actor-facing ACL filtering
  db: AppDatabase;
}

export function buildWorldDirectorContext(input: BuildDirectorContextInput): DirectorContext {
  const { userId, worldId, sourceInput, targetAgentId, db } = input;

  // Strict world loading — never fallback to "default"
  const worldRepo = new WorldRepository(db);
  const world = worldRepo.get(worldId);
  if (!world) {
    throw new Error(`World not found: ${worldId}`);
  }

  // Build system prompt
  const system = buildSystemPrompt(world);

  // Load latest snapshot
  const snapshotRepo = new WorldStateRepository(db);
  const snapshot = snapshotRepo.getLatest({ userId, worldId });

  // Load recent events
  const eventRepo = new WorldEventRepository(db);
  const recentEvents = eventRepo.listRecentForWorld({ userId, worldId, limit: 24 });

  // Load world memory
  const memoryRepo = new WorldMemoryRepository(db);
  const directorMemories = memoryRepo.recallForDirector({ userId, worldId, subjectType: "world" });

  // hiddenFactSummaries is always the full list
  const hiddenFactSummaries = directorMemories
    .filter((m) => m.visibility === "hidden")
    .map((m) => m.content);

  // Determine which memories to include in prompt
  let promptMemories = directorMemories;
  if (targetAgentId !== undefined) {
    // Use actor-filtered memories for the prompt
    const actorMemories = memoryRepo.recallForActor({
      userId,
      worldId,
      agentId: targetAgentId,
      subjectType: "world",
    });
    promptMemories = actorMemories;
  }

  // Load character states
  const charRepo = new CharacterStateRepository(db);
  const characterStates = charRepo.listForWorld({ userId, worldId });

  // Build the prompt
  const prompt = buildPrompt({
    world,
    snapshot,
    recentEvents,
    promptMemories,
    characterStates,
    sourceInput,
    targetAgentId,
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

  return lines.join("\n");
}

interface BuildPromptOptions {
  world: WorldRecord;
  snapshot: ReturnType<WorldStateRepository["getLatest"]>;
  recentEvents: ReturnType<WorldEventRepository["listRecentForWorld"]>;
  promptMemories: ReturnType<WorldMemoryRepository["recallForDirector"]>;
  characterStates: ReturnType<CharacterStateRepository["listForWorld"]>;
  sourceInput?: { message: string; targetAgentId: string };
  targetAgentId?: string;
}

function buildPrompt(opts: BuildPromptOptions): string {
  const { world, snapshot, recentEvents, promptMemories, characterStates, sourceInput, targetAgentId } = opts;

  const sections: string[] = [];

  // Clock / world state
  if (snapshot) {
    const { clock, stability, tension, publicFacts } = snapshot.state;
    sections.push(`## 当前世界状态`);
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
    sections.push(``);
  }

  // Character states
  if (characterStates.length > 0) {
    sections.push(`## 当前角色`);
    sections.push(``);
    for (const char of characterStates) {
      sections.push(`**${char.agentId}** @ ${char.locationKey}`);
      sections.push(`  目标: ${char.currentGoal}`);
    }
    sections.push(``);
  }

  // Recent events
  if (recentEvents.length > 0) {
    sections.push(`## 最近事件`);
    sections.push(``);
    for (const event of recentEvents) {
      sections.push(`- [Tick ${event.tick}] ${event.summary}`);
    }
    sections.push(``);
  }

  // World memories
  if (promptMemories.length > 0) {
    sections.push(`## 世界记忆`);
    sections.push(``);
    for (const mem of promptMemories) {
      const vis = mem.visibility === "public" ? "" : `[${mem.visibility}] `;
      sections.push(`- ${vis}${mem.content}`);
    }
    sections.push(``);
  }

  // Source input
  if (sourceInput) {
    sections.push(`## 当前输入`);
    sections.push(``);
    sections.push(`> ${sourceInput.message}`);
    sections.push(``);
  }

  return sections.join("\n");
}
