import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReply } from '../lib/ai.js';

test('reply generation includes the users instructions in the AI prompt', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '抱歉，我目前不方便借钱。' } }] }) };
  };
  try {
    const reply = await generateReply({ apiKey: 'test-key', endpoint: 'https://api.example.test/v1', model: 'test' }, {
      sender: 'Person <person@example.test>', subject: '借钱', body: '可以借我一些钱吗？',
    }, { instructions: '如果对方借钱，请礼貌但明确地拒绝。' });
    assert.equal(reply, '抱歉，我目前不方便借钱。');
    assert.match(request.messages[0].content, /用户对回复内容的要求/);
    assert.match(request.messages[0].content, /请礼貌但明确地拒绝/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
