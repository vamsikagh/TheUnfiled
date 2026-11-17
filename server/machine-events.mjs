const actions = {
  ACCESS_GRANTED: 'Credential accepted',
  ACCESS_DENIED: 'Credential denied',
  DOOR_OPEN: 'Door opened',
  DOOR_CLOSED: 'Door closed',
};
const phase = {
  ACCESS_GRANTED: /\b(?:access granted|accepted|badge read|swip(?:ed|e))\b/i,
  ACCESS_DENIED: /\b(?:access denied|credential denied)\b/i,
  DOOR_OPEN: /\bopen(?:ed|ing)?\b/i,
  DOOR_CLOSED: /\bclos(?:e|ed|ing)\b/i,
};
const clock = (text) => /(?:^|[T\s])(\d\d:\d\d:\d\d)(?!\d)/.exec(text)?.[1];
const timeKey = (text) => /\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d)?/.exec(text)?.[0].replace('T', ' ');

export function machineRecords(passages) {
  const records = new Map();
  for (const source of passages) {
    if (!source.document.toLowerCase().endsWith('.log')) continue;
    for (const text of source.text.split(/\r?\n/)) {
      const entry = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d))\s+[^\r\n]*?\b(ACCESS_GRANTED|ACCESS_DENIED|DOOR_OPEN|DOOR_CLOSED)\b/.exec(text);
      if (!entry) continue;
      const [, when, action] = entry;
      const row = records.get(text) || { when, action, title: actions[action], narrative: text, sources: [] };
      if (!row.sources.includes(source.id)) row.sources.push(source.id);
      records.set(text, row);
    }
  }
  return [...records.values()];
}

export function applyMachineTimeline(timeline, records) {
  if (!records.length) return timeline;
  const observedIds = new Set(records.flatMap((row) => row.sources));
  const retained = timeline.filter((row) => {
    if (!row.sources.length || !row.sources.every((id) => observedIds.has(id))) return true;
    const display = row.when + ' ' + row.title + ' ' + row.narrative;
    const start = timeKey(row.when);
    return !records.some((record) => record.sources.some((id) => row.sources.includes(id)) &&
      (display.includes(clock(record.when)) || (start && timeKey(record.when).startsWith(start))) &&
      Object.values(phase).some((pattern) => pattern.test(display)));
  });
  const exact = records.map(({ when, title, narrative, sources }) => ({ when, title, narrative, sources }));
  return [...retained, ...exact].sort((a, b) => {
    const left = timeKey(a.when);
    const right = timeKey(b.when);
    return left && right ? left.localeCompare(right) : left ? -1 : right ? 1 : 0;
  });
}

export function correctMachineTimestamps(text, sourceIds, records) {
  const relevant = records.filter((item) => item.sources.some((id) => sourceIds.includes(id)));
  if (!relevant.length) return text;
  return text.split(/(?<=[.!?])\s+/).map((sentence) => {
    const conflict = [...sentence.matchAll(/\b(?:at|by)\s+(\d\d:\d\d:\d\d)(?!\d)/gi)].some((match) => {
      const lead = sentence.slice(Math.max(0, match.index - 70), match.index);
      const actionsMentioned = Object.entries(phase).filter(([, pattern]) => pattern.test(lead));
      if (actionsMentioned.length !== 1) return false;
      const [action] = actionsMentioned[0];
      const matches = relevant.filter((row) => row.action === action);
      return matches.length > 0 && !matches.some((row) => clock(row.when) === match[1]) &&
        relevant.some((row) => clock(row.when) === match[1]);
    });
    if (!conflict) return sentence;
    return 'The cited access log records the following separate events. ' +
      relevant.map((row) => row.title + ' at ' + clock(row.when) + '.').join(' ');
  }).filter((sentence, index, all) => all.indexOf(sentence) === index).join(' ');
}
