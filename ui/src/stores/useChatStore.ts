import { create } from "zustand";

import { AgentLiveStateDto } from "@/lib/api/types_api";
import { AiAgent, ChatMessage } from "@/features/chat/types";

export type ThemeMode = "neon" | "dawn";

interface ChatState {
  agents: AiAgent[];
  selectedAgentId: string;
  messagesByAgent: Record<string, ChatMessage[]>;
  liveStateByAgent: Record<string, AgentLiveStateDto>;
  input: string;
  themeMode: ThemeMode;
  notice: string;
  setAgents: (agents: AiAgent[]) => void;
  prependAgent: (agent: AiAgent) => void;
  removeAgent: (agentId: string) => void;
  setSelectedAgentId: (agentId: string) => void;
  upsertMessages: (agentId: string, messages: ChatMessage[]) => void;
  removeMessages: (agentId: string) => void;
  setLiveState: (agentId: string, state: AgentLiveStateDto) => void;
  removeLiveState: (agentId: string) => void;
  setInput: (input: string) => void;
  setThemeMode: (themeMode: ThemeMode) => void;
  setNotice: (notice: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  agents: [],
  selectedAgentId: "",
  messagesByAgent: {},
  liveStateByAgent: {},
  input: "",
  themeMode: "neon",
  notice: "正在连接后端...",
  setAgents: (agents) => set({ agents }),
  prependAgent: (agent) =>
    set((state) => ({
      agents: [agent, ...state.agents],
    })),
  removeAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.filter((item) => item.id !== agentId),
    })),
  setSelectedAgentId: (selectedAgentId) => set({ selectedAgentId }),
  upsertMessages: (agentId, messages) =>
    set((state) => ({
      messagesByAgent: {
        ...state.messagesByAgent,
        [agentId]: messages,
      },
    })),
  removeMessages: (agentId) =>
    set((state) => {
      const next = { ...state.messagesByAgent };
      delete next[agentId];
      return { messagesByAgent: next };
    }),
  setLiveState: (agentId, stateValue) =>
    set((state) => ({
      liveStateByAgent: {
        ...state.liveStateByAgent,
        [agentId]: stateValue,
      },
    })),
  removeLiveState: (agentId) =>
    set((state) => {
      const next = { ...state.liveStateByAgent };
      delete next[agentId];
      return { liveStateByAgent: next };
    }),
  setInput: (input) => set({ input }),
  setThemeMode: (themeMode) => set({ themeMode }),
  setNotice: (notice) => set({ notice }),
}));
