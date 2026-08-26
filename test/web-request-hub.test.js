'use strict';
/**
 * Web-request hub tests.
 *
 * The bug this component exists to prevent is silent: Electron keeps only
 * the last `onBeforeRequest` listener per session, so a second subsystem
 * registering directly would disable the first with no error anywhere. These
 * tests assert that every participant is actually consulted and that their
 * verdicts combine with the documented precedence.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { WebRequestHub, PRIORITY } = require('../src/main/services/web-request-hub');

/** Minimal stand-in for an Electron Session's webRequest surface. */
function fakeSession() {
  const listeners = {};
  const register = (name) => (filter, cb) => {
    // Mirrors Electron: registering twice replaces the previous listener.
    listeners[name] = cb;
  };
  return {
    webRequest: {
      onBeforeRequest: register('onBeforeRequest'),
      onBeforeSendHeaders: register('onBeforeSendHeaders'),
      onHeadersReceived: register('onHeadersReceived'),
      onCompleted: register('onCompleted'),
      onErrorOccurred: register('onErrorOccurred'),
    },
    /** Drive a blocking request through whatever the hub installed. */
    fire(event, details) {
      return new Promise((resolve) => listeners[event](details, resolve));
    },
    /** Observer events take no callback in Electron. */
    fireObserver(event, details) {
      listeners[event](details);
    },
    has(event) {
      return typeof listeners[event] === 'function';
    },
  };
}

test('all participants are consulted, in priority order', async () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);
  const seen = [];

  hub.register('onBeforeRequest', 'third', 30, () => { seen.push('third'); return null; });
  hub.register('onBeforeRequest', 'first', 10, () => { seen.push('first'); return null; });
  hub.register('onBeforeRequest', 'second', 20, () => { seen.push('second'); return null; });

  const result = await sess.fire('onBeforeRequest', { url: 'https://example.com/' });
  assert.deepEqual(seen, ['first', 'second', 'third']);
  assert.deepEqual(result, {});
});

test('a cancel short-circuits the chain', async () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);
  let laterRan = false;

  hub.register('onBeforeRequest', 'blocker', PRIORITY.ADBLOCK, () => ({ cancel: true }));
  hub.register('onBeforeRequest', 'upgrader', PRIORITY.HTTPS_ONLY, () => {
    laterRan = true;
    return { redirectURL: 'https://example.com/' };
  });

  const result = await sess.fire('onBeforeRequest', { url: 'http://ads.example.com/' });
  assert.deepEqual(result, { cancel: true });
  assert.equal(laterRan, false, 'nothing runs after a cancel');
});

test('adblock and HTTPS-only coexist — the real regression this prevents', async () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);

  hub.register('onBeforeRequest', 'adblock', PRIORITY.ADBLOCK, (d) =>
    d.url.includes('ads.') ? { cancel: true } : null);
  hub.register('onBeforeRequest', 'https-only', PRIORITY.HTTPS_ONLY, (d) =>
    d.url.startsWith('http://') ? { redirectURL: d.url.replace('http://', 'https://') } : null);

  assert.deepEqual(
    await sess.fire('onBeforeRequest', { url: 'http://ads.example.com/x.js' }),
    { cancel: true },
    'blocking still works');
  assert.deepEqual(
    await sess.fire('onBeforeRequest', { url: 'http://news.example.com/' }),
    { redirectURL: 'https://news.example.com/' },
    'upgrading still works');
  assert.deepEqual(
    await sess.fire('onBeforeRequest', { url: 'https://news.example.com/' }),
    {},
    'neither fires when neither applies');
});

test('a redirect short-circuits, since Chromium restarts the request', async () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);
  let laterRan = false;

  hub.register('onBeforeRequest', 'a', 10, (d) => ({ redirectURL: d.url + '?a' }));
  hub.register('onBeforeRequest', 'b', 20, () => { laterRan = true; return null; });

  const result = await sess.fire('onBeforeRequest', { url: 'https://x.com/' });
  assert.deepEqual(result, { redirectURL: 'https://x.com/?a' });
  assert.equal(laterRan, false);
});

test('a redirect equal to the current URL is ignored, avoiding a loop', async () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);
  hub.register('onBeforeRequest', 'noop-redirect', 10, (d) => ({ redirectURL: d.url }));

  const result = await sess.fire('onBeforeRequest', { url: 'https://x.com/' });
  assert.deepEqual(result, {}, 'self-redirect would loop forever, so it is dropped');
});

test('header participants see each other\'s mutations and compose', async () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);

  hub.register('onBeforeSendHeaders', 'strip', 10, (d) => {
    const h = { ...d.requestHeaders };
    delete h['x-client-data'];
    return { requestHeaders: h };
  });
  hub.register('onBeforeSendHeaders', 'gpc', 20, (d) => {
    assert.equal('x-client-data' in d.requestHeaders, false,
      'the second participant sees the first one\'s result');
    return { requestHeaders: { ...d.requestHeaders, 'Sec-GPC': '1' } };
  });

  const result = await sess.fire('onBeforeSendHeaders', {
    url: 'https://x.com/',
    requestHeaders: { 'x-client-data': 'leak', 'User-Agent': 'ua' },
  });
  assert.deepEqual(result.requestHeaders, { 'User-Agent': 'ua', 'Sec-GPC': '1' });
});

test('a throwing participant is skipped without breaking the request', async () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);

  hub.register('onBeforeRequest', 'buggy', 10, () => { throw new Error('boom'); });
  hub.register('onBeforeRequest', 'blocker', 20, () => ({ cancel: true }));

  const result = await sess.fire('onBeforeRequest', { url: 'https://x.com/' });
  assert.deepEqual(result, { cancel: true }, 'the chain survives and later rules still apply');
});

test('a throwing participant in the header chain leaves headers intact', async () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);
  hub.register('onHeadersReceived', 'buggy', 10, () => { throw new Error('boom'); });

  const result = await sess.fire('onHeadersReceived', {
    url: 'https://x.com/', responseHeaders: { 'content-type': ['text/html'] },
  });
  assert.deepEqual(result.responseHeaders, { 'content-type': ['text/html'] });
});

test('observer events fan out to every participant in order', () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);
  const hits = [];
  hub.register('onCompleted', 'b', 20, (d) => hits.push(['b', d.statusCode]));
  hub.register('onCompleted', 'a', 10, (d) => hits.push(['a', d.statusCode]));

  sess.fireObserver('onCompleted', { url: 'https://x.com/', statusCode: 200 });
  assert.deepEqual(hits, [['a', 200], ['b', 200]]);
});

test('a throwing observer does not stop the others', () => {
  const sess = fakeSession();
  const hub = new WebRequestHub(sess);
  const hits = [];
  hub.register('onErrorOccurred', 'buggy', 10, () => { throw new Error('boom'); });
  hub.register('onErrorOccurred', 'good', 20, () => hits.push('good'));

  sess.fireObserver('onErrorOccurred', { url: 'https://x.com/', error: 'net::ERR_FAILED' });
  assert.deepEqual(hits, ['good']);
});

test('only one real Electron listener is installed per event', () => {
  const installs = [];
  const sess = fakeSession();
  const original = sess.webRequest.onBeforeRequest;
  sess.webRequest.onBeforeRequest = (filter, cb) => {
    installs.push(1);
    return original(filter, cb);
  };
  const hub = new WebRequestHub(sess);
  hub.register('onBeforeRequest', 'a', 10, () => null);
  hub.register('onBeforeRequest', 'b', 20, () => null);
  hub.register('onBeforeRequest', 'c', 30, () => null);
  assert.equal(installs.length, 1, 'three participants, one Electron registration');
});
