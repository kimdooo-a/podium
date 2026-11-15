// SPDX-License-Identifier: MIT
// The contest rules, mirrored one to one from template/src/rules.rs. Amounts are BigInt µT.

export const TOTAL_BPS = 10_000;
export const MAX_PLACES = 8;
export const MAX_JUDGES = 9;
export const MAX_ENTRIES = 64;

/** Throws with the template's own message when a prize split is not valid. */
export function checkShares(bps) {
  if (bps.length === 0) throw new Error("at least one place is needed");
  if (bps.length > MAX_PLACES) throw new Error("at most 8 places");
  let total = 0;
  bps.forEach((share, i) => {
    if (!Number.isInteger(share) || share <= 0) throw new Error("every place must be more than zero");
    if (i > 0 && share > bps[i - 1]) throw new Error("a lower place cannot pay more than a higher one");
    total += share;
  });
  if (total !== TOTAL_BPS) throw new Error("places must add up to 10000 bps");
}

export function ballotLen(places, liveEntries) {
  return Math.min(places, liveEntries);
}

export function checkBallot(ranking, live, places) {
  if (ranking.length !== ballotLen(places, live.length)) {
    throw new Error("a ballot must rank one entry for every paid place");
  }
  ranking.forEach((id, i) => {
    if (!live.includes(id)) throw new Error("a ballot names an entry that is not in the contest");
    if (ranking.indexOf(id) !== i) throw new Error("a ballot names an entry twice");
  });
}

/** Entries that placed, best first: points, then first places, then the earlier entry. */
export function tally(ballots, live, places) {
  const rows = live.map((id) => ({ id, points: 0, firsts: 0 }));
  for (const ballot of ballots) {
    ballot.forEach((id, pos) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.points += ballot.length - pos;
      if (pos === 0) row.firsts += 1;
    });
  }
  return rows
    .filter((r) => r.points > 0)
    .sort((a, b) => b.points - a.points || b.firsts - a.firsts || a.id - b.id)
    .slice(0, places)
    .map((r) => r.id);
}

/** Cuts `balance` between `winners` placed entries: { amounts, left }. Always adds up. */
export function split(balance, bps, winners) {
  const n = Math.min(winners, bps.length);
  const amounts = bps.slice(0, n).map((share) => (balance * BigInt(share)) / BigInt(TOTAL_BPS));
  const left = balance - amounts.reduce((a, b) => a + b, 0n);
  if (n === bps.length && n > 0) {
    amounts[0] += left;
    return { amounts, left: 0n };
  }
  return { amounts, left };
}

export function splitEvenly(balance, entries) {
  if (entries === 0) return [];
  const each = balance / BigInt(entries);
  const amounts = Array(entries).fill(each);
  amounts[0] += balance - each * BigInt(entries);
  return amounts;
}

/** The bytes a judge commits to: the ranking as big-endian u32s. */
export function rankingBytes(ranking) {
  const out = new Uint8Array(ranking.length * 4);
  const view = new DataView(out.buffer);
  ranking.forEach((id, i) => view.setUint32(i * 4, id, false));
  return out;
}

/** 1 TARI = 1,000,000 µT. */
export function formatTari(ut) {
  const whole = ut / 1_000_000n;
  const frac = (ut % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

export function parseTari(text) {
  const m = text.trim().replace(/,/g, "").match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error("enter an amount like 5 or 0.25");
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}
