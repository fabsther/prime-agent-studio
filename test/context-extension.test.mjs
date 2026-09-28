import test from 'node:test';
import assert from 'node:assert/strict';
import studioContext from '../runtime/studio-context-extension.mjs';

test('context hook shortens long kernel name lists only in the request', () => {
  let handler;
  studioContext({ on: (name, fn) => name === 'context' && (handler = fn) });
  const long = 'v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, v16, v17, v18, v19, v20, v21, v22, v23, v24, v25, v26, v27, v28, v29, v30, v31, v32, v33, v34, v35, v36, v37, v38, v39, v40, v41, v42, v43, v44, v45, v46, v47, v48, v49, v50, v51, v52, v53, v54, v55, v56, v57, v58, v59';
  const restored = {
    role: 'custom',
    customType: 'ipython_state_restored',
    content: `[python-state-restored]\n\nYour Python kernel state was revived. These names are available again: ${long}.\nThese could not be restored and must be recreated if needed: big_df.`,
  };
  const short = { role: 'custom', customType: 'ipython_state', content: 'These names are still defined: a, b.' };
  const user = { role: 'user', content: `These names are available again: ${long}.` };
  const messages = [restored, short, user];
  const result = handler({ messages });
  assert.equal(
    result.messages[0].content,
    '[python-state-restored]\n\nYour Python kernel state was revived. 60 names are available again; run dir() in the kernel to list them.\nThese could not be restored and must be recreated if needed: big_df.',
  );
  assert.equal(result.messages[1], short);
  assert.equal(result.messages[2], user);
  assert.ok(restored.content.includes('v59'), 'original message must stay unchanged');
  assert.equal(handler({ messages: [short, user] }), undefined);
});
