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

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!packageRoot || !url.startsWith('file:') || result.format !== 'module') return result;
  const path = relative(packageRoot, fileURLToPath(url)).replaceAll('\\', '/');
  const unbundled = path === 'dist/core/agent-session.js';
  if (!unbundled && !/^dist\/bundle\/[^/]+\.m?js$/.test(path)) return result;
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  if (!unbundled && !source.includes('async _startRlmChildRun(')) return result;
  const changed = transformSessionQuiescence(source, { required: true });
  return changed.changed ? { ...result, source: changed.source } : result;
}
