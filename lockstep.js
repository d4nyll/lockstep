// An in-memory Lockstep server that follows specs/01_base-specification.md, on the main branch, run on a virtual clock.
// The demo's own extended specification is in README.md, under "The demo's extended specification".
(function (root) {
  'use strict';

  const DEFAULT_CONFIG = {
    LOCKSTEP_DEBOUNCE_INTERVAL: 1000,
    LOCKSTEP_DEBOUNCE_LIMIT: 2000,
    LOCKSTEP_RESPONSE_TIMEOUT: 1500,
    LOCKSTEP_DISPATCH_RETRY_BASE: 1000,
    LOCKSTEP_DISPATCH_MAX_ATTEMPTS: 3,
    LOCKSTEP_DISPATCH_RETRY_MAX: 8000,
    LOCKSTEP_RETENTION: 60000,
    LOCKSTEP_PURGE_ENABLED: true,
    LOCKSTEP_PURGE_INTERVAL: 10000,
    // Decisions the base specification leaves to the extended specification.
    UINT_MAX: 2 ** 32 - 1,
    SUPPORTS_CONNECTIONS: true,
    SUPPORTS_CALLBACKS: true,
  };

  // Durations are whole milliseconds. The limit keeps every timestamp sum inside the range of a Date.
  const MAX_DURATION = 10 ** 12;
  const isDuration = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_DURATION;

  // The Configuration table. Returns the first setting given a value it forbids, or null.
  function invalidSetting(c) {
    const checks = [
      ['LOCKSTEP_DEBOUNCE_INTERVAL', isDuration(c.LOCKSTEP_DEBOUNCE_INTERVAL), 'zero or above'],
      ['LOCKSTEP_DEBOUNCE_LIMIT', isDuration(c.LOCKSTEP_DEBOUNCE_LIMIT) && c.LOCKSTEP_DEBOUNCE_LIMIT >= c.LOCKSTEP_DEBOUNCE_INTERVAL, 'at least LOCKSTEP_DEBOUNCE_INTERVAL'],
      ['LOCKSTEP_RESPONSE_TIMEOUT', isDuration(c.LOCKSTEP_RESPONSE_TIMEOUT) && c.LOCKSTEP_RESPONSE_TIMEOUT > 0, 'above zero'],
      ['LOCKSTEP_DISPATCH_RETRY_BASE', isDuration(c.LOCKSTEP_DISPATCH_RETRY_BASE) && c.LOCKSTEP_DISPATCH_RETRY_BASE > 0, 'above zero'],
      ['LOCKSTEP_DISPATCH_MAX_ATTEMPTS', Number.isInteger(c.LOCKSTEP_DISPATCH_MAX_ATTEMPTS) && c.LOCKSTEP_DISPATCH_MAX_ATTEMPTS >= 1, 'at least 1'],
      ['LOCKSTEP_DISPATCH_RETRY_MAX', isDuration(c.LOCKSTEP_DISPATCH_RETRY_MAX) && c.LOCKSTEP_DISPATCH_RETRY_MAX >= c.LOCKSTEP_DISPATCH_RETRY_BASE, 'at least LOCKSTEP_DISPATCH_RETRY_BASE'],
      ['LOCKSTEP_RETENTION', isDuration(c.LOCKSTEP_RETENTION), 'zero or above'],
      ['LOCKSTEP_PURGE_ENABLED', typeof c.LOCKSTEP_PURGE_ENABLED === 'boolean', 'true or false'],
      ['LOCKSTEP_PURGE_INTERVAL', isDuration(c.LOCKSTEP_PURGE_INTERVAL) && c.LOCKSTEP_PURGE_INTERVAL > 0, 'above zero'],
      ['UINT_MAX', Number.isSafeInteger(c.UINT_MAX) && c.UINT_MAX >= 2, 'at least 2'],
      ['SUPPORTS_CONNECTIONS', typeof c.SUPPORTS_CONNECTIONS === 'boolean' && (c.SUPPORTS_CONNECTIONS || c.SUPPORTS_CALLBACKS), 'connections, callbacks, or both'],
      ['SUPPORTS_CALLBACKS', typeof c.SUPPORTS_CALLBACKS === 'boolean', 'true or false'],
    ];
    const bad = checks.find(([, ok]) => !ok);
    return bad ? `${bad[0]} must be ${bad[2]}, not ${JSON.stringify(c[bad[0]])}` : null;
  }

  class LockstepError extends Error {
    constructor(code, message, data = null) {
      super(message);
      this.code = code;
      this.data = data;
    }
  }

  function refuse(code, message, data = null) {
    throw new LockstepError(code, message, data);
  }

  // Input schemas, used to refuse malformed requests with invalid_request before step 1.
  const T = {
    string: (v) => typeof v === 'string',
    uint: (v, max) => Number.isInteger(v) && v >= 0 && v <= max,
    strings: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
    bytes: (v) => typeof v === 'string',
    nullableString: (v) => v === null || typeof v === 'string',
    nullableTimestamp: (v) => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v))),
  };
  const OPERATIONS = {
    GetStream: { kind: 'caller', fields: { stream_id: ['string', true] } },
    ReadEntries: { kind: 'caller', fields: { stream_id: ['string', true], from_sequence: ['uint', true], limit: ['uint', false] } },
    ListSubscribedStreams: { kind: 'subscriber', fields: {} },
    GetSubscription: { kind: 'subscriber', fields: { stream_id: ['string', true] } },
    PatchSubscription: { kind: 'subscriber', fields: { stream_id: ['string', true], callback_address: ['nullableString', false] } },
    Connect: { kind: 'subscriber', fields: { stream_id: ['string', true] } },
    PullNotification: { kind: 'subscriber', fields: { stream_id: ['string', true] } },
    Acknowledge: { kind: 'subscriber', fields: { stream_id: ['string', true], sequence: ['uint', true] } },
    CreateStream: { kind: 'subscriber', fields: { title: ['string', true], roster: ['strings', true] } },
    PatchStream: { kind: 'subscriber', fields: { stream_id: ['string', true], title: ['string', false], coordinator_id: ['string', false], to_be_purged_at: ['nullableTimestamp', false] } },
    AdvanceStream: { kind: 'subscriber', fields: { stream_id: ['string', true], expected_sequence: ['uint', true], roster: ['strings', true] } },
    TerminateStream: { kind: 'subscriber', fields: { stream_id: ['string', true], expected_sequence: ['uint', true] } },
    Append: { kind: 'subscriber', fields: { stream_id: ['string', true], round: ['uint', true], payload: ['bytes', true] } },
    PurgeExpiredStreams: { kind: 'system', fields: {} },
  };

  const iso = (ms) => new Date(ms).toISOString();

  class Server {
    // network.behavior(channel) returns how the far end of a channel responds to an attempt:
    // { outcome: 'success' | 'failure' | 'none', latency }. network.deliver(notification, channel)
    // receives each notification that reaches its subscriber. network.event(text) receives a
    // description of each step the server takes on its own.
    constructor({ config = {}, network = {}, clock = Date.UTC(2026, 11, 1) } = {}) {
      this.network = {
        behavior: () => ({ outcome: 'success', latency: 0 }),
        deliver: () => {},
        event: () => {},
        ...network,
      };
      this.clock = clock;
      this.streams = new Map();
      this.nextStreamId = 1;
      this.nextConnectionId = 1;
      this.start({ ...DEFAULT_CONFIG, ...config });
    }

    // Starts the server with config, or refuses to start and reports the setting at fault.
    start(config) {
      const bad = invalidSetting(config);
      if (bad) throw new Error(`The server did not start: ${bad}`);
      this.config = config;
      this.nextPurgeAt = config.LOCKSTEP_PURGE_ENABLED ? this.clock + config.LOCKSTEP_PURGE_INTERVAL : null;
    }

    // A restart keeps every Stream, Entry, Subscription and pending dispatch (S11), and closes every
    // connection. The restart takes no time on the virtual clock.
    restart(config = this.config) {
      this.start({ ...DEFAULT_CONFIG, ...config });
      this.network.event('The server restarts. Every connection closes');
      for (const s of this.streams.values()) {
        for (const sub of s.subscriptions.values()) {
          const d = sub.dispatch;
          sub.connection = null;
          if (!d) continue;
          if (d.channel === 'connection') {
            // C25
            this.network.event(`${sub.subscriber_id}'s dispatch over its connection had not ended, so it counts as one whose connection closed`);
            this.startDispatch(s, sub);
          } else {
            // C23, C24, and C1 on resuming
            if (!sub.callback_address) {
              this.endDispatch(sub, 'it resumes while the subscriber has no channel');
              continue;
            }
            this.network.event(`${sub.subscriber_id}'s dispatch to its callback_address resumes`);
            if (d.inFlight) {
              d.inFlight = null;
              this.network.event(`${sub.subscriber_id}'s attempt ${d.attempts} was in flight, so it counts as failed`);
              this.afterCallbackFailure(s, sub, d);
            }
          }
        }
      }
    }

    // The virtual clock

    // The time of the next step the server takes on its own, or null.
    nextEventAt() {
      let next = this.nextPurgeAt;
      for (const s of this.streams.values()) {
        for (const sub of s.subscriptions.values()) {
          const t = this.dueAt(sub.dispatch);
          if (t !== null && (next === null || t < next)) next = t;
        }
      }
      return next;
    }

    dueAt(d) {
      if (!d) return null;
      if (d.inFlight) return d.inFlight.completesAt;
      return d.channel === 'callback' ? d.nextAttemptAt : null;
    }

    // Runs every step due up to and including time, in time order.
    advanceTo(time) {
      for (;;) {
        const next = this.nextEventAt();
        if (next === null || next > time) break;
        this.clock = Math.max(this.clock, next);
        if (this.nextPurgeAt !== null && this.nextPurgeAt <= this.clock) {
          this.network.event('The server runs PurgeExpiredStreams on its schedule');
          this.purgeExpiredStreams();
          this.nextPurgeAt = this.clock + this.config.LOCKSTEP_PURGE_INTERVAL;
        }
        for (const s of [...this.streams.values()]) {
          for (const sub of s.subscriptions.values()) {
            const d = sub.dispatch;
            if (this.dueAt(d) === null || this.dueAt(d) > this.clock) continue;
            if (d.inFlight) this.complete(s, sub, d);
            else this.attempt(s, sub, d);
          }
        }
      }
      this.clock = Math.max(this.clock, time);
    }

    advanceBy(ms) {
      this.advanceTo(this.clock + ms);
    }

    // Helpers over one stream

    stream(stream_id) {
      const s = this.streams.get(stream_id);
      if (!s) refuse('no_such_stream', `No stream has id ${stream_id}`);
      return s;
    }

    subscription(s, subscriber_id) {
      const sub = s.subscriptions.get(subscriber_id);
      if (!sub) refuse('no_subscription', `${subscriber_id} holds no subscription on ${s.id}`);
      return sub;
    }

    highest(s) {
      return s.entries.length;
    }

    terminated(s) {
      return s.entries[s.entries.length - 1].type === 'termination';
    }

    boundary(s, round) {
      return s.entries.find((e) => e.type === 'boundary' && e.round === round);
    }

    // S2 and S3. The last entry can be a contribution to a past round, so it is not used here.
    currentRound(s) {
      return s.entries.filter((e) => e.type === 'boundary').pop().round;
    }

    roster(s, round) {
      const b = this.boundary(s, round);
      return b ? b.payload.roster : [];
    }

    namedRounds(s, subscriber_id) {
      return s.entries.filter((e) => e.type === 'boundary' && e.payload.roster.includes(subscriber_id)).map((e) => e.round);
    }

    formerCoordinators(s) {
      return [...s.subscriptions.keys()].filter((id) => id !== s.coordinator_id && this.namedRounds(s, id).length === 0);
    }

    // N1. 0 means no entry, which is the horizon of a former coordinator.
    horizon(s, subscriber_id) {
      if (subscriber_id === s.coordinator_id) return this.highest(s);
      const rounds = this.namedRounds(s, subscriber_id);
      if (rounds.length === 0) return 0;
      const last = Math.max(...rounds);
      if (last === this.currentRound(s)) {
        return this.terminated(s) ? this.highest(s) : this.boundary(s, last).sequence;
      }
      return this.boundary(s, last + 1).sequence;
    }

    // N2
    buildNotification(s, sub) {
      const horizon = this.horizon(s, sub.subscriber_id);
      return {
        stream_id: s.id,
        subscriber_id: sub.subscriber_id,
        entries: s.entries.filter((e) => e.sequence > sub.floor && e.sequence <= horizon).map((e) => ({ ...e })),
      };
    }

    newSubscription(s, subscriber_id) {
      const sub = { stream_id: s.id, subscriber_id, callback_address: null, floor: 0, connection: null, dispatch: null };
      s.subscriptions.set(subscriber_id, sub);
      return sub;
    }

    publicSubscription(sub) {
      const { stream_id, subscriber_id, callback_address, floor } = sub;
      return { stream_id, subscriber_id, callback_address, floor };
    }

    publicStream(s) {
      const { id, title, coordinator_id, created_at, to_be_purged_at } = s;
      return { id, title, coordinator_id, created_at: iso(created_at), to_be_purged_at: to_be_purged_at === null ? null : iso(to_be_purged_at) };
    }

    appendEntry(s, round, type, subscriber_id, payload) {
      const entry = { stream_id: s.id, sequence: this.highest(s) + 1, round, type, subscriber_id, payload };
      s.entries.push(entry);
      return entry;
    }

    checkRoster(s, coordinator_id, roster) {
      const former = s ? this.formerCoordinators(s) : [];
      if (roster.includes(coordinator_id) || roster.some((p) => former.includes(p)) || new Set(roster).size !== roster.length) {
        refuse('invalid_roster', 'The roster names the coordinator or a former coordinator, or names a participant twice');
      }
    }

    checkSequenceRoom(s) {
      if (this.highest(s) + 1 >= this.config.UINT_MAX) {
        refuse('sequence_exhausted', `The next sequence would reach ${this.config.UINT_MAX}, the highest an unsigned int holds`);
      }
    }

    checkExpected(s, expected_sequence) {
      if (expected_sequence !== this.highest(s)) {
        refuse('stale_sequence', `The highest sequence is ${this.highest(s)}, not ${expected_sequence}`, { entry: { ...s.entries[this.highest(s) - 1] } });
      }
    }

    // Dispatches

    // N4: push an appended entry to its recipients.
    push(s, entry) {
      const recipients = [s.coordinator_id];
      if (entry.type === 'boundary') recipients.push(...this.roster(s, entry.round - 1), ...this.roster(s, entry.round));
      if (entry.type === 'termination') recipients.push(...this.roster(s, entry.round));
      for (const id of new Set(recipients)) this.startDispatch(s, s.subscriptions.get(id));
    }

    endDispatch(sub, why) {
      if (!sub.dispatch) return;
      sub.dispatch = null;
      this.network.event(`${sub.subscriber_id}'s dispatch ends: ${why}`);
    }

    // C1, C2, C3, C10, C11, C12, C13, C14
    startDispatch(s, sub) {
      const old = sub.dispatch;
      const limitEnd = old && old.attempts === 0 && old.channel === 'callback' ? old.limitEnd : this.clock + this.config.LOCKSTEP_DEBOUNCE_LIMIT;
      if (old) this.endDispatch(sub, 'a new dispatch replaces it');
      const channel = sub.connection ? 'connection' : sub.callback_address ? 'callback' : null;
      if (!channel) {
        this.network.event(`${sub.subscriber_id} has no channel, so its dispatch ends without an attempt`);
        return;
      }
      const d = { channel, connection: sub.connection, attempts: 0, inFlight: null, intervalEnd: null, limitEnd: null, nextAttemptAt: null };
      sub.dispatch = d;
      if (channel === 'connection') {
        this.attempt(s, sub, d); // C6, C7
        return;
      }
      d.intervalEnd = this.clock + this.config.LOCKSTEP_DEBOUNCE_INTERVAL;
      d.limitEnd = limitEnd;
      d.nextAttemptAt = Math.min(d.intervalEnd, d.limitEnd); // C9
      const inherited = old && limitEnd === old.limitEnd ? ', keeping the replaced dispatch\'s debounce limit' : '';
      this.network.event(`A dispatch to ${sub.subscriber_id}'s callback_address starts. Debounce interval ends at ${iso(d.intervalEnd)}, debounce limit at ${iso(d.limitEnd)}${inherited}`);
    }

    // C4, C15, C16, C17, C18, C21
    attempt(s, sub, d) {
      if (d.channel === 'callback' && !sub.callback_address) {
        this.endDispatch(sub, 'an attempt is due and its channel no longer exists');
        return;
      }
      d.attempts += 1;
      d.nextAttemptAt = null;
      const notification = this.buildNotification(s, sub);
      const channel = d.channel === 'connection'
        ? { kind: 'connection', subscriber_id: sub.subscriber_id, stream_id: s.id, connection_id: d.connection.id }
        : { kind: 'callback', subscriber_id: sub.subscriber_id, stream_id: s.id, callback_address: sub.callback_address };
      const { outcome, latency = 0 } = this.network.behavior(channel);
      let completesAt = this.clock + latency;
      let result = outcome;
      if (d.channel === 'callback' && (outcome === 'none' || latency >= this.config.LOCKSTEP_RESPONSE_TIMEOUT)) {
        completesAt = this.clock + this.config.LOCKSTEP_RESPONSE_TIMEOUT;
        result = 'timeout';
      }
      d.inFlight = { completesAt, result, notification, channel };
      const where = d.channel === 'connection' ? 'into the connection' : `on ${sub.callback_address}`;
      this.network.event(`Attempt ${d.attempts} to ${sub.subscriber_id} ${where}, carrying [${notification.entries.map((e) => e.sequence).join(', ')}]`);
      if (completesAt <= this.clock) this.complete(s, sub, d);
    }

    complete(s, sub, d) {
      const { result, notification, channel } = d.inFlight;
      d.inFlight = null;
      if (result === 'success') {
        this.endDispatch(sub, `attempt ${d.attempts} succeeds`);
        this.network.deliver(notification, channel);
        if (d.channel === 'connection' && d.connection.closeAfterWrite) this.closeConnection(s, sub, 'the stream is terminated');
        return;
      }
      if (d.channel === 'connection') {
        this.network.event(`The write to ${sub.subscriber_id}'s connection fails`);
        this.closeConnection(s, sub, 'a write to it failed'); // C8
        return;
      }
      this.network.event(result === 'timeout'
        ? `Attempt ${d.attempts} to ${sub.subscriber_id} returns nothing within LOCKSTEP_RESPONSE_TIMEOUT, so it counts as failed`
        : `Attempt ${d.attempts} to ${sub.subscriber_id} fails`);
      this.afterCallbackFailure(s, sub, d);
    }

    // C12, C19, C20
    afterCallbackFailure(s, sub, d) {
      if (d.attempts >= this.config.LOCKSTEP_DISPATCH_MAX_ATTEMPTS) {
        this.endDispatch(sub, `it has made ${d.attempts} attempts and the last one failed`);
        return;
      }
      const wait = Math.min(this.config.LOCKSTEP_DISPATCH_RETRY_BASE * 2 ** (d.attempts - 1), this.config.LOCKSTEP_DISPATCH_RETRY_MAX);
      d.nextAttemptAt = this.clock + wait;
      this.network.event(`${sub.subscriber_id}'s dispatch retries at ${iso(d.nextAttemptAt)}`);
    }

    // Closing a connection while a dispatch over it has not ended is a trigger (N4, C26).
    closeConnection(s, sub, why) {
      const conn = sub.connection;
      if (!conn) return;
      sub.connection = null;
      this.network.event(`${sub.subscriber_id}'s connection closes: ${why}`);
      const d = sub.dispatch;
      if (d && d.channel === 'connection' && d.connection === conn) {
        this.network.event(`A dispatch over that connection had not ended, which is a trigger for ${sub.subscriber_id}`);
        this.startDispatch(s, sub);
      }
    }

    // Requests

    // Runs one operation from a request object, after checking it against the input schema.
    call(operation, request = {}) {
      const op = OPERATIONS[operation];
      if (!op) refuse('invalid_request', `No operation is named ${operation}`);
      const { subscriber_id, ...fields } = request;
      if (op.kind === 'subscriber' && typeof subscriber_id !== 'string') {
        refuse('invalid_request', 'A subscriber operation must carry a subscriber_id');
      }
      for (const [name, [type, required]] of Object.entries(op.fields)) {
        if (!(name in fields)) {
          if (required) refuse('invalid_request', `${operation} needs ${name}`);
          continue;
        }
        if (!T[type](fields[name], this.config.UINT_MAX)) refuse('invalid_request', `${name} must be of type ${type}`);
      }
      const unknown = Object.keys(fields).filter((k) => !(k in op.fields));
      if (unknown.length) refuse('invalid_request', `${operation} takes no field named ${unknown.join(', ')}`);
      const f = fields;
      switch (operation) {
        case 'GetStream': return this.getStream(f.stream_id);
        case 'ReadEntries': return this.readEntries(f.stream_id, f.from_sequence, f.limit);
        case 'ListSubscribedStreams': return this.listSubscribedStreams(subscriber_id);
        case 'GetSubscription': return this.getSubscription(subscriber_id, f.stream_id);
        case 'PatchSubscription': return this.patchSubscription(subscriber_id, f.stream_id, f);
        case 'Connect': return this.connect(subscriber_id, f.stream_id);
        case 'PullNotification': return this.pullNotification(subscriber_id, f.stream_id);
        case 'Acknowledge': return this.acknowledge(subscriber_id, f.stream_id, f.sequence);
        case 'CreateStream': return this.createStream(subscriber_id, f.title, f.roster);
        case 'PatchStream': return this.patchStream(subscriber_id, f.stream_id, f);
        case 'AdvanceStream': return this.advanceStream(subscriber_id, f.stream_id, f.expected_sequence, f.roster);
        case 'TerminateStream': return this.terminateStream(subscriber_id, f.stream_id, f.expected_sequence);
        case 'Append': return this.append(subscriber_id, f.stream_id, f.round, f.payload);
        case 'PurgeExpiredStreams': return this.purgeExpiredStreams();
      }
    }

    // Caller operations

    getStream(stream_id) {
      return this.publicStream(this.stream(stream_id));
    }

    readEntries(stream_id, from_sequence, limit) {
      const s = this.stream(stream_id);
      if (from_sequence === 0 || limit === 0) refuse('invalid_range', 'from_sequence and limit must be above 0');
      return s.entries
        .filter((e) => e.sequence >= from_sequence && (limit === undefined || e.sequence < from_sequence + limit))
        .map((e) => ({ ...e }));
    }

    // Subscriber operations

    listSubscribedStreams(subscriber_id) {
      return [...this.streams.values()]
        .filter((s) => s.subscriptions.has(subscriber_id))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .map((s) => this.publicStream(s));
    }

    getSubscription(subscriber_id, stream_id) {
      const s = this.stream(stream_id);
      return this.publicSubscription(this.subscription(s, subscriber_id));
    }

    patchSubscription(subscriber_id, stream_id, fields) {
      const address = fields.callback_address;
      if (typeof address === 'string' && !this.config.SUPPORTS_CALLBACKS) refuse('unsupported', 'This server supports no callback');
      if (typeof address === 'string' && !/^https:\/\/\S+$/.test(address)) {
        refuse('invalid_callback_address', 'A callback_address must be an https:// URL');
      }
      const s = this.stream(stream_id);
      const sub = this.subscription(s, subscriber_id);
      if ('callback_address' in fields) sub.callback_address = address;
      if (typeof address === 'string') this.startDispatch(s, sub);
      return this.publicSubscription(sub);
    }

    connect(subscriber_id, stream_id) {
      if (!this.config.SUPPORTS_CONNECTIONS) refuse('unsupported', 'This server supports no connection');
      const s = this.stream(stream_id);
      const sub = this.subscription(s, subscriber_id);
      if (this.terminated(s)) refuse('stream_terminated', 'The stream is terminated');
      this.closeConnection(s, sub, 'the subscriber connects again');
      sub.connection = { id: this.nextConnectionId++, closeAfterWrite: false };
      this.endDispatch(sub, 'Connect ends it');
      this.startDispatch(s, sub);
      return { connection_id: sub.connection ? sub.connection.id : null };
    }

    // The subscriber closing its own connection, which the server detects.
    disconnect(subscriber_id, stream_id) {
      const s = this.stream(stream_id);
      this.closeConnection(s, this.subscription(s, subscriber_id), 'the subscriber closed it');
    }

    pullNotification(subscriber_id, stream_id) {
      const s = this.stream(stream_id);
      return this.buildNotification(s, this.subscription(s, subscriber_id));
    }

    acknowledge(subscriber_id, stream_id, sequence) {
      const s = this.stream(stream_id);
      const sub = this.subscription(s, subscriber_id);
      if (sequence === 0 || sequence > this.highest(s)) {
        refuse('sequence_out_of_range', `Sequence ${sequence} is 0 or above the highest, ${this.highest(s)}`);
      }
      if (sequence > sub.floor) sub.floor = sequence;
      return this.publicSubscription(sub);
    }

    // Coordinator operations

    createStream(subscriber_id, title, roster) {
      this.checkRoster(null, subscriber_id, roster);
      const s = {
        id: `s${this.nextStreamId++}`,
        title,
        coordinator_id: subscriber_id,
        created_at: this.clock,
        to_be_purged_at: null,
        entries: [],
        subscriptions: new Map(),
      };
      this.streams.set(s.id, s);
      const entry = this.appendEntry(s, 1, 'boundary', subscriber_id, { roster: [...roster] });
      this.newSubscription(s, subscriber_id);
      for (const p of roster) this.newSubscription(s, p);
      this.push(s, entry);
      return this.publicStream(s);
    }

    patchStream(subscriber_id, stream_id, fields) {
      const s = this.stream(stream_id);
      if (subscriber_id !== s.coordinator_id) refuse('not_coordinator', `${subscriber_id} is not the coordinator`);
      if ('to_be_purged_at' in fields && !this.terminated(s)) refuse('stream_not_terminated', 'Only a terminated stream takes a to_be_purged_at');
      if ('coordinator_id' in fields && this.namedRounds(s, fields.coordinator_id).length) {
        refuse('invalid_coordinator', `A roster on ${s.id} names ${fields.coordinator_id}`);
      }
      const outgoing = s.coordinator_id;
      if ('title' in fields) s.title = fields.title;
      if ('to_be_purged_at' in fields) s.to_be_purged_at = fields.to_be_purged_at === null ? null : Date.parse(fields.to_be_purged_at);
      if ('coordinator_id' in fields && fields.coordinator_id !== outgoing) {
        s.coordinator_id = fields.coordinator_id;
        const incoming = s.subscriptions.get(s.coordinator_id) || this.newSubscription(s, s.coordinator_id);
        const out = s.subscriptions.get(outgoing);
        this.endDispatch(out, 'PatchStream replaced the coordinator');
        this.startDispatch(s, incoming);
        this.closeConnection(s, out, 'PatchStream replaced the coordinator');
      }
      return this.publicStream(s);
    }

    advanceStream(subscriber_id, stream_id, expected_sequence, roster) {
      const s = this.stream(stream_id);
      if (subscriber_id !== s.coordinator_id) refuse('not_coordinator', `${subscriber_id} is not the coordinator`);
      if (this.terminated(s)) refuse('stream_terminated', 'The stream is terminated');
      this.checkExpected(s, expected_sequence);
      this.checkRoster(s, s.coordinator_id, roster);
      this.checkSequenceRoom(s);
      const ended = this.roster(s, this.currentRound(s));
      const entry = this.appendEntry(s, this.currentRound(s) + 1, 'boundary', subscriber_id, { roster: [...roster] });
      for (const p of roster) {
        if (ended.includes(p)) continue;
        const sub = s.subscriptions.get(p) || this.newSubscription(s, p);
        if (entry.sequence - 1 > sub.floor) sub.floor = entry.sequence - 1;
      }
      this.push(s, entry);
      return { ...entry };
    }

    terminateStream(subscriber_id, stream_id, expected_sequence) {
      const s = this.stream(stream_id);
      if (subscriber_id !== s.coordinator_id) refuse('not_coordinator', `${subscriber_id} is not the coordinator`);
      if (this.terminated(s)) refuse('stream_terminated', 'The stream is terminated');
      this.checkExpected(s, expected_sequence);
      const entry = this.appendEntry(s, this.currentRound(s), 'termination', subscriber_id, '');
      s.to_be_purged_at = this.clock + this.config.LOCKSTEP_RETENTION;
      this.push(s, entry);
      for (const sub of s.subscriptions.values()) {
        if (!sub.connection) continue;
        const writing = sub.dispatch && sub.dispatch.channel === 'connection' && sub.dispatch.inFlight;
        if (writing) sub.connection.closeAfterWrite = true;
        else this.closeConnection(s, sub, 'the stream is terminated');
      }
      return { ...entry };
    }

    // Participant operations

    append(subscriber_id, stream_id, round, payload) {
      const s = this.stream(stream_id);
      if (this.terminated(s)) refuse('stream_terminated', 'The stream is terminated');
      if (round === 0 || round > this.currentRound(s)) {
        refuse('round_out_of_range', `Round ${round} is 0 or above the current round, ${this.currentRound(s)}`);
      }
      if (!this.roster(s, round).includes(subscriber_id)) refuse('not_on_roster', `Round ${round}'s roster does not name ${subscriber_id}`);
      const existing = s.entries.find((e) => e.type === 'contribution' && e.round === round && e.subscriber_id === subscriber_id);
      if (existing) refuse('duplicate_round', `${subscriber_id} already contributed to round ${round}`, { entry: { ...existing } });
      this.checkSequenceRoom(s);
      const entry = this.appendEntry(s, round, 'contribution', subscriber_id, payload);
      this.push(s, entry);
      return { ...entry };
    }

    // System operations

    purgeExpiredStreams() {
      const removed = [];
      for (const s of [...this.streams.values()]) {
        if (s.to_be_purged_at === null || s.to_be_purged_at > this.clock) continue;
        this.streams.delete(s.id);
        removed.push(s.id);
        this.network.event(`PurgeExpiredStreams removes ${s.id}, with its entries, subscriptions, dispatches and connections`);
      }
      return removed;
    }
  }

  const api = { Server, LockstepError, DEFAULT_CONFIG, OPERATIONS, invalidSetting };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Lockstep = api;
})(this);
