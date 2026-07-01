type CreationMode = "ai" | "manual";
type CreationPhase = "idle" | "parsing" | "restructuring" | "memory" | "diagnose" | "complete" | "error";

export interface CreationOverlayState {
  active: boolean;
  mode: CreationMode;
  phase: CreationPhase;
  progress: number;
  logs: string[];
  message: string;
  error: string;
  signature: string;
  memoryNodesLit: number;
  exploding: boolean;
}

interface CreationOverlayProps {
  overlay: CreationOverlayState;
}

function creationLabel(phase: CreationPhase): string {
  const map: Record<CreationPhase, string> = {
    idle: "待机",
    parsing: "解析阶段",
    restructuring: "重组阶段",
    memory: "记忆灌注",
    diagnose: "诊断阶段",
    complete: "定型完成",
    error: "构建失败",
  };
  return map[phase];
}

export function CreationOverlay({ overlay }: CreationOverlayProps) {
  if (!overlay.active) {
    return null;
  }

  return (
    <div className={`creation-overlay ${overlay.mode} ${overlay.phase} ${overlay.exploding ? "explode" : ""}`}>
      <div className="creation-veil" />
      <div className="creation-panel">
        <div className="creation-core-wrap">
          {overlay.mode === "ai" ? (
            <div className="digital-core" aria-hidden>
              <div className="dodeca dodeca-a" />
              <div className="dodeca dodeca-b" />
              <div className="arc-electric arc-1" />
              <div className="arc-electric arc-2" />
            </div>
          ) : (
            <div className="memory-core" aria-hidden>
              <div className="memory-stream" />
              <div className="memory-stream delay" />
              <div className="neural-grid" />
            </div>
          )}
        </div>

        <p className="creation-mode">{overlay.mode === "ai" ? "数字降生" : "记忆灌注"}</p>
        <p className="creation-phase">{creationLabel(overlay.phase)}</p>
        <p className="creation-message">{overlay.error || overlay.message}</p>

        <div className="neon-loading-track" role="progressbar" aria-valuenow={overlay.progress}>
          <div className="neon-loading-fill" style={{ width: `${overlay.progress}%` }} />
        </div>

        {overlay.mode === "manual" ? (
          <div className="memory-nodes" aria-hidden>
            {Array.from({ length: 8 }).map((_, idx) => (
              <span key={`node-${idx}`} className={`memory-node ${idx < overlay.memoryNodesLit ? "lit" : ""}`} />
            ))}
          </div>
        ) : null}

        <div className="creation-logs">
          {overlay.logs.map((line, idx) => (
            <p key={`${line}-${idx}`}>{line}</p>
          ))}
        </div>

        {overlay.signature ? <p className="creation-signature">#{overlay.signature}</p> : null}
      </div>
    </div>
  );
}
