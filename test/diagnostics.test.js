import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { requestDiagnostics, safeError } from '../lib/diagnostics.js';

test('closing a browser request aborts active work; deadlines return a retryable response', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const timeout of [false, true]) {
    const req = { path: '/api/messages/private-id', method: 'GET' };
    const res = new EventEmitter();
    res.set = () => {};
    res.status = status => { res.statusCode = status; return res; };
    res.json = body => { res.body = body; res.headersSent = true; res.writableFinished = true; res.emit('close'); };
    requestDiagnostics(req, res, () => {});
    assert.equal(req.upstreamSignal.aborted, false);
    if (timeout) {
      t.mock.timers.tick(30000);
      assert.equal(res.statusCode, 504);
      assert.match(res.body.error, /Apple Mail.*超时/);
      assert.equal(res.body.requestId, req.traceId);
    } else res.emit('close');
    assert.equal(req.upstreamSignal.aborted, true);
  }
});

test('diagnostics keep private error messages and paths out of logs', () => {
  const error = safeError({ message: 'private message body', code: 'EACCES', path: '/Users/person/mail', response: { data: 'secret' } });
  assert.deepEqual(error, { code: 'EACCES' });
  assert.doesNotMatch(JSON.stringify(error), /private message|person|secret/);
});
