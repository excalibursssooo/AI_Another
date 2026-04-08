import { useEffect, useState } from "react";
import type { MouseEvent } from "react";

import { AiAgent } from "@/features/chat/types";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/stores/useChatStore";

interface AgentContextMenuState {
  agentId: string;
  agentName: string;
  x: number;
  y: number;
}

interface ChatSidebarProps {
  creatingPlaceholder: { active: boolean; name: string };
  onAddFriend: () => void;
  onDeleteAgent: (agentId: string, agentName: string) => Promise<void>;
}

export function ChatSidebar(props: ChatSidebarProps) {
  const { agents, selectedAgentId, setSelectedAgentId } = useChatStore(
    useShallow((state) => ({
      agents: state.agents,
      selectedAgentId: state.selectedAgentId,
      setSelectedAgentId: state.setSelectedAgentId,
    })),
  );
  const [contextMenu, setContextMenu] = useState<AgentContextMenuState | null>(null);
  const [deletingId, setDeletingId] = useState<string>("");

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("contextmenu", closeMenu);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const handleAgentContextMenu = (event: MouseEvent<HTMLButtonElement>, agent: AiAgent) => {
    event.preventDefault();
    setSelectedAgentId(agent.id);
    setContextMenu({
      agentId: agent.id,
      agentName: agent.name,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const handleDeleteAgent = async (agentId: string, agentName: string) => {
    if (deletingId) {
      return;
    }

    const confirmed = window.confirm(`确认删除角色「${agentName}」及其记忆吗？`);
    if (!confirmed) {
      return;
    }

    setContextMenu(null);
    setDeletingId(agentId);
    try {
      await props.onDeleteAgent(agentId, agentName);
    } finally {
      setDeletingId("");
    }
  };

  return (
    <aside className="panel-scroll flex min-h-0 flex-col border-b border-[var(--line-soft)] bg-[var(--surface-side)] lg:border-r lg:border-b-0">
      <div className="relative px-5 pt-6 pb-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">AI Contacts</p>
          <button
            type="button"
            onClick={props.onAddFriend}
            className="friend-fab absolute top-4 right-5 z-10 h-12 w-12 text-xl font-semibold text-[var(--brand-text)] transition-all duration-300 hover:scale-110"
            aria-label="添加好友"
          >
            +
          </button>
        </div>
        <h2 className="mt-2 text-2xl font-semibold text-[var(--text-main)]">联系人</h2>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-6">
        {props.creatingPlaceholder.active ? (
          <div className="agent-placeholder-card rounded-2xl border px-3 py-3 text-left">
            <div className="flex items-center gap-3">
              <span className="agent-placeholder-avatar h-9 w-9 rounded-full" aria-hidden />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--text-main)]">{props.creatingPlaceholder.name}</p>
                <p className="truncate text-xs text-[var(--text-muted)]">正在建立神经连接...</p>
              </div>
            </div>
          </div>
        ) : null}

        {agents.map((agent) => {
          const active = agent.id === selectedAgentId;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => setSelectedAgentId(agent.id)}
              onContextMenu={(event) => handleAgentContextMenu(event, agent)}
              className={`w-full rounded-2xl border px-3 py-3 text-left transition-all duration-300 ${
                active
                  ? "border-[var(--line-strong)] bg-[var(--surface-card)] shadow-[var(--shadow-neon)]"
                  : "border-transparent bg-transparent hover:border-[var(--line-soft)] hover:bg-[var(--surface-card)] hover:shadow-[var(--shadow-neon)]"
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="h-9 w-9 rounded-full ring-1 ring-white/20" style={{ backgroundColor: agent.avatarColor }} aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[var(--text-main)]">{agent.name}</p>
                  <p className="truncate text-xs text-[var(--text-muted)]">在线</p>
                </div>
              </div>
            </button>
          );
        })}

        {contextMenu ? (
          <div
            className="fixed z-50 min-w-[160px] rounded-xl border border-[var(--line-soft)] bg-[var(--surface-card)] p-1 shadow-[var(--shadow-main)]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-300 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={contextMenu.agentId === "default" || deletingId === contextMenu.agentId}
              onClick={() => void handleDeleteAgent(contextMenu.agentId, contextMenu.agentName)}
            >
              {contextMenu.agentId === "default"
                ? "默认角色不可删除"
                : deletingId === contextMenu.agentId
                  ? "删除中..."
                  : "删除角色"}
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
