import { FormEvent, memo } from "react";

import { WorldManager } from "@/features/chat/components/WorldManager";
import { ThemeMode } from "@/stores/useChatStore";
import { ChatMessage } from "@/features/chat/types";
import { WorldSummaryDto } from "@/lib/api/types_api";

interface ChatAreaProps {
  selectedAgentName?: string;
  notice: string;
  selectedDomainId: string;
  domainOptions: ReadonlyArray<WorldSummaryDto>;
  themeMode: ThemeMode;
  showWorldManager: boolean;
  messages: ReadonlyArray<ChatMessage>;
  input: string;
  onInputChange: (value: string) => void;
  onSendMessage: (event: FormEvent) => void;
  onThemeModeChange: (value: ThemeMode) => void;
  onDomainChange: (domainId: string) => void;
  onToggleWorldManager: () => void;
  isSending: boolean;
}

export const ChatArea = memo(function ChatArea(props: ChatAreaProps) {
  return (
    <main className="panel-scroll flex min-h-0 min-w-0 flex-col bg-[var(--surface-main)]/90">
      <header className="border-b border-[var(--line-soft)] px-5 py-4 md:px-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Current AI</p>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--text-main)]">{props.selectedAgentName}</h1>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{props.notice}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-[var(--text-muted)]" htmlFor="world-domain-select">
              模式
            </label>
            <select
              id="world-domain-select"
              value={props.selectedDomainId}
              onChange={(event) => props.onDomainChange(event.target.value)}
              className="rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-2.5 py-1.5 text-xs text-[var(--text-main)] outline-none"
            >
              {props.domainOptions.map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.name}
                </option>
              ))}
            </select>
            <div className="ml-2 inline-flex rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] p-0.5">
              <button
                type="button"
                onClick={() => props.onThemeModeChange("neon")}
                className={`rounded-md px-2 py-1 text-xs transition-all ${
                  props.themeMode === "neon" ? "bg-[var(--bubble-user)] text-[var(--brand-text)]" : "text-[var(--text-muted)]"
                }`}
              >
                Neon
              </button>
              <button
                type="button"
                onClick={() => props.onThemeModeChange("dawn")}
                className={`rounded-md px-2 py-1 text-xs transition-all ${
                  props.themeMode === "dawn" ? "bg-[var(--bubble-user)] text-[var(--brand-text)]" : "text-[var(--text-muted)]"
                }`}
              >
                Dawn
              </button>
            </div>
            <button
              type="button"
              onClick={props.onToggleWorldManager}
              className="ml-2 rounded-lg border border-[var(--line-soft)] bg-[var(--surface-card)] px-2.5 py-1.5 text-xs text-[var(--text-main)]"
            >
              世界管理
            </button>
          </div>
        </div>
      </header>

      {props.showWorldManager ? <WorldManager /> : null}

      <section className="flex-1 space-y-3 overflow-y-auto px-4 py-4 md:px-8">
        {props.messages.map((msg) => (
          <article
            key={msg.id}
            className={`max-w-[86%] rounded-2xl border px-4 py-3 text-sm leading-7 shadow-[0_8px_24px_rgba(7,10,31,0.45)] transition-all duration-300 ${
              msg.role === "user"
                ? "ml-auto border-fuchsia-300/30 bg-[var(--bubble-user)] text-[var(--bubble-user-text)]"
                : "border-cyan-300/20 bg-[var(--bubble-ai)] text-[var(--text-main)] backdrop-blur-sm"
            }`}
          >
            <p>{msg.content || (msg.isStreaming ? "正在输入..." : "")}</p>
            <p className="mt-2 text-[11px] opacity-70">{msg.createdAt}</p>
          </article>
        ))}
      </section>

      <form onSubmit={props.onSendMessage} className="border-t border-[var(--line-soft)] px-4 py-4 md:px-8">
        <div className="flex items-end gap-3 rounded-2xl border border-[var(--line-soft)] bg-[var(--surface-card)]/95 p-3 shadow-[var(--shadow-neon)] backdrop-blur-sm">
          <textarea
            value={props.input}
            onChange={(event) => props.onInputChange(event.target.value)}
            rows={2}
            placeholder="输入你想对 TA 说的话..."
            className="min-h-[60px] flex-1 resize-none bg-transparent text-sm text-[var(--text-main)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <button
            type="submit"
            disabled={props.isSending}
            className="rounded-xl bg-[var(--brand-main)] px-4 py-2 text-sm font-semibold text-[var(--brand-text)] transition-all duration-300 hover:scale-[1.03] hover:shadow-[0_0_28px_rgba(168,85,247,0.6)] disabled:opacity-70"
          >
            {props.isSending ? "发送中..." : "发送"}
          </button>
        </div>
      </form>
    </main>
  );
});
