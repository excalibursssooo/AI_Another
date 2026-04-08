import { useWorldSettings } from "@/features/chat/hooks/useWorldSettings";
import { useWorldStore } from "@/stores/useWorldStore";
import { useShallow } from "zustand/react/shallow";

export function WorldManager() {
  const {
    form,
    setForm,
    worldSaving,
    worldLoading,
    worlds,
    editingWorldId,
    aiWorldPrompt,
    setAiWorldPrompt,
    selectedDomainId,
  } = useWorldStore(
    useShallow((state) => ({
      form: state.form,
      setForm: state.setForm,
      worldSaving: state.worldSaving,
      worldLoading: state.worldLoading,
      worlds: state.worlds,
      editingWorldId: state.editingWorldId,
      aiWorldPrompt: state.aiWorldPrompt,
      setAiWorldPrompt: state.setAiWorldPrompt,
      selectedDomainId: state.selectedDomainId,
    })),
  );
  const {
    saveWorldHandle,
    resetWorldForm,
    aiCreateWorldHandle,
    editWorldHandle,
  } = useWorldSettings();

  return (
    <section className="border-b border-[var(--line-soft)] px-5 py-4 md:px-8">
      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">创建或编辑世界</p>
          <div className="grid gap-2 md:grid-cols-2">
            <input
              value={form.id}
              onChange={(event) => setForm((prev) => ({ ...prev, id: event.target.value }))}
              placeholder="世界ID（英文/数字/_/-）"
              disabled={Boolean(editingWorldId)}
              className="w-full rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-3 py-2 text-xs text-[var(--text-main)] outline-none disabled:opacity-60"
            />
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="世界名称"
              className="w-full rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-3 py-2 text-xs text-[var(--text-main)] outline-none"
            />
          </div>
          <textarea
            value={form.lore}
            onChange={(event) => setForm((prev) => ({ ...prev, lore: event.target.value }))}
            rows={4}
            placeholder="世界背景 lore"
            className="w-full rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-3 py-2 text-xs text-[var(--text-main)] outline-none"
          />
          <input
            value={form.tone}
            onChange={(event) => setForm((prev) => ({ ...prev, tone: event.target.value }))}
            placeholder="语气 tone"
            className="w-full rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-3 py-2 text-xs text-[var(--text-main)] outline-none"
          />
          <div className="grid gap-2 md:grid-cols-2">
            <textarea
              value={form.constraintsText}
              onChange={(event) => setForm((prev) => ({ ...prev, constraintsText: event.target.value }))}
              rows={4}
              placeholder="约束（每行一条）"
              className="w-full rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-3 py-2 text-xs text-[var(--text-main)] outline-none"
            />
            <textarea
              value={form.seedMemoriesText}
              onChange={(event) => setForm((prev) => ({ ...prev, seedMemoriesText: event.target.value }))}
              rows={4}
              placeholder="种子记忆（每行一条）"
              className="w-full rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-3 py-2 text-xs text-[var(--text-main)] outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void saveWorldHandle()}
              disabled={worldSaving}
              className="rounded-lg bg-[var(--brand-main)] px-3 py-1.5 text-xs font-semibold text-[var(--brand-text)] disabled:opacity-60"
            >
              {editingWorldId ? "保存世界编辑" : "创建新世界"}
            </button>
            <button
              type="button"
              onClick={resetWorldForm}
              className="rounded-lg border border-[var(--line-soft)] px-3 py-1.5 text-xs text-[var(--text-main)]"
            >
              新建空白
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">AI 生成世界</p>
          <textarea
            value={aiWorldPrompt}
            onChange={(event) => setAiWorldPrompt(event.target.value)}
            rows={4}
            placeholder="例如：一个蒸汽朋克与修仙并存、阶层对抗尖锐的浮空城世界"
            className="w-full rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-3 py-2 text-xs text-[var(--text-main)] outline-none"
          />
          <button
            type="button"
            onClick={() => void aiCreateWorldHandle()}
            disabled={worldSaving}
            className="w-full rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-3 py-2 text-xs font-semibold text-[var(--text-main)] disabled:opacity-60"
          >
            AI 生成并保存
          </button>
          <p className="text-xs text-[var(--text-muted)]">当前会参考已选模式 {selectedDomainId} 作为风格基底。</p>
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] p-2">
            {worldLoading ? <p className="text-xs text-[var(--text-muted)]">加载中...</p> : null}
            {!worldLoading && worlds.length === 0 ? <p className="text-xs text-[var(--text-muted)]">暂无自定义世界</p> : null}
            {worlds.map((world) => (
              <button
                key={world.id}
                type="button"
                onClick={() => void editWorldHandle(world.id)}
                className="w-full rounded-md border border-transparent px-2 py-1 text-left text-xs text-[var(--text-main)] transition hover:border-[var(--line-soft)]"
              >
                {world.name} ({world.id})
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
