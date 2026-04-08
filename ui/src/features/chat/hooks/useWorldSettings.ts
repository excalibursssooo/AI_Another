import { useCallback, useEffect, useRef } from "react";

import { createWorld, createWorldByAi, getWorld, getWorldDebug, listWorlds, updateWorld } from "@/lib/api/companion";
import { WorldDetailDto } from "@/lib/api/types_api";
import { getErrorMessage } from "@/lib/utils/error";
import { useWorldStore } from "@/stores/useWorldStore";

interface UseWorldSettingsOptions {
  onNotice: (message: string) => void;
  onFatalError: (message: string) => void;
}

export function useWorldSettings(options?: Partial<UseWorldSettingsOptions>) {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const onNotice = useCallback((message: string) => {
    optionsRef.current?.onNotice?.(message);
  }, []);

  const onFatalError = useCallback((message: string) => {
    optionsRef.current?.onFatalError?.(message);
  }, []);

  const fillWorldForm = useCallback((world: WorldDetailDto) => {
    const { setEditingWorldId, setForm } = useWorldStore.getState();
    setEditingWorldId(world.id);
    setForm({
      id: world.id,
      name: world.name,
      lore: world.lore,
      tone: world.tone,
      constraintsText: world.constraints.join("\n"),
      seedMemoriesText: world.seed_memories.join("\n"),
    });
  }, []);

  const loadWorldDebug = useCallback(
    async (domainId?: string) => {
      try {
        const data = await getWorldDebug(domainId);
        const { selectedDomainId, setWorldDebug, setSelectedDomainId } = useWorldStore.getState();
        setWorldDebug(data);
        const nextDomainId =
          domainId && domainId.trim()
            ? domainId
            : selectedDomainId && selectedDomainId !== "default"
              ? selectedDomainId
              : data.active_domain_id || data.default_domain_id || "default";
        setSelectedDomainId(nextDomainId);
      } catch (error) {
        const message = `世界域加载失败: ${getErrorMessage(error)}`;
        onFatalError(message);
        onNotice(message);
      }
    },
    [onFatalError, onNotice],
  );

  const loadWorldsHandle = useCallback(async () => {
    const { setWorldLoading, setWorlds } = useWorldStore.getState();
    setWorldLoading(true);
    try {
      const rows = await listWorlds();
      setWorlds([...rows.filter((item) => item.id !== "default")]);
    } catch (error) {
      onNotice(`世界列表加载失败: ${getErrorMessage(error)}`);
    } finally {
      setWorldLoading(false);
    }
  }, [onNotice]);

  const saveWorldHandle = useCallback(async () => {
    const { worldSaving, form, editingWorldId, setWorldSaving, setSelectedDomainId } = useWorldStore.getState();
    if (worldSaving) {
      return;
    }

    const name = form.name.trim();
    if (!name) {
      onNotice("世界名称不能为空");
      return;
    }

    const payload = {
      id: form.id.trim() || undefined,
      name,
      lore: form.lore.trim(),
      tone: form.tone.trim(),
      constraints: form.constraintsText
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
      seed_memories: form.seedMemoriesText
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
    };

    setWorldSaving(true);
    try {
      const saved = editingWorldId ? await updateWorld(editingWorldId, payload) : await createWorld(payload);
      await loadWorldDebug(saved.id);
      await loadWorldsHandle();
      setSelectedDomainId(saved.id);
      fillWorldForm(saved);
      onNotice(`世界已保存: ${saved.name}`);
    } catch (error) {
      onNotice(`世界保存失败: ${getErrorMessage(error)}`);
    } finally {
      setWorldSaving(false);
    }
  }, [fillWorldForm, loadWorldDebug, loadWorldsHandle, onNotice]);

  const aiCreateWorldHandle = useCallback(async () => {
    const { worldSaving, aiWorldPrompt, selectedDomainId, setWorldSaving, setSelectedDomainId, setAiWorldPrompt } =
      useWorldStore.getState();
    if (worldSaving) {
      return;
    }

    setWorldSaving(true);
    try {
      const created = await createWorldByAi({
        prompt: aiWorldPrompt.trim() || undefined,
        base_domain_id: selectedDomainId,
      });
      await loadWorldDebug(created.world.id);
      await loadWorldsHandle();
      setSelectedDomainId(created.world.id);
      fillWorldForm(created.world);
      setAiWorldPrompt("");
      onNotice(`AI 已生成新世界: ${created.world.name}`);
    } catch (error) {
      onNotice(`AI 生成世界失败: ${getErrorMessage(error)}`);
    } finally {
      setWorldSaving(false);
    }
  }, [fillWorldForm, loadWorldDebug, loadWorldsHandle, onNotice]);

  const editWorldHandle = useCallback(
    async (worldId: string) => {
      try {
        const world = await getWorld(worldId);
        fillWorldForm(world);
      } catch (error) {
        onNotice(`世界详情加载失败: ${getErrorMessage(error)}`);
      }
    },
    [fillWorldForm, onNotice],
  );

  const resetWorldForm = useCallback(() => {
    useWorldStore.getState().resetWorldForm();
  }, []);

  return {
    loadWorldDebug,
    loadWorldsHandle,
    saveWorldHandle,
    aiCreateWorldHandle,
    editWorldHandle,
    fillWorldForm,
    resetWorldForm,
  };
}
