// SPDX-License-Identifier: MIT
//! The contest rules as plain functions: who may be ranked, how ballots add up, how the pool is
//! cut. Nothing here touches the engine, so the same cases can be checked on any machine and
//! are mirrored one to one by `web/src/rules.js`.

/// Shares are in basis points: 10,000 bps is the whole pool.
pub const TOTAL_BPS: u32 = 10_000;
/// Places that can be paid (1st, 2nd, …).
pub const MAX_PLACES: usize = 8;
pub const MAX_JUDGES: usize = 9;
/// Keeps one pool inside a single substate and `settle` inside one transaction.
pub const MAX_ENTRIES: usize = 64;

/// A prize split is 1 to 8 places, none of them zero, never rising from one place to the next,
/// and adding up to exactly 10,000 bps.
pub fn check_shares(bps: &[u16]) -> Result<(), &'static str> {
    if bps.is_empty() {
        return Err("at least one place is needed");
    }
    if bps.len() > MAX_PLACES {
        return Err("at most 8 places");
    }
    let mut total: u32 = 0;
    for (i, share) in bps.iter().enumerate() {
        if *share == 0 {
            return Err("every place must be more than zero");
        }
        if i > 0 && *share > bps[i - 1] {
            return Err("a lower place cannot pay more than a higher one");
        }
        total += u32::from(*share);
    }
    if total != TOTAL_BPS {
        return Err("places must add up to 10000 bps");
    }
    Ok(())
}

/// How many entries a ballot must rank: every paid place, or every live entry if there are fewer.
pub fn ballot_len(places: usize, live_entries: usize) -> usize {
    places.min(live_entries)
}

/// A ballot ranks exactly `ballot_len` different live entries, best first.
pub fn check_ballot(ranking: &[u32], live: &[u32], places: usize) -> Result<(), &'static str> {
    if ranking.len() != ballot_len(places, live.len()) {
        return Err("a ballot must rank one entry for every paid place");
    }
    for (i, id) in ranking.iter().enumerate() {
        if !live.contains(id) {
            return Err("a ballot names an entry that is not in the contest");
        }
        if ranking[..i].contains(id) {
            return Err("a ballot names an entry twice");
        }
    }
    Ok(())
}

/// Adds the ballots up and returns the entries that placed, best first.
///
/// A ballot of length k gives k points to its first entry, k-1 to the next, and so on. Ties go
/// to the entry with more first places, then to the one that entered earlier (the lower id).
/// An entry no judge ranked does not place, even if a paid place stays empty.
pub fn tally(ballots: &[Vec<u32>], live: &[u32], places: usize) -> Vec<u32> {
    let mut rows: Vec<(u32, u32, u32)> = live.iter().map(|id| (*id, 0u32, 0u32)).collect();
    for ballot in ballots {
        let k = ballot.len() as u32;
        for (pos, id) in ballot.iter().enumerate() {
            if let Some(row) = rows.iter_mut().find(|r| r.0 == *id) {
                row.1 += k - pos as u32;
                if pos == 0 {
                    row.2 += 1;
                }
            }
        }
    }
    rows.retain(|r| r.1 > 0);
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then(a.0.cmp(&b.0)));
    rows.truncate(places);
    rows.into_iter().map(|r| r.0).collect()
}

/// Cuts `balance` between `winners` placed entries. Returns one amount per winner and what is
/// left for the organizer.
///
/// Every share rounds down. When every place is filled the rounding dust goes to first place and
/// nothing is left. When places stay empty their shares, and the dust, go back to the organizer.
/// The amounts always add up to `balance`.
pub fn split(balance: u128, bps: &[u16], winners: usize) -> (Vec<u128>, u128) {
    let winners = winners.min(bps.len());
    let mut amounts: Vec<u128> = bps[..winners]
        .iter()
        .map(|share| balance * u128::from(*share) / u128::from(TOTAL_BPS))
        .collect();
    let paid: u128 = amounts.iter().sum();
    let left = balance - paid;
    if winners == bps.len() && winners > 0 {
        amounts[0] += left;
        (amounts, 0)
    } else {
        (amounts, left)
    }
}

/// The fallback when the judges did not reach a quorum: every live entry gets the same amount and
/// the earliest entry also gets the dust.
pub fn split_evenly(balance: u128, entries: usize) -> Vec<u128> {
    if entries == 0 {
        return Vec::new();
    }
    let each = balance / entries as u128;
    let mut amounts = vec![each; entries];
    amounts[0] += balance - each * entries as u128;
    amounts
}

/// The bytes a judge commits to: the ranking as big-endian u32s.
pub fn ranking_bytes(ranking: &[u32]) -> Vec<u8> {
    ranking.iter().flat_map(|id| id.to_be_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_must_be_a_falling_split_of_the_whole_pool() {
        assert!(check_shares(&[5714, 2857, 1429]).is_ok());
        assert!(check_shares(&[10_000]).is_ok());
        assert_eq!(check_shares(&[]), Err("at least one place is needed"));
        assert_eq!(check_shares(&[5000, 0, 5000]), Err("every place must be more than zero"));
        assert_eq!(check_shares(&[4000, 6000]), Err("a lower place cannot pay more than a higher one"));
        assert_eq!(check_shares(&[5000, 4000]), Err("places must add up to 10000 bps"));
        assert_eq!(check_shares(&[1250; 9]), Err("at most 8 places"));
    }

    #[test]
    fn a_ballot_ranks_each_paid_place_once() {
        let live = [0, 1, 2, 4];
        assert!(check_ballot(&[4, 0, 1], &live, 3).is_ok());
        assert!(check_ballot(&[4, 0], &live, 3).is_err());
        assert_eq!(check_ballot(&[4, 4, 1], &live, 3), Err("a ballot names an entry twice"));
        assert_eq!(
            check_ballot(&[4, 3, 1], &live, 3),
            Err("a ballot names an entry that is not in the contest")
        );
        // Two entries, three paid places: a ballot ranks both.
        assert!(check_ballot(&[1, 0], &[0, 1], 3).is_ok());
    }

    #[test]
    fn points_then_first_places_then_the_earlier_entry() {
        let live = [0, 1, 2, 3];
        // 2: 3+3+1 = 7, 0: 2+1+3 = 6, 1: 1+2 = 3, 3: 2 = 2
        let ballots = vec![vec![2, 0, 1], vec![2, 1, 0], vec![0, 3, 2]];
        assert_eq!(tally(&ballots, &live, 3), vec![2, 0, 1]);
        // 0 and 1 both have 5 points and one first place each: the earlier entry wins.
        let tied = vec![vec![0, 1, 2], vec![1, 0, 2]];
        assert_eq!(tally(&tied, &live, 3), vec![0, 1, 2]);
        // Same points, more first places wins: 1 has 3+3 = 6 with two firsts, 0 has 2+2+2 = 6 with none.
        let firsts = vec![vec![1, 0, 2], vec![1, 0, 3], vec![2, 0, 3]];
        assert_eq!(tally(&firsts, &live, 3)[0], 1);
    }

    #[test]
    fn an_entry_nobody_ranked_does_not_place() {
        let ballots = vec![vec![1, 0], vec![1, 0]];
        assert_eq!(tally(&ballots, &[0, 1], 3), vec![1, 0]);
        assert_eq!(tally(&[], &[0, 1], 3), Vec::<u32>::new());
    }

    #[test]
    fn the_split_always_adds_up() {
        // 1,750,000 TARI in µT, the monthly contest's 1M / 500K / 250K.
        let pool = 1_750_000_000_000u128;
        let (amounts, left) = split(pool, &[5714, 2857, 1429], 3);
        assert_eq!(amounts.iter().sum::<u128>() + left, pool);
        assert_eq!(left, 0);
        assert_eq!(amounts, vec![999_950_000_000, 499_975_000_000, 250_075_000_000]);

        // Dust goes to first place.
        let (amounts, left) = split(1_000_001, &[3334, 3333, 3333], 3);
        assert_eq!((amounts, left), (vec![333_401, 333_300, 333_300], 0));

        // Two entries placed out of three paid places: third place goes back to the organizer.
        let (amounts, left) = split(1_000_000, &[5000, 3000, 2000], 2);
        assert_eq!((amounts, left), (vec![500_000, 300_000], 200_000));

        // Nobody placed: everything goes back.
        assert_eq!(split(777, &[5000, 5000], 0), (vec![], 777));
    }

    #[test]
    fn the_even_split_gives_the_dust_to_the_earliest_entry() {
        assert_eq!(split_evenly(10, 3), vec![4, 3, 3]);
        assert_eq!(split_evenly(9, 3), vec![3, 3, 3]);
        assert_eq!(split_evenly(5, 0), Vec::<u128>::new());
    }

    #[test]
    fn ranking_bytes_are_big_endian_u32s() {
        assert_eq!(ranking_bytes(&[2, 0, 258]), vec![0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 2]);
    }
}
