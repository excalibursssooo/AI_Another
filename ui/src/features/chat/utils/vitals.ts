export interface VitalsBase {
  heartbeat: number;
  stress: number;
  mood: number;
}

export interface VitalsJitter {
  heartbeat: number;
  stress: number;
  mood: number;
}

export function calculateVitalsJitter(base: VitalsBase, t: number): VitalsJitter {
  const heartbeatJitter = 2.6 * Math.sin(t * 2.2) + 1.3 * Math.sin(t * 3.7);
  const stressJitter = 0.035 * Math.sin(t * 1.8);
  const moodJitter = 1.9 * Math.sin(t * 1.2);

  return {
    heartbeat: Math.max(55, Math.min(130, Math.round(base.heartbeat + heartbeatJitter))),
    stress: Math.max(0, Math.min(1, base.stress + stressJitter)),
    mood: Math.max(0, Math.min(100, Math.round(base.mood + moodJitter))),
  };
}
