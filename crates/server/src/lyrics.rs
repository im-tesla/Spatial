use anyhow::{Context, Result, bail, ensure};
use roxmltree::{Document, Node, ParsingOptions};
use spatial_core::{LyricLine, LyricWord, SidecarLyrics};
use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tokio::io::AsyncReadExt;

pub const MAX_TTML_BYTES: usize = 1024 * 1024;
const TTML: &str = "http://www.w3.org/ns/ttml";
const APPLE: &str = "http://music.apple.com/lyric-ttml-internal";
const META: &str = "http://www.w3.org/ns/ttml#metadata";

// Sidecars follow the indexed file's stem; albums still come entirely from tags.
pub async fn sidecar_path(audio: &Path) -> Option<PathBuf> {
    for extension in ["ttml", "TTML"] {
        let path = audio.with_extension(extension);
        if tokio::fs::metadata(&path)
            .await
            .is_ok_and(|meta| meta.is_file())
        {
            return Some(path);
        }
    }
    None
}

pub async fn stamp(audio: &Path) -> String {
    let Some(path) = sidecar_path(audio).await else {
        return String::new();
    };
    let Ok(path) = tokio::fs::canonicalize(path).await else {
        return String::new();
    };
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return String::new();
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
        .unwrap_or_default();
    format!("{}:{}:{modified}", path.display(), metadata.len())
}

pub async fn load(audio: &Path, media_root: &Path) -> Result<Option<SidecarLyrics>> {
    let audio = tokio::fs::canonicalize(audio).await?;
    ensure!(
        audio.starts_with(media_root),
        "Audio path outside the media root"
    );
    let Some(path) = sidecar_path(&audio).await else {
        return Ok(None);
    };
    let path = tokio::fs::canonicalize(path).await?;
    ensure!(
        path.starts_with(media_root),
        "Lyrics path outside the media root"
    );
    let file = tokio::fs::File::open(path).await?;
    ensure!(
        file.metadata().await?.len() <= MAX_TTML_BYTES as u64,
        "TTML file is too large"
    );
    let mut bytes = Vec::new();
    file.take(MAX_TTML_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    ensure!(bytes.len() <= MAX_TTML_BYTES, "TTML file is too large");
    let source = String::from_utf8(bytes).context("TTML must be UTF-8")?;
    tokio::task::spawn_blocking(move || parse(&source))
        .await?
        .map(Some)
}

fn decimal(value: &str) -> Result<f64> {
    ensure!(
        !value.is_empty() && value.chars().all(|c| c.is_ascii_digit() || c == '.'),
        "Invalid TTML time"
    );
    Ok(value.parse()?)
}

fn time(value: &str) -> Result<f64> {
    let value = value.trim();
    let seconds = if let Some(value) = value.strip_suffix("ms") {
        decimal(value)? / 1000.0
    } else if let Some(value) = value.strip_suffix('h') {
        decimal(value)? * 3600.0
    } else if let Some(value) = value.strip_suffix('m') {
        decimal(value)? * 60.0
    } else if let Some(value) = value.strip_suffix('s') {
        decimal(value)?
    } else {
        let pieces: Vec<_> = value.split(':').collect();
        match pieces.as_slice() {
            [seconds] => decimal(seconds)?,
            [minutes, seconds] => {
                let seconds = decimal(seconds)?;
                ensure!(seconds < 60.0, "Invalid clock seconds");
                minutes.parse::<u32>()? as f64 * 60.0 + seconds
            }
            [hours, minutes, seconds] => {
                let minutes: u32 = minutes.parse()?;
                let seconds = decimal(seconds)?;
                ensure!(minutes < 60 && seconds < 60.0, "Invalid clock time");
                hours.parse::<u32>()? as f64 * 3600.0 + minutes as f64 * 60.0 + seconds
            }
            _ => bail!("Unsupported TTML time expression"),
        }
    };
    ensure!(
        seconds.is_finite() && (0.0..=86400.0).contains(&seconds),
        "TTML time outside supported range"
    );
    Ok(seconds)
}

#[derive(Clone, Copy, Default)]
struct Interval {
    start: f64,
    end: Option<f64>,
    timed: bool,
}

fn interval(node: Node<'_, '_>, parent: Interval, apple: bool) -> Result<Interval> {
    ensure!(
        node.attribute("timeContainer") != Some("seq"),
        "Sequential TTML timing is unsupported"
    );
    let begin = node.attribute("begin").map(time).transpose()?;
    let base = if apple { 0.0 } else { parent.start };
    let start = begin.map(|begin| base + begin).unwrap_or(parent.start);
    let own_end = node
        .attribute("end")
        .map(time)
        .transpose()?
        .map(|end| base + end);
    let duration_end = node
        .attribute("dur")
        .map(time)
        .transpose()?
        .map(|dur| start + dur);
    // Apple exports can retain a stale body duration after adding later verses.
    // Explicit song-relative line/word ends take precedence over container hints.
    let own_limit = [own_end, duration_end]
        .into_iter()
        .flatten()
        .reduce(f64::min);
    let end = if apple {
        own_limit.or(parent.end)
    } else {
        [own_limit, parent.end]
            .into_iter()
            .flatten()
            .reduce(f64::min)
    };
    ensure!(
        start <= 86400.0 && end.is_none_or(|end| end >= start && end <= 86400.0),
        "Invalid TTML interval"
    );
    Ok(Interval {
        start,
        end,
        timed: parent.timed || begin.is_some(),
    })
}

fn supported(node: Node<'_, '_>) -> bool {
    node.is_element() && matches!(node.tag_name().namespace(), Some(TTML) | None)
}

struct Part {
    text: String,
    cue: Option<Interval>,
}

fn contents(
    node: Node<'_, '_>,
    timing: Interval,
    cue: Option<Interval>,
    apple: bool,
    depth: usize,
    parts: &mut Vec<Part>,
) -> Result<()> {
    ensure!(depth < 64, "TTML nesting is too deep");
    for child in node.children() {
        if child.is_text() {
            parts.push(Part {
                text: child.text().unwrap_or_default().into(),
                cue,
            });
        } else if supported(child) && child.tag_name().name() == "br" {
            parts.push(Part {
                text: "\n".into(),
                cue,
            });
        } else if supported(child) && child.tag_name().name() == "span" {
            if matches!(
                child.attribute((META, "role")),
                Some("x-translation" | "x-transliteration" | "x-bg")
            ) {
                continue;
            }
            let child_timing = interval(child, timing, apple)?;
            let child_cue = if child.attribute("begin").is_some()
                || child.attribute("end").is_some()
                || child.attribute("dur").is_some()
            {
                Some(child_timing)
            } else {
                cue
            };
            contents(child, child_timing, child_cue, apple, depth + 1, parts)?;
        }
    }
    Ok(())
}

fn paragraph(node: Node<'_, '_>, timing: Interval, apple: bool) -> Result<Option<LyricLine>> {
    let mut parts = Vec::new();
    contents(node, timing, None, apple, 0, &mut parts)?;
    let preserve = node
        .ancestors()
        .find_map(|parent| parent.attribute((roxmltree::NS_XML_URI, "space")))
        == Some("preserve");
    let mut words: Vec<LyricWord> = Vec::new();
    let mut text = String::new();
    let mut prefix = String::new();
    let mut complete = true;
    for part in parts {
        let mut normalized = String::new();
        for character in part.text.chars() {
            if !preserve && matches!(character, ' ' | '\t' | '\r' | '\n') {
                if !text.ends_with(' ') && !text.is_empty() {
                    normalized.push(' ');
                    text.push(' ');
                }
            } else {
                normalized.push(character);
                text.push(character);
            }
        }
        if normalized.is_empty() {
            continue;
        }
        if let Some(cue) = part.cue.filter(|cue| cue.timed && cue.end.is_some()) {
            if !prefix.is_empty() {
                normalized.insert_str(0, &prefix);
                prefix.clear();
            }
            let end = cue.end.unwrap();
            if let Some(previous) = words
                .last_mut()
                .filter(|previous| previous.start == cue.start && previous.end == end)
            {
                previous.text.push_str(&normalized);
            } else {
                words.push(LyricWord {
                    text: normalized,
                    start: cue.start,
                    end,
                });
            }
        } else if normalized.trim().is_empty() || normalized.chars().all(|c| !c.is_alphanumeric()) {
            if let Some(previous) = words.last_mut() {
                previous.text.push_str(&normalized);
            } else {
                prefix.push_str(&normalized);
            }
        } else {
            complete = false;
        }
    }
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Ok(timing.timed.then_some(LyricLine {
            time: timing.start,
            text,
            end: timing.end,
            words: Vec::new(),
        }));
    }
    ensure!(text.len() <= 16384, "TTML line is too long");
    let start = if timing.timed {
        timing.start
    } else {
        words
            .first()
            .map(|word| word.start)
            .context("TTML line has no timing")?
    };
    let end = timing.end.or_else(|| words.last().map(|word| word.end));
    if !complete
        || words.iter().enumerate().any(|(index, word)| {
            word.start < start
                || end.is_some_and(|end| word.end > end)
                || word.end < word.start
                || (index > 0 && word.start < words[index - 1].start)
        })
        || words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<String>()
            .trim()
            != text
    {
        words.clear();
    }
    Ok(Some(LyricLine {
        time: start,
        text,
        end,
        words,
    }))
}

fn walk(
    node: Node<'_, '_>,
    parent: Interval,
    apple: bool,
    depth: usize,
    lines: &mut Vec<LyricLine>,
) -> Result<()> {
    ensure!(depth < 64, "TTML nesting is too deep");
    let timing = interval(node, parent, apple)?;
    if node.tag_name().name() == "p" {
        let backgrounds: Vec<_> = node
            .descendants()
            .filter(|child| {
                supported(*child)
                    && child.tag_name().name() == "span"
                    && child.attribute((META, "role")) == Some("x-bg")
            })
            .collect();
        ensure!(
            lines.len() + backgrounds.len() < 3000,
            "Too many TTML vocal lines"
        );
        if let Some(line) = paragraph(node, timing, apple)? {
            let mut line = line;
            if !backgrounds.is_empty() && !line.words.is_empty() {
                line.end = line.words.iter().map(|word| word.end).reduce(f64::max);
            }
            lines.push(line);
        }
        // A backing vocal is a separate timed voice, not the next foreground word.
        // Apple may place it after a later lead cue in XML even though it starts earlier.
        for background in backgrounds {
            let mut ancestors: Vec<_> = background
                .ancestors()
                .take_while(|ancestor| *ancestor != node)
                .collect();
            ensure!(ancestors.len() < 64, "TTML nesting is too deep");
            ancestors.reverse();
            let mut background_timing = timing;
            for ancestor in ancestors {
                background_timing = interval(ancestor, background_timing, apple)?;
            }
            if let Some(mut line) = paragraph(background, background_timing, apple)? {
                if !line.words.is_empty() {
                    line.time = line.words[0].start;
                    line.end = line.words.iter().map(|word| word.end).reduce(f64::max);
                }
                lines.push(line);
            }
        }
        ensure!(lines.len() <= 3000, "Too many TTML lines");
    } else {
        for child in node.children().filter(|child| {
            supported(*child) && matches!(child.tag_name().name(), "body" | "div" | "p")
        }) {
            walk(child, timing, apple, depth + 1, lines)?;
        }
    }
    Ok(())
}

pub fn parse(source: &str) -> Result<SidecarLyrics> {
    ensure!(source.len() <= MAX_TTML_BYTES, "TTML file is too large");
    let document = Document::parse_with_options(
        source.trim_start_matches('\u{feff}'),
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: 100000,
            ..Default::default()
        },
    )?;
    let root = document.root_element();
    ensure!(
        supported(root) && root.tag_name().name() == "tt",
        "Not a TTML document"
    );
    let apple = root.attribute((APPLE, "timing")).is_some();
    let mut lines = Vec::new();
    walk(root, Interval::default(), apple, 0, &mut lines)?;
    ensure!(
        lines.iter().any(|line| !line.text.is_empty()),
        "TTML contains no timed lyrics"
    );
    ensure!(
        lines.iter().map(|line| line.words.len()).sum::<usize>() <= 20000,
        "Too many TTML words"
    );
    lines.sort_by(|a, b| a.time.total_cmp(&b.time));
    let plain_lyrics = lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(SidecarLyrics {
        plain_lyrics,
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apple(body: &str) -> String {
        format!(
            r#"<tt xmlns="{TTML}" xmlns:itunes="{APPLE}" itunes:timing="Word"><body dur="3:30.376">{body}</body></tt>"#
        )
    }

    #[test]
    fn apple_line_times_are_song_relative_not_added_to_the_div_start() {
        let source = apple(
            r#"<div begin="10.460" end="1:01.772"><p begin="10.460" end="11.764">A quiet room</p><p begin="58.791" end="1:01.772">Let the room breathe</p></div>"#,
        );
        let lyrics = parse(&source).unwrap();
        assert_eq!(lyrics.lines.len(), 2);
        assert_eq!(lyrics.lines[0].time, 10.460);
        assert_eq!(lyrics.lines[1].time, 58.791);
        assert_eq!(lyrics.lines[1].end, Some(61.772));
        assert!(lyrics.lines.iter().all(|line| line.words.is_empty()));
    }

    #[test]
    fn stale_apple_container_duration_does_not_discard_explicit_later_verses() {
        let source = apple(
            r#"<div begin="200" end="220"><p begin="212" end="214">After the old duration</p></div>"#,
        );
        let lyrics = parse(&source).unwrap();
        assert_eq!(lyrics.lines[0].time, 212.0);
        assert_eq!(lyrics.lines[0].end, Some(214.0));
    }

    #[test]
    fn timed_spans_keep_exact_word_boundaries_gaps_spacing_and_punctuation() {
        let source = apple(
            r#"<div begin="1" end="8"><p begin="1" end="4">(<span begin="1" end="1.3">A</span> <span><span begin="1.7" end="2.3">quiet</span></span> <span begin="3" end="3.8">room</span>)</p></div>"#,
        );
        let lyrics = parse(&source).unwrap();
        let line = &lyrics.lines[0];
        assert_eq!(line.text, "(A quiet room)");
        assert_eq!(
            line.words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<String>(),
            line.text
        );
        assert_eq!(
            line.words
                .iter()
                .map(|word| (word.start, word.end))
                .collect::<Vec<_>>(),
            [(1.0, 1.3), (1.7, 2.3), (3.0, 3.8)]
        );
        assert_eq!(line.words[0].text, "(A ");
        assert_eq!(line.words[2].text, "room)");
    }

    #[test]
    fn standard_ttml_uses_parent_relative_offsets_and_duration() {
        let source = format!(
            r#"<tt xmlns="{TTML}"><body begin="10s" dur="1m"><div begin="5s"><p begin="1s" dur="4s"><span begin="500ms" end="2s">A </span><span begin="2s" end="3s">room</span></p></div></body></tt>"#
        );
        let lyrics = parse(&source).unwrap();
        assert_eq!(lyrics.lines[0].time, 16.0);
        assert_eq!(lyrics.lines[0].end, Some(20.0));
        assert_eq!(lyrics.lines[0].words[0].start, 16.5);
        assert_eq!(lyrics.lines[0].words[1].end, 19.0);
        for (source, expected) in [
            ("00:01:02.345", 62.345),
            ("1:02.345", 62.345),
            ("200ms", 0.2),
            ("0.5h", 1800.0),
            ("2m", 120.0),
        ] {
            assert_eq!(time(source).unwrap(), expected);
        }
    }

    #[test]
    fn xml_namespaces_entities_and_unicode_are_text_not_markup() {
        let source = format!(
            r#"<t:tt xmlns:t="{TTML}" xmlns:i="{APPLE}" i:timing="Line"><t:head><t:metadata>Not lyrics</t:metadata></t:head><t:body><t:p begin="1" end="2">You &amp; me &#x2014; &lt;静か&gt;</t:p></t:body></t:tt>"#
        );
        let lyrics = parse(&source).unwrap();
        assert_eq!(lyrics.plain_lyrics, "You & me — <静か>");
        assert!(lyrics.lines[0].words.is_empty());
    }

    #[test]
    fn incomplete_or_overlapping_inline_word_data_keeps_readable_line_timing() {
        for contents in [
            r#"A <span begin="1.7" end="2.3">quiet room</span>"#,
            r#"<span begin="2" end="3">A </span><span begin="1" end="2">room</span>"#,
        ] {
            let lyrics = parse(&apple(&format!(r#"<p begin="1" end="4">{contents}</p>"#))).unwrap();
            assert_eq!(lyrics.lines[0].time, 1.0);
            assert!(lyrics.lines[0].words.is_empty());
        }
    }

    #[test]
    fn simultaneous_vocals_and_empty_timed_interludes_are_preserved() {
        let lyrics = parse(&apple(r#"<p begin="1" end="4">First voice</p><p begin="2" end="5">Second voice</p><p begin="5" end="8"/><p begin="8" end="9">After the break</p>"#)).unwrap();
        assert_eq!(
            lyrics
                .lines
                .iter()
                .map(|line| line.time)
                .collect::<Vec<_>>(),
            [1.0, 2.0, 5.0, 8.0]
        );
        assert_eq!(lyrics.lines[2].text, "");
    }

    #[test]
    fn apple_backing_vocals_keep_independent_word_cues_when_xml_order_overlaps_the_lead() {
        let source = apple(&format!(
            r#"<p xmlns:ttm="{META}" begin="2:29.455" end="2:32.634"><span begin="2:29.455" end="2:31.815">Stay </span><span begin="2:32.278" end="2:32.634">here</span><span ttm:role="x-bg"><span begin="2:31.551" end="2:31.960">(with </span><span begin="2:31.960" end="2:32.309">me)</span></span></p>"#
        ));
        let lyrics = parse(&source).unwrap();
        assert_eq!(lyrics.lines.len(), 2);
        assert_eq!(lyrics.lines[0].text, "Stay here");
        assert_eq!(lyrics.lines[1].text, "(with me)");
        assert_eq!(lyrics.lines[0].words.len(), 2);
        assert_eq!(lyrics.lines[1].words.len(), 2);
        assert_eq!(lyrics.lines[1].time, time("2:31.551").unwrap());
        assert_eq!(lyrics.lines[1].end, Some(time("2:32.309").unwrap()));
        assert!(lyrics.lines[1].time < lyrics.lines[0].words[1].start);
    }

    #[test]
    fn standard_parent_relative_backing_spans_resolve_their_ancestor_offsets_once() {
        let source = format!(
            r#"<tt xmlns="{TTML}" xmlns:ttm="{META}"><body><p begin="10s" end="15s"><span begin="0s" end="1s">Lead</span><span begin="1s"><span ttm:role="x-bg"><span begin="1s" end="2s">Echo</span></span></span></p></body></tt>"#
        );
        let lyrics = parse(&source).unwrap();
        assert_eq!(lyrics.lines[0].end, Some(11.0));
        assert_eq!(lyrics.lines[1].time, 12.0);
        assert_eq!(lyrics.lines[1].words[0].end, 13.0);
    }

    #[test]
    fn malformed_external_entities_bad_times_and_unsupported_timing_are_rejected() {
        for source in [
            "<tt>",
            r#"<!DOCTYPE tt [<!ENTITY x SYSTEM "file:///etc/passwd">]><tt><body><p begin="1">&x;</p></body></tt>"#,
            r#"<html><body>Not TTML</body></html>"#,
            r#"<tt><body><p begin="-1" end="2">Invalid</p></body></tt>"#,
            r#"<tt><body><p begin="2" end="1">Invalid</p></body></tt>"#,
            r#"<tt><body timeContainer="seq"><p begin="1" end="2">Unsupported</p></body></tt>"#,
            r#"<tt><body><p begin="00:99:10" end="999999">Invalid</p></body></tt>"#,
            r#"<tt><body><p>Untimed</p></body></tt>"#,
        ] {
            assert!(parse(source).is_err(), "Accepted {source}");
        }
        assert!(parse(&"x".repeat(MAX_TTML_BYTES + 1)).is_err());
    }
}
