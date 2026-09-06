# implementation/

The running record of building the plan in
[`plans/code-intelligence-engine-plan-v2.md`](../plans/code-intelligence-engine-plan-v2.md).

Three files, three different jobs. Keeping them apart is deliberate — the plan
is what was decided, the record is what was built, and the deltas are where
those two disagree. Merging them loses the disagreement, which is the only part
worth reading twice.

| File | Holds | Written when |
|---|---|---|
| [`RECORD.md`](RECORD.md) | One entry per plan task: what shipped, where it lives, how it was verified | At task completion, before the commit |
| [`PLAN-DELTAS.md`](PLAN-DELTAS.md) | Every place the implementation diverges from plan v2, with the evidence that forced it | The moment a divergence is discovered, not at the end |
| [`OPEN-DECISIONS.md`](OPEN-DECISIONS.md) | Live status of the plan's nine OPEN items | When one is answered or its answer changes |

**Rules for this folder**

1. A delta is recorded with the *measurement* that caused it, never with an
   opinion. `docs/measurements.md` holds the number; `PLAN-DELTAS.md` links to it.
2. The plan file itself is not edited. It is the record of what was decided on
   2026-09-06 with the information available then. Rewriting it to match reality
   destroys the evidence that the reality was different.
3. Nothing in here is auto-loaded into an agent session (see `CLAUDE.md`).
