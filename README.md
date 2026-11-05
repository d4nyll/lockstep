# Lockstep

Lockstep is a specification for a server that coordinates participants working on a task together. The work proceeds in rounds. A participant appends its work during a round, and the other participants see it only once the coordinator ends the round.

## Specification

Read the documents in this order:

1. [`specs/00_mental-model.md`](specs/00_mental-model.md): the concepts, without the full rules
2. [`specs/01_base-specification.md`](specs/01_base-specification.md): the schemas, rules, and operations an implementation follows
3. [`specs/02_walkthroughs.md`](specs/02_walkthroughs.md): sequence diagrams of the operations in use

## Implementing Lockstep

The base specification doesn't name a transport, a wire format, or a technology stack. To implement Lockstep, write an extended specification for your stack that settles each point listed under [Decisions left to the extended specification](specs/01_base-specification.md#decisions-left-to-the-extended-specification), then build your implementation against that extended specification.

## License

Lockstep is licensed under the [Apache License 2.0](LICENSE).
