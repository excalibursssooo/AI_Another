import { create } from "zustand";

import { WorldDebugDto, WorldDetailDto } from "@/lib/api/types_api";

export interface WorldFormState {
  id: string;
  name: string;
  lore: string;
  tone: string;
  constraintsText: string;
  seedMemoriesText: string;
}

interface WorldState {
  worldDebug: WorldDebugDto | null;
  selectedDomainId: string;
  showWorldManager: boolean;
  worlds: WorldDetailDto[];
  worldSaving: boolean;
  worldLoading: boolean;
  editingWorldId: string;
  form: WorldFormState;
  aiWorldPrompt: string;
  setWorldDebug: (value: WorldDebugDto | null) => void;
  setSelectedDomainId: (value: string) => void;
  setShowWorldManager: (value: boolean) => void;
  setWorlds: (value: WorldDetailDto[]) => void;
  setWorldSaving: (value: boolean) => void;
  setWorldLoading: (value: boolean) => void;
  setEditingWorldId: (value: string) => void;
  setForm: (updater: WorldFormState | ((prev: WorldFormState) => WorldFormState)) => void;
  setAiWorldPrompt: (value: string) => void;
  resetWorldForm: () => void;
}

const EMPTY_FORM: WorldFormState = {
  id: "",
  name: "",
  lore: "",
  tone: "",
  constraintsText: "",
  seedMemoriesText: "",
};

export const useWorldStore = create<WorldState>((set) => ({
  worldDebug: null,
  selectedDomainId: "default",
  showWorldManager: false,
  worlds: [],
  worldSaving: false,
  worldLoading: false,
  editingWorldId: "",
  form: EMPTY_FORM,
  aiWorldPrompt: "",
  setWorldDebug: (value) => set({ worldDebug: value }),
  setSelectedDomainId: (value) => set({ selectedDomainId: value }),
  setShowWorldManager: (value) => set({ showWorldManager: value }),
  setWorlds: (value) => set({ worlds: value }),
  setWorldSaving: (value) => set({ worldSaving: value }),
  setWorldLoading: (value) => set({ worldLoading: value }),
  setEditingWorldId: (value) => set({ editingWorldId: value }),
  setForm: (updater) =>
    set((state) => ({
      form: typeof updater === "function" ? updater(state.form) : updater,
    })),
  setAiWorldPrompt: (value) => set({ aiWorldPrompt: value }),
  resetWorldForm: () =>
    set({
      editingWorldId: "",
      form: EMPTY_FORM,
    }),
}));
