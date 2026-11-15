# Podium

Podium is a prize pool for contests, built as a template on [Tari Ootle](https://ootle.tari.com/).
The organizer locks the prize and writes the rules down before anyone enters. Entrants register on
the pool, judges rank them in sealed ballots, and the pool pays every place by the rules it was
opened with.

> Status: work in progress. The template compiles to WASM and the rules are tested; it has not
> been published to a network yet.

## What a pool fixes before the first entry

- how the prize is cut between the places, in basis points (10,000 = the whole prize)
- who the judges are and how many of them must vote for the judging to count
- three deadlines, in epochs: entries close, ballots open, judging closes
- what happens if the judges do not reach that number: the entries share the prize, or the organizer is refunded

Once somebody is entered, the organizer has no method that moves the prize. It leaves the pool
only through `settle`, by those rules.

## How a contest runs

| Step | Who | Call |
|---|---|---|
| Open the contest | organizer | `new(title, rules_url, refund_to, shares_bps, judges, quorum, entries_close, reveal_open, judging_close, share_if_unjudged)` |
| Add to the prize | anyone | `fund(bucket)` |
| Enter, edit, withdraw | entrant | `enter(link, payout)`, `update_entry(link)`, `withdraw_entry()` |
| Commit a sealed ranking | judge | `commit_ballot(commitment)` |
| Open the ranking | judge | `reveal_ballot(ranking, salt)` |
| Fix the result | anyone | `settle()` |
| Pay a place | anyone | `pay(entry)`, `pay_organizer()` |

A ballot ranks one entry for every paid place. First on a ballot of three is worth 3 points, second
2, third 1. Ties go to the entry with more first places, then to the one that entered earlier. Every
share rounds down and the dust goes to first place. A place nobody won goes back to the organizer.

A commitment is `SHA-256("podium.ballot.v1" ‖ judge key ‖ ranking as big-endian u32s ‖ salt)`.

## What is public

The prize, every entry's link and payout account, the judges' keys and, once opened, their
rankings are public. Deposits into a component vault are public on Ootle. A ranking is hidden until
the reveal epoch. A judge who committed can still decline to open a ballot; that ballot does not count.

## Layout

| Path | What |
|---|---|
| [`template/`](template/) | the `PrizePool` template (Rust, compiled to WASM), its rule tests and engine tests |
| [`web/`](web/) | the static page and an in-page pool with the template's methods, checks and messages |

## Build and test

```bash
rustup target add wasm32-unknown-unknown
cd template
cargo test                                               # rule tests; engine tests on Linux and macOS
cargo build --release --target wasm32-unknown-unknown    # podium_pool.wasm

cd ../web
node --test test/                                        # the page's rules and pool
```

The engine tests use `tari_template_test_tooling`, which runs the template in the engine the
network uses. That engine does not build on Windows, so on Windows `cargo test` runs the rule tests
only and the engine tests run in CI.

The page has no dependencies and no build step: serve `web/` with any static file server.

## License

[MIT](LICENSE)
