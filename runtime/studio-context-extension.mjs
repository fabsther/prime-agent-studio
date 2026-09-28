// Request-only context hygiene: the persisted session and Studio history stay unchanged.
// Kernel restore notices list every Python name (often thousands of characters) at each
// compaction or resume. Long lists become a count; the model can call dir() when needed.
// Per-message and deterministic, so the provider prompt cache stays valid.
const TYPES = new Set(['ipython_state', 'ipython_state_restored']);
const LIST = /These names are (still defined|available again): ([A-Za-z0-9_]+(?:, [A-Za-z0-9_]+)*)\./g;
const MAX_NAMES = 40;

export function shortenNameLists(text) {
  return text.replace(LIST, (all, state, names) => {
    const count = names.split(', ').length;
    return count <= MAX_NAMES ? all : `${count} names are ${state}; run dir() in the kernel to list them.`;
  });
}

export default function studioContext(pi) {
  pi.on('context', (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message?.role !== 'custom' || !TYPES.has(message.customType) || typeof message.content !== 'string')
        return message;
      const content = shortenNameLists(message.content);
      if (content === message.content) return message;
      changed = true;
      return { ...message, content };
    });
    return changed ? { messages } : undefined;
  });
}
