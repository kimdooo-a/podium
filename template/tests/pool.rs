// SPDX-License-Identifier: MIT
//! Runs the template in the real Ootle engine. Linux and macOS only: the engine's compiler backend
//! does not build on Windows, where these tests are compiled out (see Cargo.toml).
#![cfg(not(windows))]

use sha2::{Digest, Sha256};
use tari_crypto::{keys::PublicKey as _, ristretto::{RistrettoPublicKey, RistrettoSecretKey}, tari_utilities::ByteArray};
use tari_template_lib::prelude::*;
use tari_template_test_tooling::{
    TemplateTest,
    support::assert_error::assert_reject_reason,
    transaction::args,
    engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId},
};

const ENTRIES_CLOSE: u64 = 10;
const REVEAL_OPEN: u64 = 20;
const JUDGING_CLOSE: u64 = 30;
const PRIZE: u64 = 1_000_001;

struct Person {
    account: ComponentAddress,
    key: RistrettoSecretKey,
}

impl Person {
    fn new(test: &mut TemplateTest) -> Self {
        let (account, _proof, key) = test.create_funded_account();
        Self { account, key }
    }

    fn public_key(&self) -> RistrettoPublicKeyBytes {
        let pk = RistrettoPublicKey::from_secret_key(&self.key);
        RistrettoPublicKeyBytes::from_bytes(pk.as_bytes()).unwrap()
    }
}

fn set_epoch(test: &mut TemplateTest, epoch: u64) {
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(epoch));
}

fn commitment(judge: &Person, ranking: &[u32], salt: &str) -> Hash32 {
    let mut hasher = Sha256::new();
    hasher.update(b"podium.ballot.v1");
    hasher.update(judge.public_key().as_bytes());
    hasher.update(podium_pool::rules::ranking_bytes(ranking));
    hasher.update(salt.as_bytes());
    Hash32::from_array(hasher.finalize().into())
}

/// A pool paying 3334 / 3333 / 3333 with two judges (quorum 2), funded with `PRIZE` by the organizer.
fn open_pool(test: &mut TemplateTest, organizer: &Person, judges: &[&Person], share_if_unjudged: bool) -> ComponentAddress {
    let template = test.get_template_address("PrizePool");
    let judge_keys: Vec<RistrettoPublicKeyBytes> = judges.iter().map(|j| j.public_key()).collect();
    test.execute_expect_success(
        test.transaction()
            .call_function(template, "new", args![
                "November build",
                "https://example.org/rules",
                organizer.account,
                vec![3334u16, 3333u16, 3333u16],
                judge_keys,
                2u32,
                ENTRIES_CLOSE,
                REVEAL_OPEN,
                JUDGING_CLOSE,
                share_if_unjudged
            ])
            .build_and_seal(&organizer.key),
        vec![],
    );
    let (pool, _) = test
        .read_only_state_store()
        .get_components_by_template_address(template)
        .unwrap()
        .remove(0);
    test.execute_expect_success(
        test.transaction()
            .call_method(organizer.account, "withdraw", args![TARI_TOKEN, Amount::from(PRIZE)])
            .put_last_instruction_output_on_workspace("prize")
            .call_method(pool, "fund", args![Workspace("prize")])
            .build_and_seal(&organizer.key),
        vec![],
    );
    pool
}

fn enter(test: &mut TemplateTest, pool: ComponentAddress, who: &Person, link: &str) {
    test.execute_expect_success(
        test.transaction()
            .call_method(pool, "enter", args![link, who.account])
            .build_and_seal(&who.key),
        vec![],
    );
}

fn tari_balance(test: &TemplateTest, account: ComponentAddress) -> Amount {
    test.read_only_state_store().get_vaults_for_account(account).unwrap()[&TARI_TOKEN].balance()
}

#[test]
fn judged_contest_pays_every_place_and_empties_the_pool() {
    let mut test = TemplateTest::my_crate();
    let organizer = Person::new(&mut test);
    let (ann, ben) = (Person::new(&mut test), Person::new(&mut test));
    let entrants = [Person::new(&mut test), Person::new(&mut test), Person::new(&mut test)];
    let pool = open_pool(&mut test, &organizer, &[&ann, &ben], false);
    for (i, e) in entrants.iter().enumerate() {
        enter(&mut test, pool, e, &format!("https://example.org/entry/{i}"));
    }
    let before: Vec<Amount> = entrants.iter().map(|e| tari_balance(&test, e.account)).collect();

    set_epoch(&mut test, ENTRIES_CLOSE);
    for (judge, ranking, salt) in [(&ann, [2u32, 0, 1], "ann-salt-0123456789"), (&ben, [2u32, 1, 0], "ben-salt-0123456789")] {
        test.execute_expect_success(
            test.transaction()
                .call_method(pool, "commit_ballot", args![commitment(judge, &ranking, salt)])
                .build_and_seal(&judge.key),
            vec![],
        );
    }
    set_epoch(&mut test, REVEAL_OPEN);
    for (judge, ranking, salt) in [(&ann, vec![2u32, 0, 1], "ann-salt-0123456789"), (&ben, vec![2u32, 1, 0], "ben-salt-0123456789")] {
        test.execute_expect_success(
            test.transaction()
                .call_method(pool, "reveal_ballot", args![ranking, salt])
                .build_and_seal(&judge.key),
            vec![],
        );
    }
    // Every judge has opened a ballot, so settling does not have to wait for JUDGING_CLOSE.
    // Entry 2 has 6 points; entries 0 and 1 tie on 3 with no first places, so the earlier entry is second.
    test.execute_expect_success(
        test.transaction()
            .call_method(pool, "settle", args![])
            .call_method(pool, "pay", args![2u32])
            .call_method(pool, "pay", args![0u32])
            .call_method(pool, "pay", args![1u32])
            .build_and_seal(&organizer.key),
        vec![],
    );
    let won: Vec<u128> = entrants
        .iter()
        .zip(&before)
        .map(|(e, b)| tari_balance(&test, e.account).to_u128() - b.to_u128())
        .collect();
    assert_eq!(won, vec![333_300, 333_300, 333_401]);
    let vaults = test.read_only_state_store().get_vaults_for_component(pool).unwrap();
    assert!(vaults.values().next().unwrap().balance().is_zero());
}

#[test]
fn settling_early_is_rejected_and_a_stranger_is_not_a_judge() {
    let mut test = TemplateTest::my_crate();
    let organizer = Person::new(&mut test);
    let (ann, ben, stranger) = (Person::new(&mut test), Person::new(&mut test), Person::new(&mut test));
    let pool = open_pool(&mut test, &organizer, &[&ann, &ben], false);
    enter(&mut test, pool, &stranger, "https://example.org/entry");

    let reason = test.execute_expect_failure(
        test.transaction().call_method(pool, "settle", args![]).build_and_seal(&organizer.key),
        vec![],
    );
    assert_reject_reason(reason, "judging is still open");

    // Once somebody is entered the organizer cannot call the contest off.
    let reason = test.execute_expect_failure(
        test.transaction().call_method(pool, "cancel", args![]).build_and_seal(&organizer.key),
        vec![],
    );
    assert_reject_reason(reason, "a contest with entries cannot be cancelled");

    set_epoch(&mut test, ENTRIES_CLOSE);
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(pool, "commit_ballot", args![commitment(&stranger, &[0], "stranger-salt-012345")])
            .build_and_seal(&stranger.key),
        vec![],
    );
    assert_reject_reason(reason, "this key is not a judge");
}

#[test]
fn a_ranking_that_does_not_match_the_commitment_is_rejected() {
    let mut test = TemplateTest::my_crate();
    let organizer = Person::new(&mut test);
    let (ann, ben) = (Person::new(&mut test), Person::new(&mut test));
    let entrants = [Person::new(&mut test), Person::new(&mut test)];
    let pool = open_pool(&mut test, &organizer, &[&ann, &ben], false);
    for e in &entrants {
        enter(&mut test, pool, e, "https://example.org/entry");
    }
    set_epoch(&mut test, ENTRIES_CLOSE);
    test.execute_expect_success(
        test.transaction()
            .call_method(pool, "commit_ballot", args![commitment(&ann, &[0, 1], "ann-salt-0123456789")])
            .build_and_seal(&ann.key),
        vec![],
    );
    set_epoch(&mut test, REVEAL_OPEN);
    let reason = test.execute_expect_failure(
        test.transaction()
            .call_method(pool, "reveal_ballot", args![vec![1u32, 0], "ann-salt-0123456789"])
            .build_and_seal(&ann.key),
        vec![],
    );
    assert_reject_reason(reason, "the ranking does not match the commitment");
}

#[test]
fn without_a_quorum_the_written_fallback_decides() {
    for share_if_unjudged in [true, false] {
        let mut test = TemplateTest::my_crate();
        let organizer = Person::new(&mut test);
        let (ann, ben) = (Person::new(&mut test), Person::new(&mut test));
        let entrants = [Person::new(&mut test), Person::new(&mut test), Person::new(&mut test)];
        let pool = open_pool(&mut test, &organizer, &[&ann, &ben], share_if_unjudged);
        for e in &entrants {
            enter(&mut test, pool, e, "https://example.org/entry");
        }
        let before = tari_balance(&test, entrants[0].account).to_u128();
        let organizer_before = tari_balance(&test, organizer.account).to_u128();

        set_epoch(&mut test, JUDGING_CLOSE);
        test.execute_expect_success(
            test.transaction().call_method(pool, "settle", args![]).build_and_seal(&entrants[0].key),
            vec![],
        );
        if share_if_unjudged {
            test.execute_expect_success(
                test.transaction().call_method(pool, "pay", args![0u32]).build_and_seal(&entrants[0].key),
                vec![],
            );
            // 1,000,001 / 3 = 333,333 each, and the earliest entry also gets the 2 µT of dust.
            assert_eq!(tari_balance(&test, entrants[0].account).to_u128() - before, 333_335);
        } else {
            test.execute_expect_success(
                test.transaction().call_method(pool, "pay_organizer", args![]).build_and_seal(&entrants[0].key),
                vec![],
            );
            assert_eq!(tari_balance(&test, organizer.account).to_u128() - organizer_before, u128::from(PRIZE));
        }
    }
}
