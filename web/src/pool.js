// SPDX-License-Identifier: MIT
// A prize pool that runs in the page: the same methods, checks and messages as the PrizePool
// template in template/src/lib.rs. The demo uses it so a contest can be walked through without a
// wallet, and the tests use it to pin down behaviour the template must match.
import * as rules from "./rules.js";

export const STATUS = { OPEN: 0, JUDGED: 1, SHARED: 2, REFUNDED: 3 };
export const STATUS_LABEL = ["Open", "Judged", "Shared between the entries", "Refunded"];
const BALLOT_DOMAIN = new TextEncoder().encode("podium.ballot.v1");
const MAX_TITLE_BYTES = 80;
const MAX_LINK_BYTES = 200;
const bytes = (text) => new TextEncoder().encode(text);
const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const bytesToHex = (arr) => [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");

function need(condition, message) {
  if (!condition) throw new Error(message);
}

/** SHA-256(domain ‖ judge key ‖ ranking as big-endian u32s ‖ salt), as hex. */
export async function ballotCommitment(judgeKeyHex, ranking, salt) {
  const parts = [BALLOT_DOMAIN, hexToBytes(judgeKeyHex), rules.rankingBytes(ranking), bytes(salt)];
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.length;
  }
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export function randomSalt() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export class PrizePool {
  /**
   * `signer` is the organizer's key (hex). `now` is the current epoch. `deposit(account, amount)`
   * is called for every payment the pool makes.
   */
  constructor(signer, now, cfg, deposit = () => {}) {
    need(bytes(cfg.title).length >= 1 && bytes(cfg.title).length <= MAX_TITLE_BYTES, "title must be 1 to 80 bytes");
    need(bytes(cfg.rulesUrl ?? "").length <= MAX_LINK_BYTES, "rules link must be at most 200 bytes");
    rules.checkShares(cfg.sharesBps);
    need(cfg.judges.length >= 1, "at least one judge is needed");
    need(cfg.judges.length <= rules.MAX_JUDGES, "at most 9 judges");
    need(new Set(cfg.judges).size === cfg.judges.length, "a judge appears twice");
    need(cfg.quorum >= 1 && cfg.quorum <= cfg.judges.length, "quorum must be 1 to the number of judges");
    need(cfg.entriesClose > now, "entries must close in a later epoch");
    need(cfg.revealOpen > cfg.entriesClose, "judges need at least one epoch to commit");
    need(cfg.judgingClose > cfg.revealOpen, "judges need at least one epoch to open their ballots");

    this.title = cfg.title;
    this.rulesUrl = cfg.rulesUrl ?? "";
    this.organizer = signer;
    this.refundTo = cfg.refundTo;
    this.sharesBps = [...cfg.sharesBps];
    this.seats = cfg.judges.map((judge) => ({ judge, commitment: null, ranking: null }));
    this.quorum = cfg.quorum;
    this.entriesClose = cfg.entriesClose;
    this.revealOpen = cfg.revealOpen;
    this.judgingClose = cfg.judgingClose;
    this.shareIfUnjudged = Boolean(cfg.shareIfUnjudged);
    this.vault = 0n;
    this.entries = [];
    this.status = STATUS.OPEN;
    this.payouts = [];
    this.organizerOwed = 0n;
    this.totalFunded = 0n;
    this.deposit = deposit;
  }

  fund(now, amount) {
    this.#assertOpen();
    need(now < this.judgingClose, "the contest is over");
    need(amount > 0n, "add more than zero");
    this.vault += amount;
    this.totalFunded += amount;
  }

  enter(signer, now, link, payout) {
    this.#assertOpen();
    need(now < this.entriesClose, "entries are closed");
    need(bytes(link).length >= 1 && bytes(link).length <= MAX_LINK_BYTES, "link must be 1 to 200 bytes");
    need(this.#liveEntryOf(signer) === -1, "this key already has an entry");
    need(this.entries.length < rules.MAX_ENTRIES, "the contest is full");
    this.entries.push({ owner: signer, payout, link, enteredEpoch: now, withdrawn: false });
    return this.entries.length - 1;
  }

  updateEntry(signer, now, link) {
    this.#assertOpen();
    need(now < this.entriesClose, "entries are closed");
    need(bytes(link).length >= 1 && bytes(link).length <= MAX_LINK_BYTES, "link must be 1 to 200 bytes");
    this.entries[this.#signerEntry(signer)].link = link;
  }

  setPayout(signer, payout) {
    const id = this.#signerEntry(signer);
    const row = this.payouts.find((p) => p.entry === id);
    need(!row?.paid, "this entry has been paid");
    this.entries[id].payout = payout;
  }

  withdrawEntry(signer, now) {
    this.#assertOpen();
    need(now < this.entriesClose, "entries are closed");
    this.entries[this.#signerEntry(signer)].withdrawn = true;
  }

  commitBallot(signer, now, commitmentHex) {
    this.#assertOpen();
    need(now >= this.entriesClose, "entries are still open");
    need(now < this.revealOpen, "commitments are closed");
    this.seats[this.#signerSeat(signer)].commitment = commitmentHex;
  }

  async revealBallot(signer, now, ranking, salt) {
    this.#assertOpen();
    need(now >= this.revealOpen, "ballots open at the reveal epoch");
    need(now < this.judgingClose, "judging is closed");
    need(bytes(salt).length >= 16 && bytes(salt).length <= 64, "salt must be 16 to 64 bytes");
    const seat = this.seats[this.#signerSeat(signer)];
    need(seat.ranking === null, "this ballot is already open");
    need(seat.commitment !== null, "no ballot was committed");
    rules.checkBallot(ranking, this.liveIds(), this.sharesBps.length);
    need((await ballotCommitment(seat.judge, ranking, salt)) === seat.commitment, "the ranking does not match the commitment");
    seat.ranking = [...ranking];
  }

  settle(now) {
    this.#assertOpen();
    const opened = this.seats.filter((s) => s.ranking).map((s) => s.ranking);
    const everyoneOpened = now >= this.revealOpen && opened.length === this.seats.length;
    need(now >= this.judgingClose || everyoneOpened, "judging is still open");

    const live = this.liveIds();
    if (live.length > 0 && opened.length >= this.quorum) {
      const winners = rules.tally(opened, live, this.sharesBps.length);
      const { amounts, left } = rules.split(this.vault, this.sharesBps, winners.length);
      this.payouts = winners.map((entry, i) => ({ entry, amount: amounts[i], paid: false }));
      this.organizerOwed = left;
      this.status = STATUS.JUDGED;
    } else if (live.length > 0 && this.shareIfUnjudged) {
      const amounts = rules.splitEvenly(this.vault, live.length);
      this.payouts = live.map((entry, i) => ({ entry, amount: amounts[i], paid: false }));
      this.status = STATUS.SHARED;
    } else {
      this.organizerOwed = this.vault;
      this.status = STATUS.REFUNDED;
    }
    return this.status;
  }

  pay(entry) {
    need(this.status !== STATUS.OPEN, "the contest is not settled");
    const row = this.payouts.find((p) => p.entry === entry);
    need(row, "this entry is not owed a prize");
    need(!row.paid, "this entry has been paid");
    row.paid = true;
    if (row.amount > 0n) {
      this.vault -= row.amount;
      this.deposit(this.entries[entry].payout, row.amount);
    }
    return row.amount;
  }

  payOrganizer() {
    need(this.status !== STATUS.OPEN, "the contest is not settled");
    const amount = this.organizerOwed;
    this.organizerOwed = 0n;
    if (amount > 0n) {
      this.vault -= amount;
      this.deposit(this.refundTo, amount);
    }
    return amount;
  }

  cancel(signer) {
    this.#assertOpen();
    need(signer === this.organizer, "only the organizer can cancel");
    need(this.liveIds().length === 0, "a contest with entries cannot be cancelled");
    this.organizerOwed = this.vault;
    this.status = STATUS.REFUNDED;
  }

  liveIds() {
    return this.entries.flatMap((e, i) => (e.withdrawn ? [] : [i]));
  }

  /** Where the contest stands at epoch `now`, in words the page can show. */
  phase(now) {
    if (this.status !== STATUS.OPEN) return "settled";
    if (now < this.entriesClose) return "entries";
    if (now < this.revealOpen) return "judging";
    if (now < this.judgingClose) return "reveal";
    return "ready to settle";
  }

  #assertOpen() {
    need(this.status === STATUS.OPEN, "the contest is settled");
  }

  #liveEntryOf(owner) {
    return this.entries.findIndex((e) => !e.withdrawn && e.owner === owner);
  }

  #signerEntry(signer) {
    const id = this.#liveEntryOf(signer);
    need(id !== -1, "this key has no entry");
    return id;
  }

  #signerSeat(signer) {
    const seat = this.seats.findIndex((s) => s.judge === signer);
    need(seat !== -1, "this key is not a judge");
    return seat;
  }
}
