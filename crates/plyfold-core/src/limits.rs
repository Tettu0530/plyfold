//! When a rate or usage limit lifts, read from the message that reported it. Agents pass the provider's words on as
//! they are, so several shapes are understood:
//! - an epoch after a bar: `Claude AI usage limit reached|1767225600`
//! - a wait: `try again in 4 days 21 hours 3 minutes`, `Please try again in 6.6s`, `retry in 1m30s`
//! - a clock time, today or on a date, in this machine's time zone or one named in brackets:
//!   `resets 3pm (Asia/Tokyo)`, `try again at 3:52 PM`, `try again at Nov 22nd, 2026 3:52 PM`

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, Zoned};

/// When the limit lifts, if the message says. `now` carries the time zone a bare clock time is read in
pub(crate) fn reset_at(text: &str, now: &Zoned) -> Option<Timestamp> {
    let t = text.to_lowercase();
    epoch_after_bar(&t, now).or_else(|| wait(&t, now)).or_else(|| clock(&t, now))
}

/// `…|1767225600` (seconds) or `…|1767225600000` (milliseconds), within the next eight days
fn epoch_after_bar(t: &str, now: &Zoned) -> Option<Timestamp> {
    for (i, _) in t.match_indices('|') {
        let digits: String = t[i + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
        let ts = match digits.len() {
            10 => Timestamp::from_second(digits.parse().ok()?).ok()?,
            13 => Timestamp::from_millisecond(digits.parse().ok()?).ok()?,
            _ => continue,
        };
        if plausible(ts, now) {
            return Some(ts);
        }
    }
    None
}

/// Not in the past by more than a minute, and not more than eight days ahead (weekly limits)
fn plausible(ts: Timestamp, now: &Zoned) -> bool {
    let d = ts.as_millisecond() - now.timestamp().as_millisecond();
    (-60_000..=8 * 24 * 3_600_000).contains(&d)
}

const WAIT_MARKS: [&str; 7] = ["try again in ", "retry in ", "retry after ", "resets in ", "reset in ", "available in ", "\"retrydelay\": \""];

/// `try again in 4 days 21 hours`, `in 6.6s`, `in 1m30s`, `"retryDelay": "41s"`
fn wait(t: &str, now: &Zoned) -> Option<Timestamp> {
    WAIT_MARKS.iter().find_map(|m| {
        let at = t.find(m)? + m.len();
        let ms = duration_ms(&t[at..])?;
        Timestamp::from_millisecond(now.timestamp().as_millisecond() + ms).ok().filter(|ts| plausible(*ts, now))
    })
}

/// The run of `<number><unit>` at the start of `s` (spaces, commas and "and" between them are fine)
fn duration_ms(s: &str) -> Option<i64> {
    let mut total = 0f64;
    let mut found = false;
    let mut rest = s;
    loop {
        rest = rest.trim_start_matches([' ', ',']);
        if let Some(r) = rest.strip_prefix("and ") {
            rest = r;
        }
        let num_len = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
        if num_len == 0 {
            break;
        }
        let Ok(n) = rest[..num_len].parse::<f64>() else { break };
        let after = rest[num_len..].trim_start();
        let unit_len = after.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(after.len());
        let unit = &after[..unit_len];
        let per = match unit {
            "ms" | "millisecond" | "milliseconds" => 1.0,
            "s" | "sec" | "secs" | "second" | "seconds" => 1_000.0,
            "m" | "min" | "mins" | "minute" | "minutes" => 60_000.0,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000.0,
            "d" | "day" | "days" => 86_400_000.0,
            "w" | "week" | "weeks" => 604_800_000.0,
            _ => break,
        };
        total += n * per;
        found = true;
        rest = &after[unit_len..];
    }
    found.then_some(total.ceil() as i64)
}

const CLOCK_MARKS: [&str; 7] = ["resets at ", "reset at ", "resets ", "try again at ", "retry at ", "available at ", "available again at "];

/// `resets 3pm`, `resets 3:30 pm (asia/tokyo)`, `try again at 15:00`, `try again at nov 22nd, 2026 3:52 pm`
fn clock(t: &str, now: &Zoned) -> Option<Timestamp> {
    CLOCK_MARKS.iter().find_map(|m| {
        let at = t.find(m)? + m.len();
        clock_at(&t[at..], now)
    })
}

fn clock_at(s: &str, now: &Zoned) -> Option<Timestamp> {
    let mut words: Vec<&str> = s.split_whitespace().take(8).collect();
    // A date first: "nov 22nd, 2026" or "2026-11-22"
    let mut date: Option<Date> = None;
    if let Some(first) = words.first() {
        if let Ok(d) = first.trim_end_matches(',').parse::<Date>() {
            date = Some(d);
            words.remove(0);
        } else if let Some(month) = month_of(first) {
            let day: i8 = words.get(1)?.trim_end_matches(',').trim_end_matches(|c: char| c.is_ascii_alphabetic()).parse().ok()?;
            let year: i16 = match words.get(2).map(|w| w.trim_end_matches(',')) {
                Some(y) if y.len() == 4 && y.chars().all(|c| c.is_ascii_digit()) => {
                    words.remove(2);
                    y.parse().ok()?
                }
                _ => now.date().year(),
            };
            date = Some(Date::new(year, month, day).ok()?);
            words.drain(..2);
        }
    }
    // The time: "3pm", "3:30pm", "3:30 pm", "15:00", "3 pm"
    let first = *words.first()?;
    let (clock_part, mut suffix) = split_ampm(first.trim_end_matches(['.', ',']));
    let mut used = 1;
    if suffix.is_none()
        && let Some(next) = words.get(1)
    {
        let next = next.trim_end_matches(['.', ',', ')']);
        if next == "am" || next == "pm" || next == "a.m" || next == "p.m" {
            suffix = Some(next.starts_with('p'));
            used = 2;
        }
    }
    let (h, mi) = match clock_part.split_once(':') {
        Some((h, m)) => (h.parse::<i8>().ok()?, m.get(..2)?.parse::<i8>().ok()?),
        None => (clock_part.parse::<i8>().ok()?, 0),
    };
    let hour = match suffix {
        Some(pm) if (1..=12).contains(&h) => (h % 12) + if pm { 12 } else { 0 },
        Some(_) => return None,
        // A bare number without minutes is not a time ("resets 3 times")
        None if clock_part.contains(':') && (0..24).contains(&h) => h,
        None => return None,
    };
    if !(0..60).contains(&mi) {
        return None;
    }
    // A zone in brackets right after: "(asia/tokyo)"
    let tz = words
        .get(used)
        .and_then(|w| w.strip_prefix('('))
        .map(|w| w.trim_end_matches([')', '.', ',']))
        .and_then(zone)
        .unwrap_or_else(|| now.time_zone().clone());
    let today = now.with_time_zone(tz.clone()).date();
    let mut at = date.unwrap_or(today).at(hour, mi, 0, 0).to_zoned(tz.clone()).ok()?;
    // A clock time with no date that has already passed today means tomorrow
    if date.is_none() && at.timestamp() <= now.timestamp() {
        at = today.tomorrow().ok()?.at(hour, mi, 0, 0).to_zoned(tz).ok()?;
    }
    Some(at.timestamp()).filter(|ts| plausible(*ts, now))
}

fn split_ampm(w: &str) -> (&str, Option<bool>) {
    for (suffix, pm) in [("am", false), ("pm", true), ("a.m", false), ("p.m", true)] {
        if let Some(c) = w.strip_suffix(suffix) {
            return (c, Some(pm));
        }
    }
    (w, None)
}

/// An IANA zone name as written in lower case ("asia/tokyo"); names are matched case-insensitively
fn zone(name: &str) -> Option<TimeZone> {
    if name.eq_ignore_ascii_case("utc") || name.eq_ignore_ascii_case("gmt") {
        return Some(TimeZone::UTC);
    }
    // TimeZone::get matches names case-insensitively
    TimeZone::get(name).ok()
}

fn month_of(w: &str) -> Option<i8> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let w = w.trim_end_matches('.');
    if w.len() < 3 {
        return None;
    }
    MONTHS.iter().position(|m| w.starts_with(m)).map(|i| i as i8 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-11-21 10:00 in Tokyo (01:00 UTC)
    fn now() -> Zoned {
        "2026-11-21T10:00:00+09:00[Asia/Tokyo]".parse().unwrap()
    }

    fn at(s: &str) -> Timestamp {
        s.parse::<Zoned>().unwrap().timestamp()
    }

    #[test]
    fn an_epoch_after_a_bar() {
        let ts = now().timestamp().as_second() + 3 * 3600;
        assert_eq!(reset_at(&format!("Claude AI usage limit reached|{ts}"), &now()), Some(Timestamp::from_second(ts).unwrap()));
        assert_eq!(reset_at("Claude AI usage limit reached|1000000000", &now()), None, "long past is not a reset time");
    }

    #[test]
    fn a_wait() {
        let base = now().timestamp().as_millisecond();
        let after = |ms: i64| Timestamp::from_millisecond(base + ms).unwrap();
        assert_eq!(reset_at("Please try again in 6.6s.", &now()), Some(after(6_600)));
        assert_eq!(reset_at("Rate limited, retry in 1m30s", &now()), Some(after(90_000)));
        assert_eq!(
            reset_at("You've hit your usage limit. Upgrade to Pro or try again in 4 days 21 hours 3 minutes.", &now()),
            Some(after(((4 * 24 + 21) * 60 + 3) * 60_000))
        );
        assert_eq!(reset_at(r#"{"retryDelay": "41s"}"#, &now()), Some(after(41_000)));
        assert_eq!(reset_at("try again in a while", &now()), None);
    }

    #[test]
    fn a_clock_time() {
        assert_eq!(reset_at("5-hour limit reached ∙ resets 3pm", &now()), Some(at("2026-11-21T15:00:00+09:00[Asia/Tokyo]")));
        assert_eq!(reset_at("You've hit your limit · resets 3:30 pm (Asia/Tokyo)", &now()), Some(at("2026-11-21T15:30:00+09:00[Asia/Tokyo]")));
        // Past today: tomorrow
        assert_eq!(reset_at("limit reached, resets 9am", &now()), Some(at("2026-11-22T09:00:00+09:00[Asia/Tokyo]")));
        assert_eq!(reset_at("Try again at 15:00.", &now()), Some(at("2026-11-21T15:00:00+09:00[Asia/Tokyo]")));
        // Another zone, named in brackets
        assert_eq!(reset_at("resets 5pm (America/New_York)", &now()), Some(at("2026-11-21T17:00:00-05:00[America/New_York]")));
        // With a date
        assert_eq!(reset_at("try again at Nov 22nd, 2026 3:52 PM.", &now()), Some(at("2026-11-22T15:52:00+09:00[Asia/Tokyo]")));
        assert_eq!(reset_at("try again at 2026-11-23 08:00", &now()), Some(at("2026-11-23T08:00:00+09:00[Asia/Tokyo]")));
        // Not times
        assert_eq!(reset_at("the counter resets 3 times a day", &now()), None);
        assert_eq!(reset_at("resets 13pm", &now()), None);
    }
}
