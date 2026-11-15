// SPDX-License-Identifier: MIT
// Walk-through of one contest, start to finish, on the in-page pool. Every button is one call
// the PrizePool template has; the caption under it names that call.
import { PrizePool, STATUS, STATUS_LABEL, ballotCommitment, randomSalt } from "./pool.js";
import { formatTari, parseTari } from "./rules.js";

const key = (n) => n.toString(16).padStart(64, "0");
const people = {
  organizer: { name: "Organizer", key: key(1), account: "organizer" },
  judges: ["Ana", "Bo", "Chen"].map((name, i) => ({ name, key: key(10 + i) })),
  entrants: ["Lantern", "Tide", "Quill", "Ember"].map((name, i) => ({ name, key: key(100 + i), account: name })),
};
const PLACES = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

const state = { epoch: 0, pool: null, paid: new Map(), sealed: new Map(), log: [], error: "" };
const app = document.getElementById("app");
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") node.addEventListener("click", v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
};

async function act(call, description, fn) {
  state.error = "";
  try {
    await fn();
    state.log.unshift({ epoch: state.epoch, call, description });
  } catch (err) {
    state.error = `${call} was rejected: ${err.message}`;
  }
  render();
}

function openContest(form) {
  const data = new FormData(form);
  const shares = String(data.get("shares")).split(/[\s,]+/).filter(Boolean).map(Number);
  return act("new + fund", "The organizer opened the contest and locked the prize.", () => {
    state.paid = new Map();
    state.sealed = new Map();
    state.epoch = 0;
    const pool = new PrizePool(
      people.organizer.key,
      state.epoch,
      {
        title: String(data.get("title")),
        rulesUrl: "",
        refundTo: people.organizer.account,
        sharesBps: shares,
        judges: people.judges.map((j) => j.key),
        quorum: Number(data.get("quorum")),
        entriesClose: 3,
        revealOpen: 5,
        judgingClose: 7,
        shareIfUnjudged: data.get("fallback") === "share",
      },
      (account, amount) => state.paid.set(account, (state.paid.get(account) ?? 0n) + amount),
    );
    pool.fund(state.epoch, parseTari(String(data.get("prize"))));
    state.pool = pool;
  });
}

function setupView() {
  const form = el("form", { class: "card" });
  form.innerHTML = `
    <h2>Open a contest</h2>
    <label>Title <input name="title" value="November build contest" maxlength="80" required></label>
    <label>Prize (TARI) <input name="prize" value="1,750,000" inputmode="decimal" required></label>
    <label>Places, in basis points (10,000 = the whole prize) <input name="shares" value="5714, 2857, 1429" required></label>
    <label>Ballots needed (of 3 judges) <input name="quorum" type="number" min="1" max="3" value="2" required></label>
    <fieldset><legend>If the judges do not reach that number</legend>
      <label><input type="radio" name="fallback" value="share" checked> share the prize between the entries</label>
      <label><input type="radio" name="fallback" value="refund"> refund the organizer</label>
    </fieldset>
    <button type="submit">Lock the prize and open</button>
    <p class="call">new(…) then fund(prize)</p>`;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    openContest(form);
  });
  return form;
}

function proofCard(pool) {
  const phase = pool.phase(state.epoch);
  const rows = [
    ["Prize locked", `${formatTari(pool.vault)} TARI`],
    ["Places", pool.sharesBps.map((bps, i) => `${PLACES[i]} ${bps / 100}%`).join(" · ")],
    ["Judges", `${pool.seats.length}, ${pool.quorum} ballots needed`],
    ["Without enough ballots", pool.shareIfUnjudged ? "the entries share the prize" : "the organizer is refunded"],
    ["Epochs", `entries close at ${pool.entriesClose}, ballots open at ${pool.revealOpen}, judging closes at ${pool.judgingClose}`],
    ["Now", `epoch ${state.epoch} · ${pool.status === STATUS.OPEN ? phase : STATUS_LABEL[pool.status]}`],
  ];
  const dl = el("dl");
  for (const [k, v] of rows) dl.append(el("dt", {}, k), el("dd", {}, v));
  return el("section", { class: "card proof" }, el("h2", {}, pool.title), dl);
}

function entriesCard(pool) {
  const phase = pool.phase(state.epoch);
  const list = el("ol", { start: "0" });
  pool.entries.forEach((entry, id) => {
    const who = people.entrants.find((p) => p.key === entry.owner);
    const owed = pool.payouts.find((p) => p.entry === id);
    const place = owed ? pool.payouts.indexOf(owed) : -1;
    const item = el("li", entry.withdrawn ? { class: "gone" } : {}, `${who.name} — ${entry.link}`);
    if (owed) {
      const label = pool.status === STATUS.JUDGED ? `${PLACES[place]}: ` : "";
      item.append(el("strong", {}, ` ${label}${formatTari(owed.amount)} TARI ${owed.paid ? "paid" : "owed"}`));
      if (!owed.paid) {
        item.append(el("button", { onclick: () => act(`pay(${id})`, `${who.name} was paid.`, () => pool.pay(id)) }, "Pay"));
      }
    }
    list.append(item);
  });
  const card = el("section", { class: "card" }, el("h2", {}, "Entries"), list);
  if (phase === "entries") {
    for (const p of people.entrants) {
      if (pool.entries.some((e) => e.owner === p.key && !e.withdrawn)) continue;
      card.append(
        el("button", {
          onclick: () =>
            act("enter(link, payout)", `${p.name} entered.`, () =>
              pool.enter(p.key, state.epoch, `https://example.org/${p.name.toLowerCase()}`, p.account)),
        }, `Enter as ${p.name}`),
      );
    }
    card.append(el("p", { class: "call" }, "enter(link, payout account)"));
  }
  return card;
}

function judgingCard(pool) {
  const phase = pool.phase(state.epoch);
  const live = pool.liveIds();
  const need = Math.min(pool.sharesBps.length, live.length);
  const card = el("section", { class: "card" }, el("h2", {}, "Judges"));
  pool.seats.forEach((seat, i) => {
    const judge = people.judges[i];
    const status = seat.ranking ? `opened: ${seat.ranking.join(" › ")}` : seat.commitment ? "sealed ballot committed" : "no ballot yet";
    const row = el("div", { class: "judge" }, el("span", {}, `${judge.name}: ${status}`));
    if (phase === "judging" && need > 0) {
      const input = el("input", { value: [...live].sort(() => Math.random() - 0.5).slice(0, need).join(", "), "aria-label": `${judge.name}'s ranking, best first` });
      row.append(input, el("button", {
        onclick: () =>
          act("commit_ballot(commitment)", `${judge.name} committed a sealed ranking.`, async () => {
            const ranking = input.value.split(/[\s,]+/).filter(Boolean).map(Number);
            const salt = randomSalt();
            pool.commitBallot(judge.key, state.epoch, await ballotCommitment(judge.key, ranking, salt));
            state.sealed.set(judge.key, { ranking, salt });
          }),
      }, "Seal"));
    }
    if (phase === "reveal" && seat.commitment && !seat.ranking) {
      row.append(el("button", {
        onclick: () =>
          act("reveal_ballot(ranking, salt)", `${judge.name} opened the ballot.`, () => {
            const { ranking, salt } = state.sealed.get(judge.key);
            return pool.revealBallot(judge.key, state.epoch, ranking, salt);
          }),
      }, "Open"));
    }
    card.append(row);
  });
  if (phase === "judging") card.append(el("p", { class: "call" }, `Rank ${need} entry numbers, best first. Only a hash goes on the record until epoch ${pool.revealOpen}.`));
  if (pool.status === STATUS.OPEN) {
    card.append(el("button", { onclick: () => act("settle()", "The result was fixed.", () => pool.settle(state.epoch)) }, "Settle"));
    card.append(el("p", { class: "call" }, "settle() — anyone can call it once judging has closed, or once every judge has opened a ballot"));
  } else if (pool.organizerOwed > 0n) {
    card.append(el("button", {
      onclick: () => act("pay_organizer()", "The organizer's part was sent back.", () => pool.payOrganizer()),
    }, `Send ${formatTari(pool.organizerOwed)} TARI back to the organizer`));
  }
  return card;
}

function render() {
  app.replaceChildren();
  if (state.error) app.append(el("p", { class: "error", role: "alert" }, state.error));
  if (!state.pool) {
    app.append(setupView());
    return;
  }
  const pool = state.pool;
  const clock = el("div", { class: "clock" },
    el("button", { onclick: () => { state.epoch += 1; state.error = ""; render(); } }, "Next epoch"),
    el("button", { class: "quiet", onclick: () => { state.pool = null; state.log = []; state.error = ""; render(); } }, "Start over"));
  const log = el("ol", { class: "log", reversed: "" });
  for (const row of state.log) log.append(el("li", {}, `epoch ${row.epoch} · ${row.call} — ${row.description}`));
  app.append(proofCard(pool), clock, entriesCard(pool), judgingCard(pool), el("section", { class: "card" }, el("h2", {}, "What happened"), log));
}

render();
