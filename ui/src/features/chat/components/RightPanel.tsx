import type { FormEvent } from "react";

import type { AiAgent } from "@/features/chat/types";
import type { AgentLiveStateDto, PostItemDto } from "@/lib/api/types_api";

export type RightPanelTab = "state" | "feed";

interface RightPanelProps {
  activeTab: RightPanelTab;
  selectedAgent?: AiAgent;
  selectedLiveState?: AgentLiveStateDto;
  displayMoodIndex: number;
  displayHeartbeatBpm: number;
  displayStressLevel: number;
  heartbeatDuration: string;
  onVitalsContainerElement?: (element: HTMLDivElement | null) => void;
  feedPosts: ReadonlyArray<PostItemDto>;
  feedLoading: boolean;
  isGeneratingPost: boolean;
  showAddFriendMenu: boolean;
  showCustomCreateForm: boolean;
  draftName: string;
  draftPersona: string;
  draftStyle: string;
  formatAgo: (iso: string) => string;
  onTabChange: (tab: RightPanelTab) => void;
  onGeneratePost: () => void;
  onTriggerFromPost: (post: PostItemDto) => void;
  onShowCustomCreateFormChange: (show: boolean) => void;
  onAiCreateAgent: () => void;
  onCreateAgent: () => void;
  onDraftNameChange: (value: string) => void;
  onDraftPersonaChange: (value: string) => void;
  onDraftStyleChange: (value: string) => void;
}

function moodText(label: string): string {
  const map: Record<string, string> = {
    calm: "平静",
    happy: "愉悦",
    sad: "低落",
    anxious: "焦虑",
    angry: "激动",
    focused: "专注",
    neutral: "稳定",
  };
  return map[label] ?? label;
}

export function RightPanel(props: RightPanelProps) {
  return (
    <aside className="panel-scroll flex min-h-0 flex-col border-t border-[var(--line-soft)] bg-[var(--surface-side)] lg:border-t-0 lg:border-l">
      <div className="border-b border-[var(--line-soft)] px-4 py-3">
        <p className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">Agent 侧栏</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => props.onTabChange("state")}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
              props.activeTab === "state"
                ? "border-[var(--line-strong)] bg-[var(--surface-card)] text-[var(--text-main)]"
                : "border-[var(--line-soft)] text-[var(--text-muted)]"
            }`}
          >
            状态
          </button>
          <button
            type="button"
            onClick={() => props.onTabChange("feed")}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
              props.activeTab === "feed"
                ? "border-[var(--line-strong)] bg-[var(--surface-card)] text-[var(--text-main)]"
                : "border-[var(--line-soft)] text-[var(--text-muted)]"
            }`}
          >
            动态
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {props.activeTab === "state" ? (
          <StatePanel
            selectedAgent={props.selectedAgent}
            selectedLiveState={props.selectedLiveState}
            displayMoodIndex={props.displayMoodIndex}
            displayHeartbeatBpm={props.displayHeartbeatBpm}
            displayStressLevel={props.displayStressLevel}
            heartbeatDuration={props.heartbeatDuration}
            onVitalsContainerElement={props.onVitalsContainerElement}
            formatAgo={props.formatAgo}
          />
        ) : (
          <FeedPanel {...props} />
        )}

        {props.showAddFriendMenu ? <AddFriendPanel {...props} /> : null}
      </div>
    </aside>
  );
}

interface StatePanelProps {
  selectedAgent?: AiAgent;
  selectedLiveState?: AgentLiveStateDto;
  displayMoodIndex: number;
  displayHeartbeatBpm: number;
  displayStressLevel: number;
  heartbeatDuration: string;
  onVitalsContainerElement?: (element: HTMLDivElement | null) => void;
  formatAgo: (iso: string) => string;
}

function StatePanel({
  selectedAgent,
  selectedLiveState,
  displayMoodIndex,
  displayHeartbeatBpm,
  displayStressLevel,
  heartbeatDuration,
  onVitalsContainerElement,
  formatAgo,
}: StatePanelProps) {
  return (
    <>
      {!selectedAgent ? (
        <section className="rounded-2xl border border-dashed border-[var(--line-soft)] bg-[var(--surface-card)] p-4 text-sm text-[var(--text-muted)]">
          当前未选择联系人
        </section>
      ) : (
        <section
          ref={onVitalsContainerElement}
          className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[var(--text-muted)]">当前心情</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text-main)]">
                {moodText(selectedLiveState?.mood_label ?? "calm")}
              </p>
            </div>
            <div className="heartbeat-core" style={{ ["--beat-duration" as string]: heartbeatDuration }}>
              <span className="heartbeat-ring" />
              <span className="heartbeat-dot" />
            </div>
          </div>
          <div className="mt-4 h-2 rounded-full bg-white/10">
            <div
              className="h-2 rounded-full transition-all duration-500"
              style={{
                width: `${displayMoodIndex}%`,
                backgroundImage: "linear-gradient(120deg, #8a2be2 0%, #d946ef 42%, #22d3ee 100%)",
                boxShadow: "0 0 14px rgba(168,85,247,0.45)",
              }}
            />
          </div>
          <p className="mt-2 text-xs text-[var(--text-muted)]">心情指数 {displayMoodIndex} / 100</p>
        </section>
      )}

      {selectedAgent ? (
        <section className="grid grid-cols-2 gap-2">
          <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
            <p className="text-xs text-[var(--text-muted)]">心跳频率</p>
            <p className="mt-1 text-base font-semibold text-[var(--text-main)]">{displayHeartbeatBpm} bpm</p>
          </article>
          <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
            <p className="text-xs text-[var(--text-muted)]">压力水平</p>
            <p className="mt-1 text-base font-semibold text-[var(--text-main)]">{Math.round(displayStressLevel * 100)}%</p>
            <div className="mt-2 h-1.5 rounded-full bg-white/10">
              <div
                className="h-1.5 rounded-full transition-all duration-500"
                style={{
                  width: `${Math.round(displayStressLevel * 100)}%`,
                  backgroundImage: "linear-gradient(90deg, rgba(34,211,238,0.9), rgba(244,114,182,0.95))",
                }}
              />
            </div>
          </article>
          <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
            <p className="text-xs text-[var(--text-muted)]">趋势</p>
            <p className="mt-1 text-base font-semibold text-[var(--text-main)]">{selectedLiveState?.trend ?? "steady"}</p>
          </article>
          <article className="rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
            <p className="text-xs text-[var(--text-muted)]">最后更新</p>
            <p className="mt-1 text-base font-semibold text-[var(--text-main)]">
              {selectedLiveState ? formatAgo(selectedLiveState.updated_at) : "未更新"}
            </p>
          </article>
        </section>
      ) : null}

      {selectedAgent ? (
        <section className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-4 text-sm text-[var(--text-muted)]">
          风险等级: <span className="text-[var(--text-main)]">{selectedLiveState?.risk_level ?? "low"}</span>
        </section>
      ) : null}
    </>
  );
}

function FeedPanel(props: RightPanelProps) {
  return (
    <>
      <section className="rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3">
        <button
          type="button"
          onClick={() => props.onGeneratePost()}
          disabled={props.isGeneratingPost || !props.selectedAgent}
          className="w-full rounded-xl bg-[var(--brand-main)] px-4 py-2 text-sm font-semibold text-[var(--brand-text)] transition-all duration-300 hover:scale-[1.02] disabled:opacity-60"
        >
          {props.isGeneratingPost ? "生成中..." : `让 ${props.selectedAgent?.name ?? "AI"} 发一条动态`}
        </button>
        <p className="mt-2 text-xs text-[var(--text-muted)]">点击动态卡片可将话题注入输入框。</p>
      </section>

      {props.feedLoading ? <p className="text-xs text-[var(--text-muted)]">动态加载中...</p> : null}

      {!props.feedLoading && props.feedPosts.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-[var(--line-soft)] bg-[var(--surface-card)] p-4 text-sm text-[var(--text-muted)]">
          还没有动态，先生成一条试试。
        </section>
      ) : null}

      {props.feedPosts.map((post) => (
        <button
          key={post.id}
          type="button"
          onClick={() => props.onTriggerFromPost(post)}
          className="w-full rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-4 text-left transition-all duration-300 hover:shadow-[var(--shadow-neon)]"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">{post.agent_name}</p>
            <p className="text-xs text-[var(--text-muted)]">{props.formatAgo(post.created_at)}</p>
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--text-main)]">{post.content}</p>
          <p className="mt-2 text-xs text-[var(--text-muted)]">话题: {post.topic_seed}</p>
        </button>
      ))}
    </>
  );
}

function AddFriendPanel(props: RightPanelProps) {
  if (!props.showCustomCreateForm) {
    return (
      <section className="friend-pop space-y-3 border-t border-[var(--line-soft)] pt-3">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">添加好友</p>
        <button
          type="button"
          onClick={() => props.onShowCustomCreateFormChange(true)}
          className="w-full rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] px-4 py-3 text-left text-sm font-semibold text-[var(--text-main)] transition-all duration-300 hover:shadow-[var(--shadow-neon)]"
        >
          自定义你的ta
        </button>
        <button
          type="button"
          onClick={() => props.onAiCreateAgent()}
          className="w-full rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] px-4 py-3 text-left text-sm font-semibold text-[var(--text-main)] transition-all duration-300 hover:shadow-[var(--shadow-neon)]"
        >
          你有一个好友申请
        </button>
      </section>
    );
  }

  const submitForm = (event: FormEvent) => {
    event.preventDefault();
    props.onCreateAgent();
  };

  return (
    <section className="friend-pop space-y-3 border-t border-[var(--line-soft)] pt-3">
      <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">添加好友</p>
      <form
        onSubmit={submitForm}
        className="friend-pop space-y-2 rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-3 shadow-[var(--shadow-neon)]"
      >
        <p className="text-sm font-semibold text-[var(--text-main)]">自定义你的ta</p>
        <input
          value={props.draftName}
          onChange={(event) => props.onDraftNameChange(event.target.value)}
          placeholder="昵称"
          className="w-full rounded-lg border border-[var(--line-soft)] bg-transparent px-3 py-2 text-sm text-[var(--text-main)] outline-none transition-all duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] focus:shadow-[var(--shadow-neon)]"
        />
        <input
          value={props.draftPersona}
          onChange={(event) => props.onDraftPersonaChange(event.target.value)}
          placeholder="个性"
          className="w-full rounded-lg border border-[var(--line-soft)] bg-transparent px-3 py-2 text-sm text-[var(--text-main)] outline-none transition-all duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] focus:shadow-[var(--shadow-neon)]"
        />
        <input
          value={props.draftStyle}
          onChange={(event) => props.onDraftStyleChange(event.target.value)}
          placeholder="说话风格"
          className="w-full rounded-lg border border-[var(--line-soft)] bg-transparent px-3 py-2 text-sm text-[var(--text-main)] outline-none transition-all duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] focus:shadow-[var(--shadow-neon)]"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            className="flex-1 rounded-lg bg-[var(--brand-main)] px-3 py-2 text-sm font-semibold text-[var(--brand-text)] transition-all duration-300 hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(217,70,239,0.45)]"
          >
            添加
          </button>
          <button
            type="button"
            onClick={() => props.onShowCustomCreateFormChange(false)}
            className="rounded-lg border border-[var(--line-soft)] px-3 py-2 text-sm text-[var(--text-main)]"
          >
            返回
          </button>
        </div>
      </form>
    </section>
  );
}
