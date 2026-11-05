# Lockstep demo

This branch holds an interactive demo of Lockstep, served by GitHub Pages. The specification is on the [`main` branch](https://github.com/d4nyll/lockstep/tree/main).

Lockstep is a specification for a server that coordinates participants working on a task together. The work proceeds in rounds. A participant appends its work during a round, and the other participants see it only once the coordinator ends the round.

## Run the demo

Open `index.html` in a browser. It needs no build step and no server.

The page runs the server on a virtual clock, so you decide when time passes. It has:

- a tour in 6 chapters, which covers rounds, callbacks and debouncing, retries, connections and restarts, coordinator replacement, and purging
- a card per actor, with a button for every operation that actor can call
- controls for how each connection and callback endpoint behaves, e.g. a write that takes 500 ms, or an endpoint that doesn't respond
- a request console that sends any operation with a JSON body, including malformed ones
- a settings panel for every `LOCKSTEP_*` setting

To check the demo's server against the walkthroughs, run:

```sh
node lockstep.test.js
```

## The demo's extended specification

The base specification leaves these decisions to an extended specification. The demo decides them as follows:

- Transport: each call is a JavaScript function call, and a request is an object whose fields have the names the base specification gives them
- `subscriber_id`: a field of the request object. Every string is a valid `subscriber_id`
- Strings: JavaScript strings. Two strings are equal if `===` holds, and they order by UTF-16 code unit
- `payload`: a string. The demo has no null payload
- `timestamp`: an ISO 8601 string in UTC
- `duration`: a whole number of milliseconds, from 0 to 10^12, so adding one to a `timestamp` can't leave the range of a JavaScript `Date`
- `unsigned int`: a whole number from 0 to the value of the `UINT_MAX` setting (default 2^32 - 1)
- `callback_address`: a string starting with `https://`. Any other string is refused with `invalid_callback_address`
- A request carrying a field the operation doesn't name is refused with `invalid_request`
- An `Error` is a thrown `LockstepError` carrying `code`, `message`, and `data`
- A `BoundaryPayload` is an object with a `roster` field
- An attempt to a `callback_address` succeeds or fails as the page's endpoint controls say. An endpoint that doesn't respond, or responds after `LOCKSTEP_RESPONSE_TIMEOUT`, counts as failed
- A connection opens with `Connect` and closes when its subscriber closes it or the server closes it. Both sides detect a close at once. A write into a connection succeeds or fails as the page's connection controls say
- Each connection serves one stream, and no transport connection is shared
- A live stream whose coordinator stops responding stays live
- The demo sets no maximum size on any field
- The server supports connections and callback addresses. The `SUPPORTS_CONNECTIONS` and `SUPPORTS_CALLBACKS` settings turn each one off

## License

Lockstep is licensed under the [Apache License 2.0](LICENSE).
