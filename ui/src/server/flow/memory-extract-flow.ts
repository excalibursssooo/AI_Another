import { AppDatabase } from "@/server/db/client";
import { MemoryRepository } from "@/server/domain/chat/repositories";
import {
  GenerateMemoryExtraction,
  generateMemoryExtraction as defaultGenerateMemoryExtraction,
} from "@/server/ai/chat";
import { MemoryCandidate } from "@/server/ai/schemas";

import { Flow } from "./runner";
import { FlowNode } from "./types";

export interface MemoryExtractContext {
  userId: string;
  agentId: string;
  worldId: string;
  userMessage: string;
  assistantMessage: string;
  agentName?: string;
  candidates?: MemoryCandidate[];
  persistedMemoryCount?: number;
}

export function createMemoryExtractFlow(options: {
  db: AppDatabase;
  generateMemoryExtraction?: GenerateMemoryExtraction;
}): Flow<MemoryExtractContext> {
  const memories = new MemoryRepository(options.db);
  const generateExtraction = options.generateMemoryExtraction ?? defaultGenerateMemoryExtraction;

  const nodes: FlowNode<MemoryExtractContext>[] = [
    {
      name: "LoadMessagePair",
      run: async (ctx) => ({
        ...ctx,
        userMessage: ctx.userMessage.trim(),
        assistantMessage: ctx.assistantMessage.trim(),
      }),
    },
    {
      name: "ExtractMemoryCandidates",
      run: async (ctx) => {
        if (!ctx.userMessage || !ctx.assistantMessage) {
          return { ...ctx, candidates: [] };
        }
        const extraction = await generateExtraction({
          userMessage: ctx.userMessage,
          assistantMessage: ctx.assistantMessage,
          agentName: ctx.agentName,
        });
        return { ...ctx, candidates: extraction?.memories ?? [] };
      },
    },
    {
      name: "PersistMemories",
      run: async (ctx) => {
        const candidates = (ctx.candidates ?? []).filter((candidate) => candidate.content.trim()).slice(0, 8);
        for (const candidate of candidates) {
          memories.create({
            userId: ctx.userId,
            agentId: ctx.agentId,
            worldId: ctx.worldId,
            subject: candidate.subject,
            memoryType: candidate.type,
            content: candidate.content.trim(),
            importance: candidate.importance,
            confidence: candidate.confidence,
          });
        }
        return { ...ctx, persistedMemoryCount: candidates.length };
      },
    },
  ];

  return new Flow(nodes);
}
