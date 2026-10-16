export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Direction = "up" | "down" | "left" | "right";

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

// Escolhe o candidato mais próximo na direção, priorizando alinhamento no eixo.
export function pickNext(current: Rect, dir: Direction, candidates: Rect[]): number {
  const c = center(current);
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((r, i) => {
    const p = center(r);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    if (dir === "right" && dx <= 4) return;
    if (dir === "left" && dx >= -4) return;
    if (dir === "down" && dy <= 4) return;
    if (dir === "up" && dy >= -4) return;
    const primary = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const secondary = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
