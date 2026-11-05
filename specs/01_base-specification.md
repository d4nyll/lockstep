# Base Specification

This is a base specification, so don't implement it directly. Write a specification that extends it to cater for the specific technology stack, then build your implementation against that extended specification. Anything this document does not specify, constrain, or require is left to the implementation to decide.

## Schemas

The schemas here define the minimum fields and types every implementation must support. An extended specification is allowed to add fields and constraints, but must not remove the fields and types these schemas define.

The server must refuse with `invalid_request` any request that supplies a field these schemas mark `server-assigned`.

### Data Schemas

#### Stream

| Field             | Type                | Mutable | comments                                                                              |
| ----------------- | ------------------- | ------- | ------------------------------------------------------------------------------------- |
| `id`              | string              | no      | server-assigned, unique across every stream ever held by the server, and never reused |
| `title`           | string              | yes     | free text                                                                             |
| `coordinator_id`  | string              | yes     | the `subscriber_id` of the caller at creation, changed by `PatchStream`               |
| `created_at`      | timestamp           | no      | server-assigned                                                                       |
| `to_be_purged_at` | timestamp, nullable | yes     | the earliest time at which the server is allowed to purge the stream                  |

#### Entry

| Field           | Type                                      | comments                                                       |
| --------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `stream_id`     | string                                    |                                                                |
| `sequence`      | unsigned int                              | server-assigned, unique within the stream, and only increments |
| `round`         | unsigned int                              |                                                                |
| `type`          | `contribution`, `boundary`, `termination` |                                                                |
| `subscriber_id` | string                                    | the `subscriber_id` of the subscriber that appended the entry  |
| `payload`       | depends on `type`                         |                                                                |

- `stream_id` and `sequence` together identify exactly one entry
- `payload`:
  - on a `contribution` it is bytes of any length (including zero) and is opaque to the server
  - on a `boundary` it is a `BoundaryPayload`
  - on a `termination` it is bytes of zero length
- This document does not distinguish a payload of zero length from a null one. If an extended specification's chosen stack can tell them apart, that specification decides what each means.
- `round`:
  - on a `boundary` it is the round that entry opens
  - on a `termination` it is the round that entry ends
  - on a `contribution` it is the round named by the appending participant, and must be a round in which the participant was on the round's roster

#### BoundaryPayload

| Field    | Type     | comments                                                                             |
| -------- | -------- | ------------------------------------------------------------------------------------ |
| `roster` | string[] | the `subscriber_id` of every participant on the roster of the round this entry opens |

#### Subscription

| Field              | Type             | comments                                                                                   |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------------ |
| `stream_id`        | string           |                                                                                            |
| `subscriber_id`    | string           |                                                                                            |
| `callback_address` | string, nullable |                                                                                            |
| `floor`            | unsigned int     | the server must never include an entry at or below it in a notification to that subscriber |

- `stream_id` and `subscriber_id` together identify exactly one subscription
- The server must create a subscription, with a null `callback_address`:
  - on `CreateStream`, for the coordinator
  - on a boundary, for each participant its roster names for the first time on that stream
  - on `PatchStream`, for an incoming coordinator that holds no subscription on that stream
- The server must remove a subscription only by purging its stream

### Message Schemas

#### Notification

| Field           | Type    | comments                                                                                                                  |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `stream_id`     | string  |                                                                                                                           |
| `subscriber_id` | string  | the `subscriber_id` of the subscriber this notification is for                                                            |
| `entries`       | Entry[] | every entry above the subscription's `floor` and at or below the subscriber's horizon, in ascending sequence number order |

#### Error

| Field     | Type             | comments                                                  |
| --------- | ---------------- | --------------------------------------------------------- |
| `code`    | string           | the refusal's identifier; the full list is in Appendix A  |
| `message` | string           | human-friendly description of the refusal                 |
| `data`    | object, nullable | the format depends on the value of `code`; see Appendix A |

## Identity

Authentication and authorization are outside the scope of this specification.

Every operation is one of these kinds:

- a **caller operation** (the operations under Caller), which any caller is allowed to make
- a **subscriber operation** (the operations under Subscriber, Coordinator and Participants), which a caller makes under its `subscriber_id`
- a **system operation** (the operations under System), which only the server runs

A call to a subscriber operation must carry the caller's `subscriber_id`, in addition to that operation's input fields. The server must refuse with `invalid_request` a call to a subscriber operation that carries no `subscriber_id`. The server must ignore any `subscriber_id` carried by a call to a caller operation.

A caller is the coordinator when its `subscriber_id` matches the stream's `coordinator_id`, and is a participant of a round when that round's roster names it. A stream's **former coordinators** are the subscribers on it that no roster on it has named, other than its current coordinator.

## Behaviors and Rules

### Server rules

#### Sequencing and rounds

S1. A stream is live until it holds a termination entry.
S2. A live stream's current round is the `round` of its highest-sequence boundary entry.
S3. A terminated stream's final round is the `round` of its termination entry.
S4. Every entry must have a sequence number.
S5. Sequence numbers within a stream must start at 1, taken by the opening boundary entry.
S6. Within a stream, each entry after the first must take the previous entry's sequence number plus 1.
S7. Only a termination entry is allowed to take the highest sequence number an `unsigned int` holds.
S8. If a stream's next sequence would reach the highest sequence number an `unsigned int` holds, the server must refuse every contribution and boundary on that stream with `sequence_exhausted`.
S9. On a stream, the server must run these mutating operations sequentially:

   - `Append`
   - `AdvanceStream`
   - `TerminateStream`
   - `PatchStream`
   - `Connect`, as far as opening the connection
   - the removal of that stream by `PurgeExpiredStreams`

S10. A mutating operation's changes to a stream must be atomic.
S11. A mutating operation's changes to a stream must survive a restart of the server.
S12. These operations must leave every `floor` and every dispatch as it was:

   - `ListSubscribedStreams`
   - `GetStream`
   - `ReadEntries`
   - `GetSubscription`
   - `PullNotification`

S13. On a subscription, the server must run these mutating operations sequentially:

   - `PatchSubscription`
   - `Acknowledge`
   - `AdvanceStream`, as far as setting a `floor`

S14. A `floor` must never decrease.
S15. If a stream has a current round when a boundary entry is appended, that boundary entry must end that round.
S16. A termination entry must end the current round.
S17. A stream that holds a termination entry must refuse every further entry.
S18. If a step reads the server's clock, every value that step writes from the clock must hold one reading.
S19. Once appended, an entry must not change.

#### Roster

R1. A participant is on a round's roster if and only if the payload of the boundary that opened that round names that participant.
R2. The order of the names in a roster carries no meaning.
R3. If a boundary names a participant that already holds a subscription on that stream, the server must reuse that subscription and keep the `callback_address` stored on it.

#### Notifications

N1. A subscriber's horizon is the latest entry the server is allowed to include in a notification to that subscriber:

   | Stream     | Recipient                                       | Horizon                                                      |
   | ---------- | ----------------------------------------------- | ------------------------------------------------------------ |
   | any        | the coordinator                                 | the stream's latest entry                                    |
   | live       | a participant on the current round's roster     | the boundary that opened the current round                   |
   | live       | a participant not on the current round's roster | the boundary that ended the last round whose roster named it |
   | terminated | a participant on the final round's roster       | the termination entry                                        |
   | terminated | a participant not on the final round's roster   | the boundary that ended the last round whose roster named it |
   | any        | a former coordinator                            | no entry, so every notification to it is empty               |

N2. When the server builds a notification, that notification must carry every entry above the recipient's `floor` and at or below the recipient's horizon, in ascending sequence number order.
N3. A notification is allowed to be empty.
N4. A trigger is an event after which the server builds and pushes notifications:

    | Trigger                                                           | Pushed to                                                                        |
    | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
    | a boundary appended                                               | every participant on the roster of the round it ended or the round it opened     |
    | a termination appended                                            | every participant on the final round's roster                                    |
    | any entry appended                                                | the subscriber named by the stream's `coordinator_id` when the entry is appended |
    | a subscriber connecting, or setting a non-null `callback_address` | that subscriber                                                                  |
    | a connection closes while a dispatch over it has not ended        | that subscriber                                                                  |
    | `PatchStream` changing `coordinator_id`                           | the incoming coordinator                                                         |

N5. A subscriber is allowed to acknowledge a sequence above its own horizon, up to the stream's highest.

#### Channels

A trigger starts one **dispatch** for each subscriber N4 names for that trigger. Each **attempt** on a dispatch carries one notification over that subscriber's channel. A **retry** is an attempt made after an earlier attempt on the same dispatch failed.

C1. The server must choose a subscriber's channel when a dispatch starts, and again when a dispatch resumes.
C2. The server must choose a subscriber's open connection when that subscriber has one, otherwise that subscriber's `callback_address`.
C3. If a subscriber has no open connection and its `callback_address` is unset, that subscriber has no channel.
C4. Each attempt must carry a notification built at the moment of that attempt.
C5. An attempt that succeeds means the notification reached the subscriber.
C6. A dispatch over a connection must consist of only a single attempt.
C7. The server must make the attempt of a dispatch over a connection without any intentional delay.
C8. If an attempt over a connection fails, the server must close the connection.
C9. A dispatch to a `callback_address` must wait before its first attempt, until the earlier of its **debounce interval** and its **debounce limit** runs out.
C10. A dispatch's debounce interval ends `LOCKSTEP_DEBOUNCE_INTERVAL` after the trigger that started the dispatch.
C11. A dispatch's debounce limit ends `LOCKSTEP_DEBOUNCE_LIMIT` after the trigger that started the dispatch, unless C13 sets it.
C12. The server must end a dispatch:

   - when the server starts another dispatch for the same subscriber on the same stream
   - when an attempt on it succeeds
   - when it is a dispatch to a `callback_address`, has made `LOCKSTEP_DISPATCH_MAX_ATTEMPTS` attempts in all, and the last of them has failed
   - when it is a dispatch over a connection and that connection closes
   - when it starts or resumes while that subscriber has no channel
   - when an attempt on it is due and the channel it uses no longer exists
   - when `PurgeExpiredStreams` removes the stream it is on
   - when it is a dispatch to the outgoing coordinator and `PatchStream` changes `coordinator_id`

C13. A dispatch that replaces one that had made no attempt must take over the replaced dispatch's debounce limit.
C14. A dispatch starts with an attempt count of zero.
C15. When the server makes an attempt, the server must add 1 to that dispatch's attempt count.
C16. An attempt by a dispatch to a `callback_address` must use the address stored on that subscriber's subscription when the attempt is due.
C17. The **response timeout** of an attempt to a `callback_address` is how long the server waits for that attempt to return, and ends `LOCKSTEP_RESPONSE_TIMEOUT` after the server made the attempt.
C18. If an attempt to a `callback_address` returns nothing within its response timeout, the server must treat that attempt as failed and no longer in flight.
C19. If an attempt to a `callback_address` fails while its dispatch has not ended, the server must make a retry.
C20. Before the first retry the server must wait `LOCKSTEP_DISPATCH_RETRY_BASE` after the previous attempt failed, then double the wait before each retry after that, up to `LOCKSTEP_DISPATCH_RETRY_MAX`.
C21. A dispatch is allowed at most one attempt in flight.
C22. Appending an entry and starting the dispatches that push it must take effect together.
C23. After a restart of the server, the server must resume every dispatch to a `callback_address` that had not ended when the server stopped.
C24. When the server resumes a dispatch, the server must treat an attempt that was in flight when the server stopped as failed and no longer in flight.
C25. After a restart of the server, the server must treat each dispatch over a connection that had not ended when the server stopped as a dispatch whose connection closed.
C26. When a connection closes while a dispatch over it has not ended, ending that dispatch and starting the next dispatch to that subscriber must take effect together.

### Client obligations

These are the requirements for subscribers to work correctly with the server and with each other.

#### Every subscriber

A1. A subscriber must keep its own record of the highest sequence number it has processed.
A2. A subscriber must acknowledge a sequence only once the subscriber has processed that entry and every earlier entry it had not already acknowledged.
A3. A subscriber is allowed to acknowledge entries it obtained through `ReadEntries` rather than through a notification.

#### The coordinator

D1. After `CreateStream` returns successfully, the coordinator must tell the `stream_id` out of band to each participant on round 1's roster.
D2. After `AdvanceStream` returns successfully, the coordinator must tell the `stream_id` out of band to each participant on the new round's roster but not on the previous round's roster.
D3. After `PatchStream` changes a stream's `coordinator_id`, the caller must tell the incoming coordinator the `stream_id` out of band.

## Server state

Beyond the schemas above, the server holds internal state, which it must not expose on any interface. Every `Stream`, `Entry`, `Subscription` and pending dispatch must survive a restart of the server.

### Connection

A subscriber and a stream together identify at most one connection, which holds the means of writing a notification to that subscriber. The server closes a connection:

- on `Connect`, the caller's existing connection on that stream, before opening the next
- on `PatchStream`, the outgoing coordinator's, and only when it changes `coordinator_id`
- on `TerminateStream` and `PurgeExpiredStreams`, every connection on the stream
- on an attempt that fails to write to a connection

A restart of the server closes every transport, so no connection survives one.

### Pending dispatch

A subscription has at most one pending dispatch, which holds:

- the channel
- the end of the debounce interval
- the end of the debounce limit
- the attempt count
- whether an attempt is in flight

## Operations

Each operation is a sequence of steps.

If a request omits a required field or carries a field of the wrong type, the server must refuse that request with `invalid_request` before step 1. Otherwise the server must run the steps in order, and must stop at the first refusal. A refusal returns an `Error` carrying that step's `code`. Appendix A lists every `code` in one place.

A request that reaches the last step succeeds.

Steps marked atomic must all take effect together, or not at all. If the server stops part way through an operation, the server must leave the atomic steps it completed in place. A caller that saw no response can read the stream to find out whether the operation took effect.

These phrases recur in the steps below.

To **build a notification** for a subscriber is to take that subscriber's horizon under N1 and its subscription's `floor`, and select every entry above the `floor` and at or below the horizon, in ascending sequence number order.

To **push** an entry is to determine its recipients under N4 and create a pending dispatch for each.

### Caller

`GetStream`, `ReadEntries`.

#### `GetStream`

Input:

| Field       | Type   | Required | comments |
| ----------- | ------ | -------- | -------- |
| `stream_id` | string | yes      |          |

Output: the `Stream`, with every field.

Steps:

1. If no stream has `stream_id`, refuse with `no_such_stream`
2. Return the stream, with every field

#### `ReadEntries`

Input:

| Field           | Type         | Required | comments                                                     |
| --------------- | ------------ | -------- | ------------------------------------------------------------ |
| `stream_id`     | string       | yes      |                                                              |
| `from_sequence` | unsigned int | yes      | the lowest sequence to return                                |
| `limit`         | unsigned int | no       | if absent, `ReadEntries` reads to the stream's highest entry |

Output: `Entry[]`, each entry with every field.

Steps:

1. If no stream has `stream_id`, refuse with `no_such_stream`
2. If the value of `from_sequence` is 0, or the request carries `limit` with a value of 0, refuse with `invalid_range`
3. Select every entry of the stream whose `sequence` is at or above the value of `from_sequence`. If the request carries `limit`, keep only those whose `sequence` is below the value of `from_sequence` plus the value of `limit`. That sum is arithmetic and does not wrap
4. Return those entries, each with every field, lowest `sequence` first. If none match, return an empty array

Any caller is allowed to read any stream, and every entry on it is available through `ReadEntries` regardless of the caller's horizon.

### Subscriber

`ListSubscribedStreams`, `GetSubscription`, `PatchSubscription`, `Connect`, `PullNotification`, `Acknowledge`.

#### `ListSubscribedStreams`

Input: none.

Output: `Stream[]`, each with every field.

Steps:

1. Select every stream on which the caller holds a subscription
2. Return those streams, newest `created_at` first. If two share a `created_at`, order them by descending `id` under the string comparison defined by the extended specification. If none match, return an empty array

#### `GetSubscription`

Input:

| Field       | Type   | Required | comments |
| ----------- | ------ | -------- | -------- |
| `stream_id` | string | yes      |          |

Output: the caller's own `Subscription`, with every field.

Steps:

1. If no stream has `stream_id`, refuse with `no_such_stream`
2. If the caller holds no subscription on that stream, refuse with `no_subscription`
3. Return the caller's subscription, with every field

#### `PatchSubscription`

Input:

| Field              | Type             | Required | comments                         |
| ------------------ | ---------------- | -------- | -------------------------------- |
| `stream_id`        | string           | yes      |                                  |
| `callback_address` | string, nullable | no       | a null clears the stored address |

Output: the caller's own `Subscription`, with every field.

Steps:

1. If the request carries a non-null `callback_address` and the implementation supports no callback, refuse with `unsupported`
2. If the extended specification holds the `callback_address` in the request invalid, refuse with the `code` named by that specification
3. If no stream has `stream_id`, refuse with `no_such_stream`
4. If the caller holds no subscription on that stream, refuse with `no_subscription`
5. Atomically:
   1. If the request carries `callback_address`, write its value to the subscription. A null clears the subscription's `callback_address`. Leave a field omitted by the request as it was
   2. If step 5.1 wrote a non-null `callback_address`, start a dispatch for the caller
6. Return the caller's subscription, with every field

#### `Connect`

Input:

| Field       | Type   | Required | comments |
| ----------- | ------ | -------- | -------- |
| `stream_id` | string | yes      |          |

Output: each `Notification` the server writes into the connection, until the connection closes.

Steps:

1. If the implementation supports no connection, refuse with `unsupported`
2. If no stream has `stream_id`, refuse with `no_such_stream`
3. If the caller holds no subscription on that stream, refuse with `no_subscription`
4. If the stream holds a termination entry, refuse with `stream_terminated`
5. If the caller holds an existing connection on this stream, close it. A connection the caller holds on another stream is unaffected
6. Open a connection to the caller
7. End any dispatch for the caller's subscription on this stream
8. Build a notification for the caller, and write it into the connection
9. Write each later notification for the caller into the connection, until the connection closes

The connect trigger starts its dispatch at step 8, and that step's write is the dispatch's single attempt. Each write in step 9 is the single attempt of the dispatch a later trigger starts.

#### `PullNotification`

Input:

| Field       | Type   | Required | comments |
| ----------- | ------ | -------- | -------- |
| `stream_id` | string | yes      |          |

Output: a `Notification`, with every field.

Steps:

1. If no stream has `stream_id`, refuse with `no_such_stream`
2. If the caller holds no subscription on that stream, refuse with `no_subscription`
3. Build a notification for the caller
4. Return it, with every field

#### `Acknowledge`

Input:

| Field       | Type         | Required | comments                                     |
| ----------- | ------------ | -------- | -------------------------------------------- |
| `stream_id` | string       | yes      |                                              |
| `sequence`  | unsigned int | yes      | the sequence of the entry being acknowledged |

Output: the caller's own `Subscription`, with every field.

Steps:

1. If no stream has `stream_id`, refuse with `no_such_stream`
2. If the caller holds no subscription on that stream, refuse with `no_subscription`
3. If the value of `sequence` is 0, or above the stream's highest sequence, refuse with `sequence_out_of_range`
4. Atomically, if the value of `sequence` is above the subscription's `floor`, set `floor` to that value
5. Return the caller's subscription, with every field

### Coordinator

`CreateStream`, `PatchStream`, `AdvanceStream`, `TerminateStream`.

#### `CreateStream`

Input:

| Field    | Type     | Required | comments                                                     |
| -------- | -------- | -------- | ------------------------------------------------------------ |
| `title`  | string   | yes      |                                                              |
| `roster` | string[] | yes      | is allowed to be empty, opening round 1 with no participants |

Output: the `Stream`, with every field.

Steps:

1. If `roster` names the caller, or names the same participant twice, refuse with `invalid_roster`
2. Atomically:
   1. Create the stream, assigning `id` and `created_at`, taking `coordinator_id` from the caller and `title` from the request, and leaving `to_be_purged_at` null
   2. Append a boundary entry at sequence 1, carrying round 1, the caller as `subscriber_id`, and `roster` as its payload
   3. Create a subscription for the caller, with a `floor` of 0
   4. Create a subscription for each participant in `roster`, with a `floor` of 0
   5. Push the entry appended in step 2.2
3. Return the stream, with every field

A coordinator that saw no response should call `ListSubscribedStreams` before calling `CreateStream` again.

#### `PatchStream`

Input:

| Field             | Type                | Required | comments                             |
| ----------------- | ------------------- | -------- | ------------------------------------ |
| `stream_id`       | string              | yes      |                                      |
| `title`           | string              | no       |                                      |
| `coordinator_id`  | string              | no       |                                      |
| `to_be_purged_at` | timestamp, nullable | no       | a null keeps the stream indefinitely |

Output: the `Stream`, with every field.

Steps:

1. If no stream has `stream_id`, refuse with `no_such_stream`
2. If the caller is not that stream's `coordinator_id`, refuse with `not_coordinator`
3. If the request carries `to_be_purged_at` at any value, and the stream holds no termination entry, refuse with `stream_not_terminated`
4. If the request carries a `coordinator_id` that a roster on that stream names, refuse with `invalid_coordinator`
5. Atomically:
   1. Write each field carried by the request. Leave a field omitted by the request as it was
   2. If step 5.1 changed the value of `coordinator_id`:
      1. If the incoming coordinator holds no subscription on that stream, create one for it, with a `floor` of 0
      2. End any dispatch for the outgoing coordinator on that stream
      3. Start a dispatch for the incoming coordinator
6. If step 5.1 changed the value of `coordinator_id`, close any connection held by the outgoing coordinator on that stream
7. Return the stream, with every field

#### `AdvanceStream`

Input:

| Field               | Type         | Required | comments                                                     |
| ------------------- | ------------ | -------- | ------------------------------------------------------------ |
| `stream_id`         | string       | yes      |                                                              |
| `expected_sequence` | unsigned int | yes      | the stream's highest sequence as the caller last saw it      |
| `roster`            | string[]     | yes      | is allowed to be empty, opening a round with no participants |

Output: the boundary `Entry` appended, with every field.

Steps:

1. If no stream has `stream_id`, refuse with `no_such_stream`
2. If the caller is not that stream's `coordinator_id`, refuse with `not_coordinator`
3. If the stream holds a termination entry, refuse with `stream_terminated`
4. If the value of `expected_sequence` is not the stream's highest sequence, refuse with `stale_sequence`, carrying the entry at that highest sequence
5. If `roster` names that stream's coordinator or one of its former coordinators, or names the same participant twice, refuse with `invalid_roster`
6. If the stream's next sequence would reach the highest sequence number an `unsigned int` holds, refuse with `sequence_exhausted`
7. Atomically:
   1. Append a boundary entry carrying the current round's number plus 1, the caller as `subscriber_id`, and `roster` as its payload
   2. For each participant in `roster` not named by the roster of the round ended by this boundary: if that participant holds no subscription, create one with a `floor` of 0, and if this boundary's sequence minus 1 is above that participant's `floor`, set `floor` to that value
   3. Push the entry appended in step 7.1
8. Return the entry appended in step 7.1, with every field

A coordinator that saw no response should retry `AdvanceStream` with the same `expected_sequence`. If the server refuses the retry with `stale_sequence`, the coordinator should read the entry at the value of `expected_sequence` plus 1 to find out whether that entry is its own boundary.

#### `TerminateStream`

Input:

| Field               | Type         | Required | comments                                                |
| ------------------- | ------------ | -------- | ------------------------------------------------------- |
| `stream_id`         | string       | yes      |                                                         |
| `expected_sequence` | unsigned int | yes      | the stream's highest sequence as the caller last saw it |

Output: the termination `Entry` appended, with every field.

Steps:

1. If no stream has `stream_id`, refuse with `no_such_stream`
2. If the caller is not that stream's `coordinator_id`, refuse with `not_coordinator`
3. If the stream holds a termination entry, refuse with `stream_terminated`
4. If the value of `expected_sequence` is not the stream's highest sequence, refuse with `stale_sequence`, carrying the entry at that highest sequence
5. Atomically:
   1. Append a termination entry carrying the current round's number, the caller as `subscriber_id`, and a payload of zero length
   2. Set `to_be_purged_at` to the server's clock plus `LOCKSTEP_RETENTION`
   3. Push the entry appended in step 5.1
6. Close every open connection on that stream. If a connection is owed a notification from step 5.3, close it once that notification has been written into it. Close every other connection at once. Step 7 does not wait for these connections to close
7. Return the entry appended in step 5.1, with every field

### Participants

`Append`.

#### `Append`

Input:

| Field       | Type         | Required | comments                                      |
| ----------- | ------------ | -------- | --------------------------------------------- |
| `stream_id` | string       | yes      |                                               |
| `round`     | unsigned int | yes      | the current round's number, or a past round's |
| `payload`   | bytes        | yes      | is allowed to be of zero length               |

Output: the contribution `Entry` appended, with every field.

Steps:

1. If no stream has `stream_id`, refuse with `no_such_stream`
2. If the stream holds a termination entry, refuse with `stream_terminated`
3. If the value of `round` is 0, or above the current round's number, refuse with `round_out_of_range`
4. If the roster of `round` does not name the caller, refuse with `not_on_roster`
5. If the caller already has a contribution entry carrying `round` on that stream, refuse with `duplicate_round`, carrying that existing entry
6. If the stream's next sequence would reach the highest sequence number an `unsigned int` holds, refuse with `sequence_exhausted`
7. Atomically:
   1. Append a contribution entry carrying `round`, the caller as `subscriber_id`, and `payload`
   2. Push the entry appended in step 7.1
8. Return the entry appended in step 7.1, with every field

A participant that saw no response should retry `Append`.

### System

The operations here are system operations. The server runs `PurgeExpiredStreams` on the schedule set by `LOCKSTEP_PURGE_ENABLED` and `LOCKSTEP_PURGE_INTERVAL`.

`PurgeExpiredStreams`.

#### `PurgeExpiredStreams`

Input: none.

Output: `string[]`, the `id` of each stream removed, in no fixed order.

Steps:

1. Select every stream whose `to_be_purged_at` is non-null and at or before the server's clock
2. For each selected stream, under the same per-stream serialization as S9:
   1. If the value of `to_be_purged_at` is now null or in the future, leave that stream and move to the next
   2. Atomically remove the stream, every entry on it, every subscription on it, and every pending dispatch on it
   3. Close every open connection on that stream
3. Return the `id` of each stream removed, in no fixed order

If step 2 fails for one stream, the server must still attempt the remaining streams.

Only `PurgeExpiredStreams` is allowed to remove a stream.

## Decisions left to the extended specification

The extended specification must name a transport and a wire format, and must define each of these, from what its chosen stack can do:

- how a call carries the caller's `subscriber_id`
- what a string is (including its encoding), and when two string values are equal. Roster membership, the duplicate checks and the coordinator check all depend on that comparison
- how two string values order, which `ListSubscribedStreams` step 2 uses to break a tie on `created_at`
- the valid format for a `subscriber_id`, and the `code` raised for an invalid one. This document holds no `subscriber_id` invalid (the empty string included).
- whether a payload of zero length differs from a null one, and what each means
- how a `timestamp`, a `duration`, `bytes` and a `boolean` are represented, and the range an `unsigned int` covers, which must reach at least 2
- what happens when adding a `duration` to a `timestamp` gives a result outside the range of a `timestamp`
- the valid format for a `callback_address`, and the `code` raised for an invalid one
- whether a request carrying a field the operation's input does not name, other than a `server-assigned` one, is refused with `invalid_request` or has that field ignored
- how an `Error` is returned, and how `code`, `message` and `data` are carried
- how a `BoundaryPayload` is encoded into the `payload` field of a boundary entry
- how the server contacts a `callback_address` with a notification
- what happens to a live stream whose coordinator stops responding
- on an attempt to a `callback_address`:
  - what makes it succeed
  - what makes it fail
- on a connection:
  - what opening one is
  - what writing a notification into one is
  - what closing one is
  - how either side detects that one has closed
- whether one transport connection carries the connections of several streams at once, or each needs its own. A subscriber watching three streams holds three connections as this document counts them. On a transport that multiplexes (e.g. HTTP/2), those three share one transport connection; on a transport that does not, they are three
- any maximum the extended specification imposes on the size of a `title`, a `subscriber_id`, a `roster`, a `callback_address`, a `payload`, a `limit` on `ReadEntries`, or a notification. This document sets none, so an extended specification that refuses an oversized request defines that refusal itself

An implementation must support connections, callback addresses, or both. The extended specification must state which of them it supports, and the only way an operation reports it is by refusing with `unsupported`.

## Configuration

Each setting has a default chosen by the implementation, and applies to every stream and every subscriber.

If a setting is given a value the table below forbids, the server must not start. The server must report which setting and stop, rather than running on a value it cannot honor.

| Setting                          | Type         | Range                                   | Governs                                                                                                                                                                                                           |
| -------------------------------- | ------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOCKSTEP_DEBOUNCE_INTERVAL`     | duration     | zero or above                           | the debounce interval: how long a dispatch waits after the trigger that started it before its first attempt, unless its debounce limit runs out first                                                             |
| `LOCKSTEP_DEBOUNCE_LIMIT`        | duration     | at least `LOCKSTEP_DEBOUNCE_INTERVAL`   | the debounce limit: the limit on the whole wait before a dispatch's first attempt                                                                                                                                 |
| `LOCKSTEP_RESPONSE_TIMEOUT`      | duration     | above zero                              | the response timeout: how long the server waits for an attempt to return                                                                                                                                          |
| `LOCKSTEP_DISPATCH_RETRY_BASE`   | duration     | above zero                              | the delay before the first retry, doubling for each one after                                                                                                                                                     |
| `LOCKSTEP_DISPATCH_MAX_ATTEMPTS` | unsigned int | at least 1                              | the number of attempts to a `callback_address` the server makes in all (first attempt and retries together)                                                                                                       |
| `LOCKSTEP_DISPATCH_RETRY_MAX`    | duration     | at least `LOCKSTEP_DISPATCH_RETRY_BASE` | the longest any single retry waits, whatever the doubling would give                                                                                                                                              |
| `LOCKSTEP_RETENTION`             | duration     | zero or above                           | how far ahead termination sets `to_be_purged_at`                                                                                                                                                                  |
| `LOCKSTEP_PURGE_ENABLED`         | boolean      | true or false                           | whether the server runs `PurgeExpiredStreams` on its own. If false, a stream is removed only when an operator runs `PurgeExpiredStreams` through the interface the extended specification documents               |
| `LOCKSTEP_PURGE_INTERVAL`        | duration     | above zero                              | how long the server waits between the end of one `PurgeExpiredStreams` run and the start of the next, if the value of `LOCKSTEP_PURGE_ENABLED` is true. The first run starts one interval after the server starts |

## Appendix A: refusal codes

Every refusal named by an operation's steps appears in the table below, except the one `PatchSubscription` step 2 raises, which the extended specification names. `data` is null for every code whose `data` column here is blank.

| `code`                  | Raised by                                                                            | Condition                                                                                                                                                                   | `data`                                                         |
| ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `unsupported`           | `Connect`, `PatchSubscription`                                                       | the implementation supports no connection, or no callback                                                                                                                   |                                                                |
| `invalid_request`       | every operation                                                                      | a required field is missing, a field carries the wrong type, a call to a subscriber operation carries no `subscriber_id`, or the request supplies a `server-assigned` field |                                                                |
| `no_such_stream`        | every operation naming a `stream_id`                                                 | no stream has that `stream_id`                                                                                                                                              |                                                                |
| `not_coordinator`       | `PatchStream`, `AdvanceStream`, `TerminateStream`                                    | the caller is not the stream's `coordinator_id`                                                                                                                             |                                                                |
| `no_subscription`       | `GetSubscription`, `PatchSubscription`, `Connect`, `PullNotification`, `Acknowledge` | the caller holds no subscription on that stream                                                                                                                             |                                                                |
| `stream_terminated`     | `Append`, `AdvanceStream`, `TerminateStream`, `Connect`                              | the stream holds a termination entry                                                                                                                                        |                                                                |
| `stale_sequence`        | `AdvanceStream`, `TerminateStream`                                                   | `expected_sequence` is not the stream's highest sequence                                                                                                                    | `{ entry: Entry }`, the entry at the stream's highest sequence |
| `round_out_of_range`    | `Append`                                                                             | `round` is 0, or above the current round's number                                                                                                                           |                                                                |
| `not_on_roster`         | `Append`                                                                             | the roster of that `round` does not name the caller                                                                                                                         |                                                                |
| `duplicate_round`       | `Append`                                                                             | the caller already has a contribution for that `round`                                                                                                                      | `{ entry: Entry }`, the existing entry                         |
| `invalid_roster`        | `CreateStream`, `AdvanceStream`                                                      | `roster` names the stream's coordinator or one of its former coordinators, or the same participant twice                                                                    |                                                                |
| `invalid_coordinator`   | `PatchStream`                                                                        | the `coordinator_id` given is named by a roster on that stream                                                                                                              |                                                                |
| `stream_not_terminated` | `PatchStream`                                                                        | the request carries `to_be_purged_at` and the stream holds no termination entry                                                                                             |                                                                |
| `sequence_out_of_range` | `Acknowledge`                                                                        | `sequence` is 0, or above the stream's highest sequence                                                                                                                     |                                                                |
| `invalid_range`         | `ReadEntries`                                                                        | `from_sequence` is 0, or `limit` is 0                                                                                                                                       |                                                                |
| `sequence_exhausted`    | `Append`, `AdvanceStream`                                                            | the stream's next sequence would reach the highest sequence number an `unsigned int` holds                                                                                  |                                                                |

A purged stream is indistinguishable from one that never existed, so both raise `no_such_stream`.
