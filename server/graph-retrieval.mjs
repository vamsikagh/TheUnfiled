const key = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (text) => new Set(key(text).split(' ').filter((word) => word.length >= 3));

/** Follow evidence → event → shared entity → linked event → evidence. */
export function followEvidenceLinks(graph, sourceById, query, seeds, exclude = seeds, limit = 4) {
  if (!graph?.events.length) return [];
  const taggedQuery = ' ' + key(query) + ' ';
  const queryWords = words(query);
  const seedRank = new Map(seeds.map(({ id }, index) => [id, index]));
  const excluded = new Set(exclude.map(({ id }) => id));
  const entityNames = new Map(graph.entities.map(({ name }) => [key(name), name]));
  const anchors = new Map();
  const linked = new Map();

  for (const event of graph.events) {
    const ranks = event.sources.map((id) => seedRank.get(id)).filter((rank) => rank !== undefined);
    for (const name of event.entities) {
      const entity = key(name);
      if (!entity || !entityNames.has(entity)) continue;
      if (!linked.has(entity)) linked.set(entity, []);
      linked.get(entity).push(event);
      const explicit = entity.length >= 4 && taggedQuery.includes(' ' + entity + ' ');
      if (!explicit && !ranks.length) continue;
      const strength = explicit ? 10 : 3 - Math.min(...ranks) * 0.5;
      const previous = anchors.get(entity);
      if (!previous || previous.strength < strength) anchors.set(entity, { event, strength });
    }
  }

  const candidates = new Map();
  for (const [entity, anchor] of anchors) {
    for (const event of linked.get(entity)) {
      if (event === anchor.event) continue;
      const overlap = [...words(event.event)].filter((word) => queryWords.has(word) && !entity.split(' ').includes(word)).length;
      for (const id of event.sources) {
        const passage = sourceById.get(id);
        if (!passage || excluded.has(id)) continue;
        const score = anchor.strength + Math.min(overlap, 4);
        if ((candidates.get(id)?.score ?? -1) >= score) continue;
        candidates.set(id, { score, passage, entity: entityNames.get(entity), from: anchor.event.event, to: event.event });
      }
    }
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ score, ...path }) => path);
}
