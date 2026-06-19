"""Stage B.2b — make small, web-playable copies of the segment clips.

Only needed when the correction app (scripts/05_review_app.py) is served to
REMOTE volunteers (e.g. on Render) instead of over the LAN: the raw 16 kHz WAVs
in data/segments/ total ~2.2 GB, too big to bake into a deploy image, and
lossless is overkill for human listening. This transcodes each clip into
data/segments_web/ at a low speech bitrate (~10-20× smaller) while leaving the
canonical WAVs — the training source of truth — untouched.

  python scripts/09_compress_clips.py                 # opus 24 kbps (default)
  python scripts/09_compress_clips.py --codec mp3     # widest device support
  python scripts/09_compress_clips.py --force         # re-encode existing copies

The clip's path/stem is preserved exactly (sermon_NN/clip_NNNN), so the
clip_path keys in drafts/journal/manifests stay ".wav" everywhere — only the
audio bytes differ. The review app resolves the compressed sibling at serve time
(see common.web_audio_path); 06/07/training all keep using the WAVs.

Idempotent: skips clips already encoded unless --force. Requires ffmpeg.
"""

import argparse
import shutil
import subprocess
import sys
import time

from common import SEGMENTS, SEGMENTS_WEB

# codec -> (output extension, default bitrate, ffmpeg audio-encoder args)
CODECS = {
    "opus": (".opus", "24k", ["-c:a", "libopus"]),       # best quality/size for speech
    "mp3": (".mp3", "48k", ["-c:a", "libmp3lame"]),       # plays in every browser/phone
    "m4a": (".m4a", "48k", ["-c:a", "aac"]),              # AAC, broad Apple support
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--codec", choices=sorted(CODECS), default="opus", help="output codec (default: opus)")
    ap.add_argument("--bitrate", default=None, help="audio bitrate, e.g. 24k / 32k / 48k (default: per-codec)")
    ap.add_argument("--force", action="store_true", help="re-encode clips whose compressed copy already exists")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found on PATH — install it (brew install ffmpeg) and retry.")
    if not SEGMENTS.exists():
        sys.exit(f"no segments at {SEGMENTS} — run scripts/03_segment.py first.")

    ext, default_br, enc_args = CODECS[args.codec]
    bitrate = args.bitrate or default_br

    clips = sorted(SEGMENTS.glob("sermon_*/clip_*.wav"))
    if not clips:
        sys.exit(f"no clips found under {SEGMENTS}.")

    print(f"compressing {len(clips)} clips → {args.codec} @ {bitrate} mono into {SEGMENTS_WEB}")
    done = skipped = failed = 0
    out_bytes = 0
    t0 = time.time()
    for i, src in enumerate(clips, 1):
        rel = src.relative_to(SEGMENTS).with_suffix(ext)  # sermon_NN/clip_NNNN.<ext>
        dst = SEGMENTS_WEB / rel
        if dst.exists() and not args.force:
            skipped += 1
            out_bytes += dst.stat().st_size
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", *enc_args, "-b:a", bitrate, str(dst)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            failed += 1
            print(f"  ✗ {rel}: {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'ffmpeg failed'}")
            continue
        done += 1
        out_bytes += dst.stat().st_size
        if i % 200 == 0 or i == len(clips):
            rate = i / max(time.time() - t0, 1e-6)
            print(f"  {i}/{len(clips)}  ({done} encoded, {skipped} skipped, {failed} failed)  {rate:.0f} clips/s")

    total_mb = out_bytes / 1024 ** 2
    print(f"\ndone: {done} encoded, {skipped} already present, {failed} failed.")
    print(f"compressed set: {total_mb:.0f} MB under {SEGMENTS_WEB}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
