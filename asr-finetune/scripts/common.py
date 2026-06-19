"""Shared paths and helpers for the ASR fine-tuning pipeline."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
AUDIO16K = DATA / "audio16k"
SEGMENTS = DATA / "segments"
# Compressed, web-friendly copies of the segment clips (one per clip), used only
# when the review app is served remotely (e.g. Render). The canonical 16 kHz WAVs
# in SEGMENTS stay the source of truth for training — only the bytes differ here,
# never the clip_path keys (which remain ".wav" everywhere).
SEGMENTS_WEB = DATA / "segments_web"
DRAFTS = DATA / "drafts"
CORRECTED = DATA / "corrected"
MANIFESTS = DATA / "manifests"

AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}
VIDEO_EXT = {".mp4", ".mkv"}

# Browser-playable codecs the compressor may emit, in lookup order, with the MIME
# type send_file must report (guessing the wrong MIME makes <audio> silently fail).
WEB_AUDIO_MIME = {
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
}


def web_audio_path(clip_path: str) -> Path | None:
    """The compressed sibling of a clip under SEGMENTS_WEB, if one exists.

    `clip_path` keeps its canonical ".wav" name (as stored in drafts/journal);
    we only swap the extension to find the smaller web copy. Returns None when no
    compressed copy is present (e.g. local dev that never ran 09_compress_clips)."""
    stem = Path(clip_path).with_suffix("")
    base = SEGMENTS_WEB.resolve()
    for ext in WEB_AUDIO_MIME:
        if ext == ".wav":
            continue
        cand = (SEGMENTS_WEB / stem).with_suffix(ext)
        resolved = cand.resolve()
        if resolved.is_relative_to(base) and resolved.exists():  # guard path traversal
            return cand
    return None

# Canonical 66 book names (kept in sync with shared/src/books-data.json) plus
# sermon vocabulary — used as the whisper initial_prompt during drafting.
BOOK_NAMES = [
    "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua",
    "Judges", "Ruth", "1 Samuel", "2 Samuel", "1 Kings", "2 Kings",
    "1 Chronicles", "2 Chronicles", "Ezra", "Nehemiah", "Esther", "Job",
    "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon", "Isaiah",
    "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
    "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai",
    "Zechariah", "Malachi", "Matthew", "Mark", "Luke", "John", "Acts",
    "Romans", "1 Corinthians", "2 Corinthians", "Galatians", "Ephesians",
    "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians",
    "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James",
    "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude", "Revelation",
]

SERMON_VOCAB = [
    "hallelujah", "anoint", "anointing", "righteousness", "salvation",
    "intercession", "tithe", "shekinah", "amen", "glory", "grace", "mercy",
    "deliverance", "testimony", "covenant", "altar", "praise",
]


def initial_prompt() -> str:
    return (
        "A sermon preached in a Nigerian church, quoting the Bible: "
        + ", ".join(BOOK_NAMES)
        + ". "
        + ", ".join(SERMON_VOCAB)
        + "."
    )


def sermon_ids() -> list[str]:
    """sermon_NN ids present in audio16k, sorted."""
    return sorted(p.stem for p in AUDIO16K.glob("sermon_*.wav"))
