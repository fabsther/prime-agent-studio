import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '/* Studio: child cancellation is not parent cancellation. */';
let packageRoot;
export function initialize(data) {
  packageRoot = resolve(data.packageRoot);
}

// A deleted child aborts its own recursive wait. Let the native parent loop
// re-snapshot the tree rather than reject its completion barrier and close it.
export function transformSessionQuiescence(source, { required = false } = {}) {
  if (!source.includes('async waitForRlmQuiescence(') && !required)
    return { source, changed: false };
  const methods = [...source.matchAll(
    /^( +)async waitForRlmQuiescence\(externalSignal\) \{[\s\S]*?^\1\}/gm,
  )];
  const unsupported = () => new Error('Prime Agent child completion layout changed; update the Studio adapter.');
  if (methods.length !== 1) throw unsupported();
  const method = methods[0];
  const call = 'child.waitForRlmQuiescence(cancellation.signal)';
  const replacement = `${call}.catch((error) => {
                        ${MARKER}
                        if (cancellation.signal.aborted || error?.message !== "RLM quiescence wait cancelled") throw error;
                    })`;
  if (method[0].split(call).length !== 2 ||
      !method[0].includes('while (true)') ||
      !method[0].includes('cancellation.signal.aborted') ||
      !method[0].includes('this._rlmQuiescenceWaitAborts.add(cancellation)')) throw unsupported();
  if (method[0].includes(replacement)) return { source, changed: false };
  if (method[0].includes(MARKER)) throw unsupported();
  const patched = method[0].replace(call, replacement);
  return {
    changed: true,
    source: source.slice(0, method.index) + patched + source.slice(method.index + method[0].length),
  };
}

const COMPLETION_MARKER = '/* Studio: progress replies do not replace child completion. */';

// A reply can be a progress update. Keep a separate, durable end-of-run notice
// so an idle parent cannot lose the handoff. Do not guess from the reply text.
export function transformChildCompletion(source, { required = false } = {}) {
  if (!source.includes('async _startRlmChildRun(') && !required)
    return { source, changed: false };
  const unsupported = () => new Error('Prime Agent child completion layout changed; update the Studio adapter.');
  const blocks = [...source.matchAll(
    /if \(!(?<run>run\d*)\.detachedDeletion &&\s*!\k<run>\.suppressTerminalNotice[\s\S]*?(?=\n\s*if \(!this\.registerRlmChildSession\(\k<run>\.id, child\))/g,
  )];
  if (blocks.length !== 1) throw unsupported();
  const block = blocks[0];
  const run = block.groups.run;
  const patched = `if (!${run}.detachedDeletion && !${run}.suppressTerminalNotice) {
                    ${COMPLETION_MARKER}
                    const lastAssistantText = child.getLastAssistantText();
                    const notice = createRlmChildTerminalNoticeMessage({
                        kind: "completed_without_reply",
                        childId: ${run}.id,
                        sessionName,
                        lastAssistantTextPreview: lastAssistantText ? compactRlmText(lastAssistantText) : undefined,
                    });
                    if (child._parentReplyCount !== parentReplyCountBeforeRun) {
                        if (!notice.content.startsWith("[child-exited: no-reply ")) throw new Error("Prime Agent child completion notice changed; update the Studio adapter.");
                        notice.details.kind = "completed";
                        notice.content = notice.content.replace("[child-exited: no-reply ", "[child-exited: completed ");
                    }
                    await deliverTerminalMessageToParent(notice);
                }`;
  if (block[0] === patched) return { source, changed: false };
  const original = `if (!${run}.detachedDeletion &&
                    !${run}.suppressTerminalNotice &&
                    child._parentReplyCount === parentReplyCountBeforeRun) {
                    const lastAssistantText = child.getLastAssistantText();
                    await deliverTerminalMessageToParent(createRlmChildTerminalNoticeMessage({
                        kind: "completed_without_reply",
                        childId: ${run}.id,
                        sessionName,
                        lastAssistantTextPreview: lastAssistantText ? compactRlmText(lastAssistantText) : undefined,
                    }));
                }`;
  // Native bundles only differ in whitespace, a trailing comma and void 0.
  const normalize = (text) => text.replace(/void 0/g, 'undefined').replace(/,\s*}/g, '}').replace(/\s+/g, '');
  if (source.includes(COMPLETION_MARKER) || normalize(block[0]) !== normalize(original)) throw unsupported();
  return { source: source.slice(0, block.index) + patched + source.slice(block.index + block[0].length), changed: true };
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!packageRoot || !url.startsWith('file:') || result.format !== 'module') return result;
  const path = relative(packageRoot, fileURLToPath(url)).replaceAll('\\', '/');
  const unbundled = path === 'dist/core/agent-session.js';
  if (!unbundled && !/^dist\/bundle\/[^/]+\.m?js$/.test(path)) return result;
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  if (!unbundled && !source.includes('async _startRlmChildRun(')) return result;
  const quiescence = transformSessionQuiescence(source, { required: true });
  const completion = transformChildCompletion(quiescence.source, { required: true });
  return quiescence.changed || completion.changed ? { ...result, source: completion.source } : result;
}
