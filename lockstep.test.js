// Replays the walkthroughs in specs/02_walkthroughs.md, on the main branch, against the demo's model.
// Run with: node lockstep.test.js
const assert = require('node:assert/strict');
const { Server, invalidSetting, DEFAULT_CONFIG } = require('./lockstep.js');

// A fresh server, with every far end of a channel behaving as `behaviors` says.
// Keys are a subscriber_id (for its connection) or a callback_address.
function setup(config = {}) {
  const behaviors = {};
  const delivered = [];
  const server = new Server({
    config,
    network: {
      behavior: (ch) => behaviors[ch.kind === 'connection' ? ch.subscriber_id : ch.callback_address] || { outcome: 'success', latency: 0 },
      deliver: (n, ch) => delivered.push({ to: n.subscriber_id, via: ch.kind, seqs: n.entries.map((e) => e.sequence), at: server.clock }),
    },
  });
  const take = () => delivered.splice(0);
  return { server, behaviors, take };
}
const refused = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);
const seqs = (n) => n.entries.map((e) => e.sequence);
const t0 = Date.UTC(2026, 11, 1);
const ackAll = (server, id, ids, seq) => ids.forEach((s) => server.acknowledge(s, id, seq));

// Builds a stream whose round 2 is open, opened by the boundary at 4, roster `roster2`, with C connected,
// every participant in `connected` connected, and floors at 4. Round 1's roster is [PM, DEV].
function atRound2(ctx, roster2, connected) {
  const { server, take } = ctx;
  const { id } = server.createStream('C', 'Sprint 14', ['PM', 'DEV']);
  server.connect('C', id);
  for (const p of connected.filter((p) => ['PM', 'DEV'].includes(p))) server.connect(p, id);
  server.append('PM', id, 1, 'a');
  server.append('DEV', id, 1, 'b');
  server.advanceStream('C', id, 3, roster2);
  for (const p of connected.filter((p) => !['PM', 'DEV'].includes(p))) server.connect(p, id);
  ackAll(server, id, ['C', ...roster2], 4);
  take();
  return id;
}

const checks = {
  'Creating a stream, and a complete round'() {
    const { server, take } = setup();
    const { id } = server.createStream('C', 'Sprint 14', ['PM', 'DEV']);
    server.connect('C', id);
    server.connect('PM', id);
    server.patchSubscription('DEV', id, { callback_address: 'https://dev.example/hook' });
    assert.deepEqual(take(), [{ to: 'C', via: 'connection', seqs: [1], at: t0 }, { to: 'PM', via: 'connection', seqs: [1], at: t0 }]);
    server.advanceBy(1000);
    assert.deepEqual(take(), [{ to: 'DEV', via: 'callback', seqs: [1], at: t0 + 1000 }]);
    ackAll(server, id, ['C', 'PM', 'DEV'], 1);
    server.append('PM', id, 1, 'spec');
    assert.deepEqual(take().map((d) => [d.to, d.seqs]), [['C', [2]]]);
    server.acknowledge('C', id, 2);
    assert.deepEqual(seqs(server.pullNotification('DEV', id)), []);
    server.append('DEV', id, 1, '');
    server.acknowledge('C', id, 3);
    take();
    server.advanceStream('C', id, 3, ['PM', 'DEV']);
    assert.deepEqual(take().map((d) => [d.to, d.seqs]), [['C', [4]], ['PM', [2, 3, 4]]]);
    server.advanceBy(1000);
    assert.deepEqual(take().map((d) => [d.to, d.seqs]), [['DEV', [2, 3, 4]]]);
  },

  'Adding a participant'() {
    const ctx = setup();
    const { server, take } = ctx;
    const id = atRound2(ctx, ['PM'], ['PM']);
    server.append('PM', id, 2, 'x');
    server.acknowledge('C', id, 5);
    server.advanceStream('C', id, 5, ['PM', 'OPS']);
    assert.equal(server.getSubscription('OPS', id).floor, 5);
    take();
    server.connect('OPS', id);
    assert.deepEqual(take().map((d) => [d.to, d.seqs]), [['OPS', [6]]]);
  },

  'Advancing past an incomplete round, and refused appends'() {
    const ctx = setup();
    const { server, take } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV', 'OPS'], ['PM', 'DEV', 'OPS']);
    server.append('PM', id, 2, 'x');
    server.acknowledge('C', id, 5);
    take();
    server.advanceStream('C', id, 5, ['PM', 'DEV']);
    assert.deepEqual(take().map((d) => [d.to, d.seqs]), [['C', [6]], ['PM', [5, 6]], ['DEV', [5, 6]], ['OPS', [5, 6]]]);
    ackAll(server, id, ['C', 'PM', 'DEV', 'OPS'], 6);
    server.append('PM', id, 3, 'x');
    server.append('DEV', id, 3, 'x');
    server.append('OPS', id, 2, 'late');
    server.append('DEV', id, 2, 'late');
    assert.deepEqual(take().map((d) => [d.to, d.seqs]), [['C', [7]], ['C', [7, 8]], ['C', [7, 8, 9]], ['C', [7, 8, 9, 10]]]);
    assert.equal(server.horizon(server.streams.get(id), 'OPS'), 6);
    refused(() => server.append('DEV', id, 2, 'again'), 'duplicate_round');
    refused(() => server.append('OPS', id, 3, 'x'), 'not_on_roster');
    refused(() => server.append('DEV', id, 4, 'x'), 'round_out_of_range');
  },

  'A refused AdvanceStream'() {
    const ctx = setup();
    const { server } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV'], ['PM', 'DEV']);
    server.append('PM', id, 2, 'x');
    server.append('DEV', id, 2, 'y');
    assert.throws(() => server.advanceStream('C', id, 5, ['PM', 'DEV']), (e) => e.code === 'stale_sequence' && e.data.entry.sequence === 6);
    assert.equal(server.advanceStream('C', id, 6, ['PM', 'DEV']).sequence, 7);
  },

  'A notification to a callback address'() {
    const ctx = setup();
    const { server, take } = ctx;
    const id = atRound2(ctx, ['DEV'], []);
    server.append('DEV', id, 2, 'x');
    server.acknowledge('C', id, 5);
    take();
    server.patchSubscription('DEV', id, { callback_address: 'https://dev.example/hook' });
    server.advanceBy(1000);
    assert.deepEqual(take().map((d) => [d.to, d.seqs]), [['DEV', []]]);
    server.advanceStream('C', id, 5, ['DEV']);
    server.advanceBy(1000);
    assert.deepEqual(take().map((d) => [d.to, d.seqs]), [['C', [6]], ['DEV', [5, 6]]]);
    assert.equal(server.getSubscription('DEV', id).floor, 4);
  },

  'Several triggers during the debounce wait'() {
    const ctx = setup();
    const { server, take } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV', 'OPS'], []);
    server.disconnect('C', id);
    server.patchSubscription('C', id, { callback_address: 'https://c.example/hook' });
    server.advanceBy(5000);
    take();
    const start = server.clock;
    server.append('PM', id, 2, 'x');
    server.advanceBy(800);
    server.append('DEV', id, 2, 'x');
    server.advanceBy(800);
    server.append('OPS', id, 2, 'x');
    assert.equal(server.streams.get(id).subscriptions.get('C').dispatch.nextAttemptAt, start + 2000);
    server.advanceBy(1000);
    assert.deepEqual(take(), [{ to: 'C', via: 'callback', seqs: [5, 6, 7], at: start + 2000 }]);
  },

  'A failed attempt and its retries'() {
    const ctx = setup({ LOCKSTEP_DISPATCH_MAX_ATTEMPTS: 3 });
    const { server, take } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV'], ['PM']);
    server.patchSubscription('DEV', id, { callback_address: 'https://dev.example/hook' });
    server.advanceBy(1000);
    server.acknowledge('DEV', id, 4);
    server.append('PM', id, 2, 'x');
    server.append('DEV', id, 2, 'y');
    server.acknowledge('C', id, 6);
    server.advanceBy(1000);
    take();
    const sent = [];
    const outcomes = ['failure', 'none', 'failure'];
    server.network.behavior = (ch) => {
      if (ch.kind === 'connection') return { outcome: 'success', latency: 0 };
      sent.push(server.clock);
      return { outcome: outcomes[sent.length - 1] || 'success', latency: 0 };
    };
    const t = server.clock;
    server.advanceStream('C', id, 6, ['PM', 'DEV']);
    server.advanceBy(20000);
    // debounce 1 s, then retry after 1 s, then attempt 2 times out after 1.5 s, then retry after 2 s
    assert.deepEqual(sent.map((x) => x - t), [1000, 2000, 5500]);
    assert.equal(server.streams.get(id).subscriptions.get('DEV').dispatch, null);
    assert.deepEqual(take().map((d) => d.to), ['C', 'PM']);
    server.append('PM', id, 3, 'x');
    server.acknowledge('C', id, 8);
    server.advanceStream('C', id, 8, ['PM', 'DEV']);
    server.advanceBy(1000);
    assert.deepEqual(take().map((d) => [d.to, d.seqs]).pop(), ['DEV', [5, 6, 7, 8, 9]]);
  },

  'A trigger after a dispatch has made an attempt'() {
    const ctx = setup();
    const { server, take, behaviors } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV'], ['PM']);
    server.patchSubscription('DEV', id, { callback_address: 'https://dev.example/hook' });
    server.advanceBy(1000);
    server.append('PM', id, 2, 'x');
    server.append('DEV', id, 2, 'y');
    server.acknowledge('C', id, 6);
    server.advanceBy(1000);
    behaviors['https://dev.example/hook'] = { outcome: 'failure', latency: 0 };
    server.advanceStream('C', id, 6, ['PM', 'DEV']);
    server.advanceBy(1000);
    assert.equal(server.streams.get(id).subscriptions.get('DEV').dispatch.attempts, 1);
    behaviors['https://dev.example/hook'] = { outcome: 'success', latency: 0 };
    server.append('PM', id, 3, 'x');
    server.acknowledge('C', id, 8);
    const t = server.clock;
    server.advanceStream('C', id, 8, ['PM', 'DEV']);
    const fresh = server.streams.get(id).subscriptions.get('DEV').dispatch;
    assert.equal(fresh.attempts, 0);
    assert.equal(fresh.limitEnd, t + 2000);
    take();
    server.advanceBy(1000);
    assert.deepEqual(take().map((x) => [x.to, x.seqs]), [['DEV', [5, 6, 7, 8, 9]]]);
  },

  'Changing the callback_address between attempts'() {
    const ctx = setup();
    const { server, take, behaviors } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV'], ['DEV']);
    behaviors['https://a.example'] = { outcome: 'none' };
    server.patchSubscription('PM', id, { callback_address: 'https://a.example' });
    server.advanceBy(3000);
    server.append('PM', id, 2, 'x');
    server.append('DEV', id, 2, 'y');
    server.acknowledge('C', id, 6);
    server.advanceBy(5000);
    server.advanceStream('C', id, 6, ['PM', 'DEV']);
    server.advanceBy(2500); // attempt 1 at 1 s, which times out at 2.5 s
    take();
    server.patchSubscription('PM', id, { callback_address: 'https://b.example' });
    server.advanceBy(1000);
    assert.deepEqual(take().map((x) => [x.to, x.seqs]), [['PM', [5, 6, 7]]]);
  },

  'Connecting while a dispatch is waiting'() {
    const ctx = setup();
    const { server, take } = ctx;
    const id = atRound2(ctx, ['DEV'], []);
    server.patchSubscription('DEV', id, { callback_address: 'https://dev.example/hook' });
    server.advanceBy(1000);
    server.append('DEV', id, 2, 'x');
    server.acknowledge('C', id, 5);
    server.advanceBy(5000);
    server.advanceStream('C', id, 5, ['DEV']);
    take();
    server.connect('DEV', id);
    assert.deepEqual(take().map((x) => [x.to, x.via, x.seqs]), [['DEV', 'connection', [5, 6]]]);
    server.advanceBy(5000);
    assert.deepEqual(take(), []);
    server.acknowledge('DEV', id, 6);
    server.acknowledge('C', id, 6);
    server.append('DEV', id, 3, 'x');
    server.acknowledge('C', id, 7);
    server.advanceStream('C', id, 7, ['DEV']);
    assert.deepEqual(take().map((x) => [x.to, x.via, x.seqs]), [['C', 'connection', [7]], ['C', 'connection', [8]], ['DEV', 'connection', [7, 8]]]);
  },

  'Repeat delivery, and polling with no channel'() {
    const ctx = setup();
    const { server } = ctx;
    const id = atRound2(ctx, ['DEV'], []);
    server.append('DEV', id, 2, 'x');
    server.acknowledge('C', id, 5);
    server.advanceStream('C', id, 5, ['DEV']);
    assert.deepEqual(seqs(server.pullNotification('DEV', id)), [5, 6]);
    assert.deepEqual(seqs(server.pullNotification('DEV', id)), [5, 6]);
    server.acknowledge('DEV', id, 6);
    assert.deepEqual(seqs(server.pullNotification('DEV', id)), []);
  },

  'A failed write to a connection'() {
    const ctx = setup();
    const { server, take, behaviors } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV'], ['PM', 'DEV']);
    server.patchSubscription('PM', id, { callback_address: 'https://pm.example/hook' });
    server.append('PM', id, 2, 'x');
    server.append('DEV', id, 2, 'y');
    server.acknowledge('C', id, 6);
    take();
    behaviors.PM = { outcome: 'failure', latency: 0 };
    server.advanceStream('C', id, 6, ['PM', 'DEV']);
    const sub = server.streams.get(id).subscriptions.get('PM');
    assert.equal(sub.connection, null);
    assert.equal(sub.dispatch.channel, 'callback');
    server.advanceBy(1000);
    assert.deepEqual(take().map((x) => [x.to, x.via, x.seqs]), [['C', 'connection', [7]], ['DEV', 'connection', [5, 6, 7]], ['PM', 'callback', [5, 6, 7]]]);
  },

  'A server restart during a write to a connection'() {
    const ctx = setup();
    const { server, take, behaviors } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV'], ['PM', 'DEV']);
    server.patchSubscription('PM', id, { callback_address: 'https://pm.example/hook' });
    server.append('PM', id, 2, 'x');
    server.append('DEV', id, 2, 'y');
    server.acknowledge('C', id, 6);
    take();
    behaviors.PM = { outcome: 'success', latency: 500 };
    server.advanceStream('C', id, 6, ['PM', 'DEV']);
    server.advanceBy(100);
    server.restart();
    server.advanceBy(1000);
    assert.deepEqual(take().map((x) => [x.to, x.via, x.seqs]), [['C', 'connection', [7]], ['DEV', 'connection', [5, 6, 7]], ['PM', 'callback', [5, 6, 7]]]);
    ackAll(server, id, ['C', 'DEV'], 7);
    server.connect('C', id);
    assert.deepEqual(take().map((x) => x.seqs), [[]]);
  },

  'A server restart during an attempt to a callback address'() {
    const ctx = setup();
    const { server, take, behaviors } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV'], ['PM']);
    server.patchSubscription('DEV', id, { callback_address: 'https://dev.example/hook' });
    server.advanceBy(1000);
    server.append('PM', id, 2, 'x');
    server.append('DEV', id, 2, 'y');
    server.acknowledge('C', id, 6);
    server.advanceBy(1000);
    behaviors['https://dev.example/hook'] = { outcome: 'success', latency: 800 };
    server.advanceStream('C', id, 6, ['PM', 'DEV']);
    server.advanceBy(1200); // attempt 1 at 1 s is in flight until 1.8 s
    take();
    const t = server.clock;
    server.restart();
    assert.equal(server.streams.get(id).subscriptions.get('DEV').dispatch.nextAttemptAt, t + 1000);
    server.advanceBy(2000);
    assert.deepEqual(take().map((x) => [x.to, x.seqs, x.at - t]), [['DEV', [5, 6, 7], 1800]]);
  },

  'Reading without a subscription, and finding a stream after a lost response'() {
    const { server } = setup();
    const a = server.createStream('C', 'Sprint 13', []);
    const b = server.createStream('C', 'Sprint 14', ['PM', 'DEV']);
    assert.deepEqual(server.listSubscribedStreams('C').map((s) => s.id), [b.id, a.id]);
    assert.equal(server.readEntries(b.id, 1).length, 1);
    refused(() => server.pullNotification('AN', b.id), 'no_subscription');
    refused(() => server.readEntries(b.id, 0), 'invalid_range');
  },

  'Dropping a participant, and adding it back'() {
    const ctx = setup();
    const { server, take } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV'], ['PM', 'DEV']);
    server.append('PM', id, 2, 'x');
    server.append('DEV', id, 2, 'y');
    server.acknowledge('C', id, 6);
    take();
    server.advanceStream('C', id, 6, ['PM']);
    assert.deepEqual(take().map((x) => [x.to, x.seqs]), [['C', [7]], ['PM', [5, 6, 7]], ['DEV', [5, 6, 7]]]);
    ackAll(server, id, ['C', 'PM', 'DEV'], 7);
    server.append('PM', id, 3, 'x');
    server.acknowledge('C', id, 8);
    server.advanceStream('C', id, 8, ['PM']);
    assert.deepEqual(take().map((x) => x.to), ['C', 'C', 'PM']);
    ackAll(server, id, ['C', 'PM'], 9);
    server.append('PM', id, 4, 'x');
    server.acknowledge('C', id, 10);
    server.advanceStream('C', id, 10, ['PM', 'DEV']);
    assert.equal(server.getSubscription('DEV', id).floor, 10);
    take();
    server.disconnect('DEV', id);
    server.connect('DEV', id);
    assert.deepEqual(take().map((x) => x.seqs), [[11]]);
  },

  'Replacing the coordinator'() {
    const ctx = setup();
    const { server, take } = ctx;
    const id = atRound2(ctx, ['PM'], ['PM']);
    refused(() => server.patchStream('C', id, { coordinator_id: 'PM' }), 'invalid_coordinator');
    server.patchStream('C', id, { coordinator_id: 'C2' });
    assert.equal(server.streams.get(id).subscriptions.get('C').connection, null);
    take();
    server.connect('C2', id);
    assert.deepEqual(take().map((x) => x.seqs), [[1, 2, 3, 4]]);
    refused(() => server.advanceStream('C', id, 4, ['PM']), 'not_coordinator');
    assert.deepEqual(seqs(server.pullNotification('C', id)), []);
    refused(() => server.advanceStream('C2', id, 4, ['C']), 'invalid_roster');
  },

  'Terminating a stream, and purging'() {
    const ctx = setup({ LOCKSTEP_RETENTION: 60000, LOCKSTEP_PURGE_INTERVAL: 10000 });
    const { server, take } = ctx;
    const id = atRound2(ctx, ['PM', 'DEV'], ['PM']);
    server.patchSubscription('DEV', id, { callback_address: 'https://dev.example/hook' });
    server.advanceBy(1000);
    server.append('PM', id, 2, 'x');
    server.append('DEV', id, 2, 'y');
    server.acknowledge('C', id, 6);
    server.advanceBy(1000);
    take();
    refused(() => server.patchStream('C', id, { to_be_purged_at: null }), 'stream_not_terminated');
    server.terminateStream('C', id, 6);
    assert.equal(server.streams.get(id).subscriptions.get('PM').connection, null);
    server.advanceBy(1000);
    assert.deepEqual(take().map((x) => [x.to, x.via, x.seqs]), [['C', 'connection', [7]], ['PM', 'connection', [5, 6, 7]], ['DEV', 'callback', [5, 6, 7]]]);
    refused(() => server.append('PM', id, 2, 'x'), 'stream_terminated');
    refused(() => server.connect('PM', id), 'stream_terminated');
    refused(() => server.advanceStream('C', id, 7, ['PM']), 'stream_terminated');
    server.patchStream('C', id, { to_be_purged_at: null });
    server.advanceBy(120000);
    assert.ok(server.streams.has(id));
    server.patchStream('C', id, { to_be_purged_at: new Date(server.clock + 5000).toISOString() });
    server.advanceBy(10000);
    refused(() => server.getStream(id), 'no_such_stream');
  },

  'Request validation and configuration'() {
    const { server } = setup({ UINT_MAX: 6 });
    refused(() => server.call('Acknowledge', { stream_id: 's1', sequence: 1 }), 'invalid_request');
    refused(() => server.call('CreateStream', { subscriber_id: 'C', title: 'x', roster: [], id: 's9' }), 'invalid_request');
    refused(() => server.call('Append', { subscriber_id: 'PM', stream_id: 's1', round: -1, payload: '' }), 'invalid_request');
    const { id } = server.call('CreateStream', { subscriber_id: 'C', title: 'x', roster: ['PM'] });
    assert.equal(server.call('GetStream', { subscriber_id: 'ignored', stream_id: id }).id, id);
    refused(() => server.call('CreateStream', { subscriber_id: 'C', title: 'x', roster: ['PM', 'PM'] }), 'invalid_roster');
    refused(() => server.call('PatchSubscription', { subscriber_id: 'PM', stream_id: id, callback_address: 'ftp://x' }), 'invalid_callback_address');
    for (let r = 1; r <= 2; r++) {
      server.append('PM', id, r, 'x');
      server.advanceStream('C', id, server.highest(server.streams.get(id)), ['PM']);
    }
    // Sequences 1 to 5 are taken, so the next one would reach UINT_MAX, which is 6.
    refused(() => server.append('PM', id, 3, 'x'), 'sequence_exhausted');
    refused(() => server.advanceStream('C', id, 5, ['PM']), 'sequence_exhausted');
    assert.equal(server.terminateStream('C', id, 5).sequence, 6);
    assert.match(invalidSetting({ ...DEFAULT_CONFIG, LOCKSTEP_DEBOUNCE_LIMIT: 10 }), /LOCKSTEP_DEBOUNCE_LIMIT/);
    assert.throws(() => server.restart({ ...DEFAULT_CONFIG, LOCKSTEP_DISPATCH_MAX_ATTEMPTS: 0 }), /did not start/);
    const noCallbacks = setup({ SUPPORTS_CALLBACKS: false }).server;
    const s = noCallbacks.createStream('C', 'x', []);
    refused(() => noCallbacks.patchSubscription('C', s.id, { callback_address: 'https://c.example' }), 'unsupported');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(checks)) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n${e.stack}`);
  }
}
console.log(`${Object.keys(checks).length - failed} of ${Object.keys(checks).length} walkthrough checks hold`);
process.exit(failed ? 1 : 0);
