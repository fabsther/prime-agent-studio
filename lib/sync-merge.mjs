// Conflict-free merge of native Prime Agent session entries.
// Entries form a tree (id/parentId); the native resume leaf is the LAST entry
// in the file. Merge = union by entry id; the newest leaf is placed last.
import { randomUUID } from 'node:crypto';

const REFS = ['parentId', 'firstKeptEntryId', 'fromId', 'targetId'];
export const parse = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
export const serialize = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const time = (e) => Date.parse(e?.timestamp) || 0;

// local: [header, ...entries]; remote: entries only; remoteLeaf: remote active id.
export function mergeEntries(local, remote, remoteLeaf) {
  const [header, ...mine] = local;
  const byId = new Map(mine.map((e) => [e.id, e]));
  // Same short id with different content (independent machines): fresh id.
  const remap = new Map();
  for (const e of remote) if (byId.has(e.id) && !same(byId.get(e.id), e)) remap.set(e.id, randomUUID());
  const fix = (e) => {
    if (!remap.size) return e;
    const copy = { ...e, id: remap.get(e.id) ?? e.id };
    for (const key of REFS) if (remap.has(copy[key])) copy[key] = remap.get(copy[key]);
    return copy;
  };
  const added = remote.map(fix).filter((e) => !byId.has(e.id));
  const union = [...mine, ...added];
  const all = new Map(union.map((e) => [e.id, e]));
  const localLeaf = mine.at(-1)?.id;
  const theirs = remap.get(remoteLeaf) ?? remoteLeaf;
  const active = all.has(theirs) && time(all.get(theirs)) > time(all.get(localLeaf)) ? theirs : localLeaf;
  const path = new Set();
  for (let id = active; id && all.has(id) && !path.has(id); id = all.get(id).parentId) path.add(id);
  // Parents first; active-path entries deferred so the active leaf ends the file.
  const placed = new Set(),
    out = [];
  const ready = (e) => !e.parentId || placed.has(e.parentId) || !all.has(e.parentId);
  let pending = union;
  while (pending.length) {
    const next = pending.find((e) => !path.has(e.id) && ready(e)) ?? pending.find(ready);
    if (!next) throw new Error('Cycle or missing parent order');
    out.push(next);
    placed.add(next.id);
    pending = pending.filter((e) => e !== next);
  }
  if (out.length && out.at(-1).id !== active) throw new Error('Active leaf is not last');
  return { entries: [header, ...out], active, added: added.length, remapped: remap.size };
}
