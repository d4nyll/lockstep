# Mental Model

> This document is a high-level mental model of Lockstep. Details such as the full set of rules, edge cases, and the resolution of any ambiguities are covered in other documents.

Lockstep is a server that coordinates participants working on a task together. The work proceeds in rounds: a participant appends its work during a round, and the other participants are notified of it only when the coordinator ends the round.

## The stream

- Lockstep coordinates work on a **task**, representing it as a **stream**: an append-only sequence of **entries**
- The task itself is opaque to the system
- Work on the task proceeds in **rounds**, and every entry is for exactly one round
- Rounds are numbered consecutively, starting at 1
- A **caller** is an entity that calls the system. Callers fall into two categories:
  - **subscribers** on a stream: they are able, under the conditions detailed below, to append entries to the stream and to be notified of new entries on it
  - **non-subscribers**: they are able to read the stream, but not to append entries to it or be notified of them
- There are two mutually exclusive types of subscribers, distinguished by which entries they can append:
  - **participants** (zero or more per stream): responsible for contributing work for the task, which they do by appending **contribution** entries
  - **coordinator** (exactly one per stream): solely responsible for deciding:
    - with a **boundary** entry: when to **advance** the stream to the next round, and which participants are on that round's roster
    - with a **termination** entry: when to **terminate** the stream
- A stream's coordinator can be replaced by another caller. Nothing on the stream records the change. The outgoing coordinator remains a subscriber, but can no longer append entries
- A subscriber that has been a stream's coordinator must never be on any of its rosters, and a subscriber that any of its rosters has named must never become its coordinator
- A stream is created by its coordinator. Creating the stream and appending a boundary entry at sequence 1, which opens round 1, are atomic, so no stream exists without its first entry
- A stream is **live** until the coordinator terminates it. A **terminated** stream accepts no further entries, but remains readable until the system **purges** it. Purging deletes the stream entirely, and is done by the system itself, never by a caller
- On a live stream, the latest round the coordinator has opened is called the **current round**. Every other round is a **past** round
- A live stream has exactly one current round; a terminated stream has none
- The current round ends only when the coordinator either:
  - advances the stream, which ends the round and opens the next one
  - terminates the stream, which ends the round (the stream's **final round**) and opens nothing after it
- The **roster** of a round is the set of participants named by the coordinator in the boundary entry that opens the round. It is fixed when the round opens and cannot change for that round
- A round is **complete** once every participant on its roster has appended its contribution for it; no further contributions can be appended for a complete round. Until then it is **incomplete**
- Whether a round is current or past is independent of whether it is complete or incomplete. On a live stream, each round is one of:
  - current and incomplete
  - current and complete
  - past and incomplete
  - past and complete

  A terminated stream has no current round, so each of its rounds is either past and incomplete, or past and complete

## Entries

- Every entry:
  - has a **sequence number**: its position in the stream, starting at 1 and incrementing by 1 with each append
  - is always appended at the tail of the stream
  - has a **round number**: the round the entry is **for**:
    - for a boundary entry, this is the round it opens
    - for a termination entry, this is the round it ends
    - for a contribution entry, this is the round the work was done for, which may be the current round or a past one
  - has a **payload**: the content the entry carries, whose meaning depends on the entry type
    - A payload is allowed to be empty, and the model does not distinguish an empty payload from a missing one
  - is immutable: once an entry is on a stream, it cannot be changed
  - cannot be removed, short of the whole stream being purged
- A **contribution** entry's payload represents what the participant did for a round and wants to share with other subscribers
  - A contribution entry's payload is opaque to the system
  - A participant is only allowed to append contributions for rounds whose roster includes it, and at most one per round number
  - Ending a round notifies the rosters of the round it ended and the round it opened of every entry they have not acknowledged, up to the boundary that ended it. A participant does its work for the round from what it received, then appends its contribution
  - A participant is allowed to append a contribution for a past round whether or not the participant is on the current round's roster
    - This lets the coordinator advance the stream without waiting for a slow participant, which appends its contribution for that round when its work is done
  - An empty payload means the participant did its work and has nothing to share. It counts as its contribution
- A **boundary** entry ends the current round, if there is one, and opens a new round. Its payload is the roster of the round it opens
- A **termination** entry terminates the stream. Its payload is empty

## Obtaining entries

- A subscriber obtains entries from a stream in one of two ways:
  - **polling**: the subscriber asks the system for entries whenever it chooses
  - **push**: after certain events, called **triggers**, the system pushes to subscribers, in messages called **notifications**, a subset of entries they have not yet acknowledged.
- A **trigger** is an event after which the system builds and pushes notifications:
  - a boundary being appended: to every participant on the roster of either the round it ended or the round it opened
  - a termination being appended: to every participant on the final round's roster
  - any entry being appended: to the coordinator
  - a subscriber opening a channel (connecting, or registering a callback): to that subscriber
  - a connection closing while a push over it is still pending, including by a restart of the system: to that subscriber
  - the coordinator being replaced: to the incoming coordinator
- A **channel** is the path a pushed notification takes to reach a subscriber
  - The kinds of channel are distinguished by who makes contact:
    - a **connection** that the subscriber opens and holds, and into which the system writes notifications while it is open
      - a subscriber holds at most one connection per stream; a new one replaces the older
    - a **callback**: an address the subscriber registers, which the system contacts for each notification
  - An open connection is used in preference to a callback
  - A subscriber with no channel is pushed no notifications
  - An implementation must support at least one kind of channel
  - The protocols realising connections and callbacks are left to the implementation
- A subscriber must keep its own record of the highest sequence number it has processed
- A subscriber **acknowledges** an entry, however the entry reached it, by sending its sequence number to the system. The acknowledgement states that the subscriber has processed that entry and every earlier entry it had not already acknowledged, so the system need not send them again
  - A subscriber must acknowledge an entry only once that is true
  - A single notification can lead to several acknowledgements
  - Acknowledging an entry at or before one already acknowledged has no effect
- A **subscription** is the system's record of one subscriber on one stream, holding what the system needs to build that subscriber's notifications, and where to push them
  - A subscription records:
    - its **floor**: the system must never include an entry at or below it in a notification to that subscriber
      - The coordinator's floor starts at 0
      - Whenever a boundary names a participant on its roster and the boundary before it did not, the participant's floor is raised to the sequence number before that boundary, if that sequence number is above the floor
      - An acknowledgement of a sequence above the floor raises the floor to that sequence
    - the callback address, if any
  - A subscriber holds exactly one subscription per stream
  - The system automatically creates a subscription for:
    - the coordinator at the same time as creating the stream
    - a participant, the first time a roster on that stream names it
    - an incoming coordinator that holds no subscription on the stream, when it replaces the coordinator
  - A subscription must be removed only by purging the stream
- A subscriber's **horizon** is the latest entry the system is allowed to include in a notification to that subscriber
  - For the coordinator, it is the latest entry
  - For a participant:
    - on a live stream:
      - if the participant is on the current round's roster: the boundary that opened the current round
      - if the participant is not on the current round's roster: the boundary that ended the last round whose roster included the participant
    - on a terminated stream:
      - if the participant was on the final round's roster: the termination entry
      - if the participant was not on the final round's roster: the boundary that ended the last round whose roster included the participant
- A **notification** is a message to one subscriber. It contains every entry above the subscriber's floor and at or below its horizon, as both stand when the notification is built, in ascending sequence number order. It is allowed to contain no entries
- A **dispatch** is the system notifying one subscriber through its channel, in response to a trigger; it can take several **attempts**, each carrying a notification built at that moment from the subscription as it stands then. Notifications are not stored
- Notifications can overlap, and can arrive out of order
- How a dispatch proceeds depends on the channel:
  - over a connection, it is a single attempt, made at once
  - to a callback:
    - the first attempt waits for the earlier of two timers to run out:
      - the **debounce interval**, which restarts at each new trigger for that subscriber
      - the **debounce limit**, which is measured from the trigger that started the dispatch and never restarts
    - a failed attempt is retried after a delay that grows with each attempt, to a limit; after a set number of failed attempts the dispatch ends
    - a newer trigger replaces the dispatch; the replacement restarts the debounce interval and has its full number of attempts. The replacement's debounce limit depends on the replaced dispatch:
      - if the replaced dispatch had made no attempt, the replacement keeps the replaced dispatch's debounce limit
      - if the replaced dispatch had made an attempt, the replacement's debounce limit is measured from the newer trigger
- An implementation must also support two forms of polling:
  - **read**: anyone can read entries by sequence number, regardless of horizon
  - **pull**: a subscriber can request the notification a push would carry at that moment, returned in the response. A pull affects no dispatch
