// Created by dev on 2026/05/21
// Reciprocal Rank Fusion (RRF) — k=60 (Azure AI / Dify 标准)

export interface RankedResult {
  id: string;
  score: number;
}

export function rrfFuse(
  vectorResults: RankedResult[],
  bm25Results: RankedResult[],
  k = 60,
): RankedResult[] {
  const scores = new Map<string, number>();

  for (let i = 0; i < vectorResults.length; i++) {
    const id = vectorResults[i].id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }

  for (let i = 0; i < bm25Results.length; i++) {
    const id = bm25Results[i].id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
