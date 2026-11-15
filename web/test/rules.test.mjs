// SPDX-License-Identifier: MIT
// The same cases as template/src/rules.rs, so the page and the template cannot drift apart.
import test from "node:test";
import assert from "node:assert/strict";
import { checkShares, checkBallot, tally, split, splitEvenly, rankingBytes, formatTari, parseTari } from "../src/rules.js";

test("shares must be a falling split of the whole pool", () => {
  checkShares([5714, 2857, 1429]);
  checkShares([10_000]);
  assert.throws(() => checkShares([]), /at least one place is needed/);
  assert.throws(() => checkShares([5000, 0, 5000]), /every place must be more than zero/);
  assert.throws(() => checkShares([4000, 6000]), /a lower place cannot pay more than a higher one/);
  assert.throws(() => checkShares([5000, 4000]), /places must add up to 10000 bps/);
  assert.throws(() => checkShares(Array(9).fill(1250)), /at most 8 places/);
});

test("a ballot ranks each paid place once", () => {
  const live = [0, 1, 2, 4];
  checkBallot([4, 0, 1], live, 3);
  assert.throws(() => checkBallot([4, 0], live, 3), /one entry for every paid place/);
  assert.throws(() => checkBallot([4, 4, 1], live, 3), /names an entry twice/);
  assert.throws(() => checkBallot([4, 3, 1], live, 3), /not in the contest/);
  checkBallot([1, 0], [0, 1], 3);
});

test("points, then first places, then the earlier entry", () => {
  const live = [0, 1, 2, 3];
  assert.deepEqual(tally([[2, 0, 1], [2, 1, 0], [0, 3, 2]], live, 3), [2, 0, 1]);
  assert.deepEqual(tally([[0, 1, 2], [1, 0, 2]], live, 3), [0, 1, 2]);
  assert.equal(tally([[1, 0, 2], [1, 0, 3], [2, 0, 3]], live, 3)[0], 1);
});

test("an entry nobody ranked does not place", () => {
  assert.deepEqual(tally([[1, 0], [1, 0]], [0, 1], 3), [1, 0]);
  assert.deepEqual(tally([], [0, 1], 3), []);
});

test("the split always adds up", () => {
  const pool = 1_750_000_000_000n;
  const r = split(pool, [5714, 2857, 1429], 3);
  assert.deepEqual(r, { amounts: [999_950_000_000n, 499_975_000_000n, 250_075_000_000n], left: 0n });
  assert.equal(r.amounts.reduce((a, b) => a + b, 0n) + r.left, pool);
  assert.deepEqual(split(1_000_001n, [3334, 3333, 3333], 3), { amounts: [333_401n, 333_300n, 333_300n], left: 0n });
  assert.deepEqual(split(1_000_000n, [5000, 3000, 2000], 2), { amounts: [500_000n, 300_000n], left: 200_000n });
  assert.deepEqual(split(777n, [5000, 5000], 0), { amounts: [], left: 777n });
});

test("the split adds up for every balance and winner count tried", () => {
  const splits = [[10_000], [6000, 4000], [5714, 2857, 1429], [3334, 3333, 3333], Array(8).fill(1250)];
  let seed = 20261112;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < 5000; i++) {
    const bps = splits[next() % splits.length];
    const balance = BigInt(next()) * BigInt(next() % 1000) + BigInt(next() % 7);
    const winners = next() % (bps.length + 1);
    const { amounts, left } = split(balance, bps, winners);
    assert.equal(amounts.reduce((a, b) => a + b, 0n) + left, balance);
    assert.equal(amounts.length, winners);
    for (let k = 1; k < amounts.length; k++) assert.ok(amounts[k] <= amounts[k - 1]);
    const even = splitEvenly(balance, winners);
    assert.equal(even.reduce((a, b) => a + b, 0n), winners ? balance : 0n);
  }
});

test("the even split gives the dust to the earliest entry", () => {
  assert.deepEqual(splitEvenly(10n, 3), [4n, 3n, 3n]);
  assert.deepEqual(splitEvenly(9n, 3), [3n, 3n, 3n]);
  assert.deepEqual(splitEvenly(5n, 0), []);
});

test("ranking bytes are big-endian u32s", () => {
  assert.deepEqual([...rankingBytes([2, 0, 258])], [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 2]);
});

test("TARI amounts round-trip", () => {
  assert.equal(formatTari(1_750_000_000_000n), "1,750,000");
  assert.equal(formatTari(1_001_001n), "1.001001");
  assert.equal(parseTari("1,000,000"), 1_000_000_000_000n);
  assert.equal(parseTari("0.25"), 250_000n);
  assert.throws(() => parseTari("1.0000001"));
});
