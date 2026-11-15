// SPDX-License-Identifier: MIT
//! Podium prize pool.
//!
//! One pool is one contest. The organizer writes the rules down once, before anyone enters: how
//! the prize is cut between the places, who the judges are, how many of them must vote, the three
//! deadlines, and what happens to the prize if the judges never show up. Anyone can add TARI to
//! the prize. Entrants register an entry and the account it should be paid to. Judges commit to a
//! sealed ranking, then open it. `settle` adds the rankings up and fixes what every place is
//! owed; `pay` hands it over. After the first entry there is no method that sends the prize
//! anywhere the rules did not name.
//!
//! What is public: the prize, every entry's link and payout account, the judges' keys and, once
//! opened, their rankings. What is not: a ranking before the reveal epoch.

use tari_template_lib::prelude::*;

pub mod rules;

#[template]
mod prize_pool {
    use super::*;
    use crate::rules;

    pub const MAX_TITLE_BYTES: usize = 80;
    pub const MAX_LINK_BYTES: usize = 200;
    pub const MIN_SALT_BYTES: usize = 16;
    pub const MAX_SALT_BYTES: usize = 64;
    /// Domain tag hashed in front of every ballot commitment.
    pub const BALLOT_DOMAIN: &[u8] = b"podium.ballot.v1";

    /// Entries, sponsors and ballots are still coming in.
    pub const STATUS_OPEN: u8 = 0;
    /// The judges reached a quorum and the places were paid by their ranking.
    pub const STATUS_JUDGED: u8 = 1;
    /// No quorum: the prize was shared evenly between the entries.
    pub const STATUS_SHARED: u8 = 2;
    /// No quorum or no entries: the prize went back to the organizer.
    pub const STATUS_REFUNDED: u8 = 3;

    pub struct PrizePool {
        title: String,
        /// Where the full rules are written (a forum thread, a page).
        rules_url: String,
        organizer: RistrettoPublicKeyBytes,
        /// The account that receives places nobody won, or the whole prize on a refund.
        refund_to: ComponentAddress,
        /// What each place gets, in basis points, first place first.
        shares_bps: Vec<u16>,
        seats: Vec<Seat>,
        /// How many opened ballots make the judging count.
        quorum: u32,
        /// Entries are accepted while the epoch is below this.
        entries_close: u64,
        /// Judges commit from `entries_close` until this epoch, and open their ballots from it.
        reveal_open: u64,
        /// From this epoch anyone can settle with the ballots that were opened.
        judging_close: u64,
        /// Without a quorum: `true` shares the prize between the entries, `false` refunds it.
        share_if_unjudged: bool,
        vault: Vault,
        entries: Vec<Entry>,
        status: u8,
        /// Filled by `settle`: what each entry is owed, best place first.
        payouts: Vec<Payout>,
        organizer_owed: Amount,
        total_funded: Amount,
    }

    #[derive(Clone, Debug)]
    pub struct Seat {
        pub judge: RistrettoPublicKeyBytes,
        pub commitment: Option<Hash32>,
        pub ranking: Option<Vec<u32>>,
    }

    #[derive(Clone, Debug)]
    pub struct Entry {
        pub owner: RistrettoPublicKeyBytes,
        pub payout: ComponentAddress,
        pub link: String,
        pub entered_epoch: u64,
        pub withdrawn: bool,
    }

    #[derive(Clone, Debug)]
    pub struct Payout {
        pub entry: u32,
        pub amount: Amount,
        pub paid: bool,
    }

    impl PrizePool {
        /// Opens a contest. The signer becomes the organizer.
        ///
        /// `entries_close < reveal_open < judging_close`, all in epochs. `quorum` is between 1
        /// and the number of judges.
        #[allow(clippy::too_many_arguments)]
        pub fn new(
            title: String,
            rules_url: String,
            refund_to: ComponentAddress,
            shares_bps: Vec<u16>,
            judges: Vec<RistrettoPublicKeyBytes>,
            quorum: u32,
            entries_close: u64,
            reveal_open: u64,
            judging_close: u64,
            share_if_unjudged: bool,
        ) -> Component<Self> {
            assert!(!title.is_empty() && title.len() <= MAX_TITLE_BYTES, "title must be 1 to 80 bytes");
            assert!(rules_url.len() <= MAX_LINK_BYTES, "rules link must be at most 200 bytes");
            if let Err(reason) = rules::check_shares(&shares_bps) {
                panic!("{}", reason);
            }
            assert!(!judges.is_empty(), "at least one judge is needed");
            assert!(judges.len() <= rules::MAX_JUDGES, "at most 9 judges");
            for (i, judge) in judges.iter().enumerate() {
                assert!(!judges[..i].contains(judge), "a judge appears twice");
            }
            assert!(quorum >= 1 && quorum as usize <= judges.len(), "quorum must be 1 to the number of judges");
            let now = Consensus::current_epoch();
            assert!(entries_close > now, "entries must close in a later epoch");
            assert!(reveal_open > entries_close, "judges need at least one epoch to commit");
            assert!(judging_close > reveal_open, "judges need at least one epoch to open their ballots");

            let seats = judges
                .into_iter()
                .map(|judge| Seat { judge, commitment: None, ranking: None })
                .collect();

            let access_rules = ComponentAccessRules::new()
                .method("fund", rule![allow_all])
                .method("enter", rule![allow_all])
                .method("update_entry", rule![allow_all])
                .method("set_payout", rule![allow_all])
                .method("withdraw_entry", rule![allow_all])
                .method("commit_ballot", rule![allow_all])
                .method("reveal_ballot", rule![allow_all])
                .method("settle", rule![allow_all])
                .method("pay", rule![allow_all])
                .method("pay_organizer", rule![allow_all])
                .method("cancel", rule![allow_all])
                .method("info", rule![allow_all]);

            Component::new(Self {
                title,
                rules_url,
                organizer: CallerContext::transaction_signer_public_key(),
                refund_to,
                shares_bps,
                seats,
                quorum,
                entries_close,
                reveal_open,
                judging_close,
                share_if_unjudged,
                vault: Vault::new_empty(TARI_TOKEN),
                entries: Vec::new(),
                status: STATUS_OPEN,
                payouts: Vec::new(),
                organizer_owed: Amount::zero(),
                total_funded: Amount::zero(),
            })
            .with_access_rules(access_rules)
            .create()
        }

        /// Adds TARI to the prize. Anyone can: the organizer, a sponsor, a fan.
        pub fn fund(&mut self, prize: Bucket) {
            self.assert_open();
            assert!(Consensus::current_epoch() < self.judging_close, "the contest is over");
            assert!(prize.resource_address() == TARI_TOKEN, "the prize is in TARI");
            let amount = prize.amount();
            assert!(amount.is_positive(), "add more than zero");
            self.vault.deposit(prize);
            self.total_funded = self.total_funded.saturating_add(amount);
            emit_event("Funded", metadata![
                "amount" => amount.to_string(),
                "prize" => self.vault.balance().to_string(),
            ]);
        }

        /// Registers the signer's entry and the account its prize should go to. One live entry
        /// per key. Returns the entry number.
        pub fn enter(&mut self, link: String, payout: ComponentAddress) -> u32 {
            self.assert_open();
            assert!(Consensus::current_epoch() < self.entries_close, "entries are closed");
            assert!(!link.is_empty() && link.len() <= MAX_LINK_BYTES, "link must be 1 to 200 bytes");
            let owner = CallerContext::transaction_signer_public_key();
            assert!(self.live_entry_of(&owner).is_none(), "this key already has an entry");
            assert!(self.entries.len() < rules::MAX_ENTRIES, "the contest is full");

            let id = self.entries.len() as u32;
            self.entries.push(Entry {
                owner,
                payout,
                link: link.clone(),
                entered_epoch: Consensus::current_epoch(),
                withdrawn: false,
            });
            emit_event("Entered", metadata!["entry" => id.to_string(), "link" => link]);
            id
        }

        /// Replaces the link of the signer's entry while entries are open.
        pub fn update_entry(&mut self, link: String) {
            self.assert_open();
            assert!(Consensus::current_epoch() < self.entries_close, "entries are closed");
            assert!(!link.is_empty() && link.len() <= MAX_LINK_BYTES, "link must be 1 to 200 bytes");
            let id = self.signer_entry();
            self.entries[id].link = link.clone();
            emit_event("EntryUpdated", metadata!["entry" => id.to_string(), "link" => link]);
        }

        /// Changes where the signer's entry is paid. Allowed at any time before it is paid, so a
        /// mistyped account can never lock a prize.
        pub fn set_payout(&mut self, payout: ComponentAddress) {
            let id = self.signer_entry();
            if let Some(row) = self.payouts.iter().find(|p| p.entry == id as u32) {
                assert!(!row.paid, "this entry has been paid");
            }
            self.entries[id].payout = payout;
        }

        /// Takes the signer's entry out while entries are open.
        pub fn withdraw_entry(&mut self) {
            self.assert_open();
            assert!(Consensus::current_epoch() < self.entries_close, "entries are closed");
            let id = self.signer_entry();
            self.entries[id].withdrawn = true;
            emit_event("EntryWithdrawn", metadata!["entry" => id.to_string()]);
        }

        /// A judge commits to a sealed ranking: SHA-256 of the domain tag, the judge's key, the
        /// ranking as big-endian u32s and a salt. Can be replaced until the reveal epoch.
        pub fn commit_ballot(&mut self, commitment: Hash32) {
            self.assert_open();
            let now = Consensus::current_epoch();
            assert!(now >= self.entries_close, "entries are still open");
            assert!(now < self.reveal_open, "commitments are closed");
            let seat = self.signer_seat();
            self.seats[seat].commitment = Some(commitment);
            emit_event("BallotCommitted", metadata!["judge" => seat.to_string()]);
        }

        /// A judge opens the ranking committed to. It must rank one live entry for every paid
        /// place, best first.
        pub fn reveal_ballot(&mut self, ranking: Vec<u32>, salt: String) {
            self.assert_open();
            let now = Consensus::current_epoch();
            assert!(now >= self.reveal_open, "ballots open at the reveal epoch");
            assert!(now < self.judging_close, "judging is closed");
            assert!(
                salt.len() >= MIN_SALT_BYTES && salt.len() <= MAX_SALT_BYTES,
                "salt must be 16 to 64 bytes"
            );
            let seat = self.signer_seat();
            assert!(self.seats[seat].ranking.is_none(), "this ballot is already open");
            let commitment = self.seats[seat].commitment.expect("no ballot was committed");

            let live = self.live_ids();
            if let Err(reason) = rules::check_ballot(&ranking, &live, self.shares_bps.len()) {
                panic!("{}", reason);
            }
            let opened = intrinsics::hash_sha256_parts(&[
                BALLOT_DOMAIN,
                self.seats[seat].judge.as_bytes(),
                &rules::ranking_bytes(&ranking),
                salt.as_bytes(),
            ]);
            assert!(opened == commitment, "the ranking does not match the commitment");

            self.seats[seat].ranking = Some(ranking);
            emit_event("BallotOpened", metadata!["judge" => seat.to_string()]);
        }

        /// Fixes the result. Anyone can call it once judging has closed, or earlier if every
        /// judge has opened a ballot. Returns the status the pool ended in.
        pub fn settle(&mut self) -> u8 {
            self.assert_open();
            let now = Consensus::current_epoch();
            let opened: Vec<Vec<u32>> = self.seats.iter().filter_map(|s| s.ranking.clone()).collect();
            let everyone_opened = now >= self.reveal_open && opened.len() == self.seats.len();
            assert!(now >= self.judging_close || everyone_opened, "judging is still open");

            let live = self.live_ids();
            let balance = self.vault.balance().to_u128();

            if !live.is_empty() && opened.len() as u32 >= self.quorum {
                let winners = rules::tally(&opened, &live, self.shares_bps.len());
                let (amounts, left) = rules::split(balance, &self.shares_bps, winners.len());
                self.payouts = winners
                    .into_iter()
                    .zip(amounts)
                    .map(|(entry, amount)| Payout { entry, amount: Amount::new(amount), paid: false })
                    .collect();
                self.organizer_owed = Amount::new(left);
                self.status = STATUS_JUDGED;
            } else if !live.is_empty() && self.share_if_unjudged {
                let amounts = rules::split_evenly(balance, live.len());
                self.payouts = live
                    .into_iter()
                    .zip(amounts)
                    .map(|(entry, amount)| Payout { entry, amount: Amount::new(amount), paid: false })
                    .collect();
                self.status = STATUS_SHARED;
            } else {
                self.organizer_owed = Amount::new(balance);
                self.status = STATUS_REFUNDED;
            }

            emit_event("Settled", metadata![
                "status" => self.status.to_string(),
                "prize" => balance.to_string(),
                "ballots" => opened.len().to_string(),
                "paid_places" => self.payouts.len().to_string(),
            ]);
            self.status
        }

        /// Pays one settled entry into its payout account. Anyone can call it; a bad payout
        /// account only holds up its own entry, and the entrant can fix it with `set_payout`.
        pub fn pay(&mut self, entry: u32) -> Amount {
            assert!(self.status != STATUS_OPEN, "the contest is not settled");
            let row = self
                .payouts
                .iter()
                .position(|p| p.entry == entry)
                .expect("this entry is not owed a prize");
            assert!(!self.payouts[row].paid, "this entry has been paid");
            let amount = self.payouts[row].amount;
            self.payouts[row].paid = true;
            if amount.is_positive() {
                let bucket = self.vault.withdraw(amount);
                ComponentManager::get(self.entries[entry as usize].payout).invoke("deposit", args![bucket]);
            }
            emit_event("Paid", metadata!["entry" => entry.to_string(), "amount" => amount.to_string()]);
            amount
        }

        /// Sends the organizer's part (unfilled places, or a refund) to the refund account.
        pub fn pay_organizer(&mut self) -> Amount {
            assert!(self.status != STATUS_OPEN, "the contest is not settled");
            let amount = self.organizer_owed;
            self.organizer_owed = Amount::zero();
            if amount.is_positive() {
                let bucket = self.vault.withdraw(amount);
                ComponentManager::get(self.refund_to).invoke("deposit", args![bucket]);
            }
            emit_event("OrganizerPaid", metadata!["amount" => amount.to_string()]);
            amount
        }

        /// Calls the contest off. Organizer only, and only while nobody is entered: once there is
        /// a live entry the prize can only leave through `settle`.
        pub fn cancel(&mut self) {
            self.assert_open();
            assert!(
                CallerContext::transaction_signer_public_key() == self.organizer,
                "only the organizer can cancel"
            );
            assert!(self.live_ids().is_empty(), "a contest with entries cannot be cancelled");
            self.organizer_owed = self.vault.balance();
            self.status = STATUS_REFUNDED;
            emit_event("Cancelled", metadata!["prize" => self.organizer_owed.to_string()]);
        }

        /// Returns (title, status, prize in the vault, total funded, live entries, opened ballots, quorum).
        pub fn info(&self) -> (String, u8, Amount, Amount, u32, u32, u32) {
            (
                self.title.clone(),
                self.status,
                self.vault.balance(),
                self.total_funded,
                self.live_ids().len() as u32,
                self.seats.iter().filter(|s| s.ranking.is_some()).count() as u32,
                self.quorum,
            )
        }

        fn assert_open(&self) {
            assert!(self.status == STATUS_OPEN, "the contest is settled");
        }

        fn live_ids(&self) -> Vec<u32> {
            self.entries
                .iter()
                .enumerate()
                .filter(|(_, e)| !e.withdrawn)
                .map(|(i, _)| i as u32)
                .collect()
        }

        fn live_entry_of(&self, owner: &RistrettoPublicKeyBytes) -> Option<usize> {
            self.entries.iter().position(|e| !e.withdrawn && e.owner == *owner)
        }

        fn signer_entry(&self) -> usize {
            let owner = CallerContext::transaction_signer_public_key();
            self.live_entry_of(&owner).expect("this key has no entry")
        }

        fn signer_seat(&self) -> usize {
            let signer = CallerContext::transaction_signer_public_key();
            self.seats
                .iter()
                .position(|s| s.judge == signer)
                .expect("this key is not a judge")
        }
    }
}
