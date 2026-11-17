export function rankConclusion(hypotheses) {
  const ranked = hypotheses.filter(({ score }) => Number.isFinite(score)).toSorted((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const score = ranked[0].score;
  const leaders = ranked.filter((item) => item.score === score);
  return {
    score,
    leaders: leaders.map(({ explanation, claims }) => ({
      explanation,
      sources: [...new Set(claims.flatMap((claim) => [...claim.support, ...claim.conflict]))],
    })),
    margin: leaders.length === 1 && ranked.length > 1 ? score - ranked[1].score : null,
  };
}
