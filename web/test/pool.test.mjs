// SPDX-License-Identifier: MIT
// The scenarios of template/tests/pool.rs, run against the in-page pool.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PrizePool, STATUS, ballotCommitment } from "../src/pool.js";

const key = (n) => n.toString(16).padStart(64, "0");
const [ORG, ANN, BEN, E0, E1, E2, STRANGER] = [1, 2, 3, 10, 11, 12, 99].map(key);
const ENTRIES_CLOSE = 10;
const REVEAL_OPEN = 20;
const JUDGING_CLOSE = 30;
const PRIZE = 1_000_001n;

function openPool(shareIfUnjudged = false, overrides = {}) {
  const paid = new Map();
  const pool = new PrizePool(
    ORG,
    0,
    {
      title: "November build",
      rulesUrl: "https://example.org/rules",
      refundTo: "acct-org",
      sharesBps: [3334, 3333, 3333],
      judges: [ANN, BEN],
      quorum: 2,
      entriesClose: ENTRIES_CLOSE,
      revealOpen: REVEAL_OPEN,
      judgingClose: JUDGING_CLOSE,
      shareIfUnjudged,
      ...overrides,
    },
    (account, amount) => paid.set(account, (paid.get(account) ?? 0n) + amount),
  );
  pool.fund(0, PRIZE);
  return { pool, paid };
}

function enterThree(pool) {
  [E0, E1, E2].forEach((e, i) => pool.enter(e, 1, `https://example.org/entry/${i}`, `acct-${i}`));
}

test("the commitment is plain SHA-256 over domain, key, ranking and salt", async () => {
  const expected = createHash("sha256")
    .update("podium.ballot.v1")
    .update(Buffer.from(ANN, "hex"))
    .update(Buffer.from([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1]))
    .update("ann-salt-0123456789")
    .digest("hex");
  assert.equal(await ballotCommitment(ANN, [2, 0, 1], "ann-salt-0123456789"), expected);
});

test("a judged contest pays every place and empties the pool", async () => {
  const { pool, paid } = openPool();
  enterThree(pool);
  const ballots = [
    [ANN, [2, 0, 1], "ann-salt-0123456789"],
    [BEN, [2, 1, 0], "ben-salt-0123456789"],
  ];
  for (const [judge, ranking, salt] of ballots) {
    pool.commitBallot(judge, ENTRIES_CLOSE, await ballotCommitment(judge, ranking, salt));
  }
  for (const [judge, ranking, salt] of ballots) await pool.revealBallot(judge, REVEAL_OPEN, ranking, salt);

  // Every judge has opened a ballot, so settling does not wait for JUDGING_CLOSE.
  assert.equal(pool.settle(REVEAL_OPEN), STATUS.JUDGED);
  assert.deepEqual(pool.payouts.map((p) => p.entry), [2, 0, 1]);
  for (const p of [...pool.payouts]) pool.pay(p.entry);
  assert.deepEqual([paid.get("acct-0"), paid.get("acct-1"), paid.get("acct-2")], [333_300n, 333_300n, 333_401n]);
  assert.equal(pool.vault, 0n);
  assert.equal(pool.payOrganizer(), 0n);
  assert.throws(() => pool.pay(2), /this entry has been paid/);
});

test("settling early is rejected, a stranger is not a judge, and entries lock the prize in", async () => {
  const { pool } = openPool();
  pool.enter(STRANGER, 1, "https://example.org/entry", "acct-s");
  assert.throws(() => pool.settle(1), /judging is still open/);
  assert.throws(() => pool.cancel(ORG), /a contest with entries cannot be cancelled/);
  assert.throws(() => pool.cancel(STRANGER), /only the organizer can cancel/);
  assert.throws(() => pool.commitBallot(STRANGER, ENTRIES_CLOSE, "00".repeat(32)), /this key is not a judge/);
  assert.throws(() => pool.enter(STRANGER, 2, "https://example.org/again", "acct-s"), /already has an entry/);
  assert.throws(() => pool.enter(E0, ENTRIES_CLOSE, "https://example.org/late", "acct-0"), /entries are closed/);
});

test("a ranking that does not match the commitment is rejected", async () => {
  const { pool } = openPool();
  pool.enter(E0, 1, "https://example.org/a", "acct-0");
  pool.enter(E1, 1, "https://example.org/b", "acct-1");
  pool.commitBallot(ANN, ENTRIES_CLOSE, await ballotCommitment(ANN, [0, 1], "ann-salt-0123456789"));
  assert.throws(() => pool.commitBallot(ANN, REVEAL_OPEN, "00".repeat(32)), /commitments are closed/);
  await assert.rejects(pool.revealBallot(ANN, REVEAL_OPEN, [1, 0], "ann-salt-0123456789"), /does not match the commitment/);
  await assert.rejects(pool.revealBallot(ANN, ENTRIES_CLOSE, [0, 1], "ann-salt-0123456789"), /ballots open at the reveal epoch/);
  await assert.rejects(pool.revealBallot(BEN, REVEAL_OPEN, [0, 1], "ben-salt-0123456789"), /no ballot was committed/);
  await pool.revealBallot(ANN, REVEAL_OPEN, [0, 1], "ann-salt-0123456789");
  await assert.rejects(pool.revealBallot(ANN, REVEAL_OPEN, [0, 1], "ann-salt-0123456789"), /already open/);
});

test("without a quorum the written fallback decides", () => {
  const shared = openPool(true);
  enterThree(shared.pool);
  assert.equal(shared.pool.settle(JUDGING_CLOSE), STATUS.SHARED);
  shared.pool.pay(0);
  // 1,000,001 / 3 = 333,333 each, and the earliest entry also gets the 2 µT of dust.
  assert.equal(shared.paid.get("acct-0"), 333_335n);

  const refunded = openPool(false);
  enterThree(refunded.pool);
  assert.equal(refunded.pool.settle(JUDGING_CLOSE), STATUS.REFUNDED);
  assert.equal(refunded.pool.payOrganizer(), PRIZE);
  assert.equal(refunded.paid.get("acct-org"), PRIZE);
  assert.throws(() => refunded.pool.pay(0), /not owed a prize/);
});

test("places nobody won go back to the organizer, and a withdrawn entry cannot be ranked", async () => {
  const { pool, paid } = openPool(false, { judges: [ANN], quorum: 1 });
  enterThree(pool);
  pool.withdrawEntry(E1, 2);
  assert.deepEqual(pool.liveIds(), [0, 2]);
  pool.commitBallot(ANN, ENTRIES_CLOSE, await ballotCommitment(ANN, [2, 0], "ann-salt-0123456789"));
  await assert.rejects(pool.revealBallot(ANN, REVEAL_OPEN, [2, 1], "ann-salt-0123456789"), /not in the contest/);
  await pool.revealBallot(ANN, REVEAL_OPEN, [2, 0], "ann-salt-0123456789");
  pool.settle(REVEAL_OPEN);
  pool.pay(2);
  pool.pay(0);
  assert.equal(paid.get("acct-2"), 333_400n);
  assert.equal(paid.get("acct-0"), 333_300n);
  // Third place (3333 bps) and the 1 µT of dust: 1,000,001 - 333,400 - 333,300.
  assert.equal(pool.payOrganizer(), 333_301n);
  assert.equal(pool.vault, 0n);
});

test("a mistyped payout account can be fixed after settling, until it is paid", async () => {
  const { pool, paid } = openPool(true);
  pool.enter(E0, 1, "https://example.org/a", "acct-typo");
  pool.settle(JUDGING_CLOSE);
  pool.setPayout(E0, "acct-0");
  pool.pay(0);
  assert.equal(paid.get("acct-0"), PRIZE);
  assert.throws(() => pool.setPayout(E0, "acct-other"), /has been paid/);
});

test("the organizer can cancel only while nobody is entered", () => {
  const { pool, paid } = openPool();
  pool.cancel(ORG);
  assert.equal(pool.status, STATUS.REFUNDED);
  pool.payOrganizer();
  assert.equal(paid.get("acct-org"), PRIZE);
  assert.throws(() => pool.fund(1, 1n), /the contest is settled/);
});

test("the rules are checked when the contest is opened", () => {
  assert.throws(() => openPool(false, { quorum: 3 }), /quorum must be 1 to the number of judges/);
  assert.throws(() => openPool(false, { judges: [ANN, ANN] }), /a judge appears twice/);
  assert.throws(() => openPool(false, { revealOpen: ENTRIES_CLOSE }), /at least one epoch to commit/);
  assert.throws(() => openPool(false, { sharesBps: [6000, 3000] }), /add up to 10000 bps/);
  assert.throws(() => openPool(false, { title: "" }), /title must be 1 to 80 bytes/);
});
