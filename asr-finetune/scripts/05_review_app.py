"""Stage B.2 — human correction app. The step that decides final quality.

  .venv/bin/python scripts/05_review_app.py            # shared on the LAN
  .venv/bin/python scripts/05_review_app.py --local    # this machine only

Multiple reviewers on the same network correct in PARALLEL: each enters a name,
and the server leases a distinct clip to each (5-min lease; abandoned clips
return to the pool), so no two people get the same clip and saves never clash.
Worst drafts first, audio player, Save / Skip / Reject, has_reference checkbox
(feeds the verse-detection metric — tick it for full references AND bare verse
navigations like "verse ten"), progress + who's online, resumes where left off.
Ctrl+Enter = save · Ctrl+R = reject.

Privacy: this serves your sermon clips to anyone on the local network. It stays
on your LAN (no upload to any third party), but only run it on a trusted network.
"""

import argparse
import csv
import json
import socket
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_file

from common import CORRECTED, DRAFTS, SEGMENTS

app = Flask(__name__)

FIELDS = ["clip_path", "text", "status", "has_reference", "reviewer"]
LEASE_SECONDS = 300  # an abandoned clip returns to the pool after this
# Append-only log of every save. The per-sermon CSVs can be rebuilt from this
# (scripts/05_review_app.py --rebuild) — so even a deleted CSV loses nothing.
JOURNAL = CORRECTED / "_journal.jsonl"

_lock = threading.Lock()
_drafts: list[dict] = []  # immutable once loaded
_claims: dict[str, tuple[str, float]] = {}  # clip_path -> (reviewer, claimed_at)


def load_drafts() -> list[dict]:
    global _drafts
    if not _drafts:
        rows = []
        for f in sorted(DRAFTS.glob("sermon_*.csv")):
            rows.extend(csv.DictReader(f.open()))
        _drafts = rows
    return _drafts


def corrected_path(clip_path: str) -> Path:
    return CORRECTED / f"{clip_path.split('/')[0]}.csv"


def load_corrected() -> dict[str, dict]:
    done = {}
    for f in CORRECTED.glob("sermon_*.csv"):
        for row in csv.DictReader(f.open()):
            done[row["clip_path"]] = row
    return done


def save_row(row: dict) -> None:
    CORRECTED.mkdir(parents=True, exist_ok=True)
    # 1) append to the durable journal FIRST (the source of truth for recovery)
    with JOURNAL.open("a") as jf:
        jf.write(json.dumps({**row, "ts": time.time()}) + "\n")
    # 2) update the per-sermon CSV (convenience view; rebuildable from journal)
    path = corrected_path(row["clip_path"])
    existing = []
    if path.exists():
        for r in csv.DictReader(path.open()):
            if r["clip_path"] != row["clip_path"]:
                existing.append({k: r.get(k, "") for k in FIELDS})
    existing.append(row)
    tmp = path.with_suffix(".csv.tmp")
    with tmp.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(existing)
    tmp.replace(path)  # atomic — never a torn file mid-write


def save_rows_bulk(rows: list[dict]) -> int:
    """Journal every row, then rewrite each affected sermon CSV once (O(sermons),
    not O(clips²)). Used by the owner-only bulk-accept tool."""
    if not rows:
        return 0
    CORRECTED.mkdir(parents=True, exist_ok=True)
    with JOURNAL.open("a") as jf:
        for r in rows:
            jf.write(json.dumps({**r, "ts": time.time()}) + "\n")
    by_sermon: dict[str, dict[str, dict]] = {}
    for r in rows:
        by_sermon.setdefault(r["clip_path"].split("/")[0], {})[r["clip_path"]] = r
    for sermon, new_rows in by_sermon.items():
        path = CORRECTED / f"{sermon}.csv"
        merged: dict[str, dict] = {}
        if path.exists():
            for r in csv.DictReader(path.open()):
                merged[r["clip_path"]] = {k: r.get(k, "") for k in FIELDS}
        merged.update(new_rows)
        tmp = path.with_suffix(".csv.tmp")
        with tmp.open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=FIELDS)
            w.writeheader()
            w.writerows([merged[k] for k in sorted(merged)])
        tmp.replace(path)
    return len(rows)


def bulk_candidates(threshold: float, requester: str) -> list[dict]:
    """Pending drafts (not done, not claimed by anyone else) with mean token
    log-prob ≥ threshold — the high-confidence tail safe to accept unheard."""
    done = load_corrected()
    claimed = active_claims(time.time())
    out = []
    for d in load_drafts():
        cp = d["clip_path"]
        if cp in done:
            continue
        who = claimed.get(cp)
        if who and who != requester:
            continue
        try:
            if float(d["avg_logprob"]) >= threshold:
                out.append(d)
        except (TypeError, ValueError):
            continue
    return out


def rebuild_from_journal() -> None:
    """Reconstruct every per-sermon CSV from the append-only journal (latest
    entry per clip wins). Use after an accidental CSV deletion."""
    if not JOURNAL.exists():
        print(f"no journal at {JOURNAL} — nothing to rebuild from")
        return
    latest: dict[str, dict] = {}
    for line in JOURNAL.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        latest[r["clip_path"]] = r  # later lines overwrite earlier
    by_sermon: dict[str, list[dict]] = {}
    for clip, r in latest.items():
        by_sermon.setdefault(clip.split("/")[0], []).append({k: r.get(k, "") for k in FIELDS})
    for sermon, rows in by_sermon.items():
        rows.sort(key=lambda x: x["clip_path"])
        path = CORRECTED / f"{sermon}.csv"
        with path.open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=FIELDS)
            w.writeheader()
            w.writerows(rows)
        print(f"  {sermon}.csv ← {len(rows)} rows")
    print(f"rebuilt {len(by_sermon)} sermon CSV(s) from {len(latest)} journaled corrections")


def active_claims(now: float) -> dict[str, str]:
    """clip_path -> reviewer for non-expired claims (also prunes expired)."""
    for clip, (_, ts) in list(_claims.items()):
        if now - ts > LEASE_SECONDS:
            del _claims[clip]
    return {clip: who for clip, (who, _) in _claims.items()}


def online_reviewers(now: float) -> list[str]:
    return sorted({who for who, ts in _claims.values() if now - ts <= LEASE_SECONDS})


@app.get("/api/next")
def next_clip():
    reviewer = (request.args.get("reviewer") or "").strip() or "anonymous"
    with _lock:
        drafts = load_drafts()
        done = load_corrected()
        now = time.time()
        claimed = active_claims(now)

        # If this reviewer already holds an unsaved claim, return it (refresh-safe)
        for clip, who in claimed.items():
            if who == reviewer and clip not in done:
                d = next((x for x in drafts if x["clip_path"] == clip), None)
                if d:
                    _claims[clip] = (reviewer, now)  # renew lease
                    return _clip_payload(d, drafts, done, now)

        pending = [d for d in drafts if d["clip_path"] not in done and d["clip_path"] not in claimed]
        if not pending:
            remaining = [d for d in drafts if d["clip_path"] not in done]
            return jsonify(
                {
                    "done": len(remaining) == 0,
                    "waiting": len(remaining) > 0,  # all remaining are claimed by others
                    "total": len(drafts),
                    "corrected": len(done),
                    "online": online_reviewers(now),
                }
            )
        d = pending[0]
        _claims[d["clip_path"]] = (reviewer, now)
        return _clip_payload(d, drafts, done, now)


def _clip_payload(d: dict, drafts: list[dict], done: dict, now: float):
    return jsonify(
        {
            "done": False,
            "waiting": False,
            "clip_path": d["clip_path"],
            "draft_text": d["draft_text"],
            "avg_logprob": d["avg_logprob"],
            "start": d["start"],
            "end": d["end"],
            "total": len(drafts),
            "corrected": len(done),
            "online": online_reviewers(now),
        }
    )


@app.post("/api/save")
def save():
    body = request.get_json()
    reviewer = (body.get("reviewer") or "").strip() or "anonymous"
    clip = body["clip_path"]
    with _lock:
        save_row(
            {
                "clip_path": clip,
                "text": body.get("text", "").strip(),
                "status": body["status"],  # corrected | skipped | rejected
                "has_reference": "1" if body.get("has_reference") else "0",
                "reviewer": reviewer,
            }
        )
        _claims.pop(clip, None)  # release the lease
    return jsonify({"ok": True})


OWNER = "Kubiat"  # only this reviewer may see/use the bulk-accept tool


@app.get("/api/bulk_preview")
def bulk_preview():
    reviewer = (request.args.get("reviewer") or "").strip()
    if reviewer != OWNER:
        return jsonify({"allowed": False}), 403
    try:
        thr = float(request.args.get("threshold", "-0.30"))
    except ValueError:
        thr = -0.30
    with _lock:
        done = load_corrected()
        claimed = active_claims(time.time())
        pend = []
        for d in load_drafts():
            cp = d["clip_path"]
            if cp in done or (claimed.get(cp) and claimed[cp] != reviewer):
                continue
            try:
                pend.append(float(d["avg_logprob"]))
            except (TypeError, ValueError):
                pass
    edges = [-0.15, -0.20, -0.25, -0.30, -0.35, -0.40, -0.50]
    return jsonify(
        {
            "allowed": True,
            "pending": len(pend),
            "threshold": thr,
            "at_threshold": sum(1 for v in pend if v >= thr),
            "distribution": [{"threshold": e, "count": sum(1 for v in pend if v >= e)} for e in edges],
        }
    )


@app.post("/api/bulk_accept")
def bulk_accept():
    body = request.get_json() or {}
    reviewer = (body.get("reviewer") or "").strip()
    if reviewer != OWNER:
        return jsonify({"error": "forbidden — bulk accept is restricted"}), 403
    try:
        thr = float(body.get("threshold", -0.30))
    except (TypeError, ValueError):
        return jsonify({"error": "bad threshold"}), 400
    with _lock:
        cands = bulk_candidates(thr, reviewer)
        rows = [
            {
                "clip_path": d["clip_path"],
                "text": d["draft_text"].strip(),
                "status": "corrected",
                "has_reference": "0",  # bulk-accepted as-is; mark references by hand
                "reviewer": f"{OWNER} (bulk)",
            }
            for d in cands
            if d["draft_text"].strip()
        ]
        n = save_rows_bulk(rows)
        for r in rows:
            _claims.pop(r["clip_path"], None)
    return jsonify({"accepted": n, "threshold": thr})


@app.get("/audio/<path:clip_path>")
def audio(clip_path: str):
    full = (SEGMENTS / clip_path).resolve()
    if not full.is_relative_to(SEGMENTS.resolve()):
        return "nope", 403
    return send_file(full)


PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>VerseCast — transcript correction</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #14141a; color: #eee; max-width: 880px; margin: 2rem auto; padding: 0 1rem; }
  .bar { background: #2a2a33; border-radius: 6px; height: 10px; overflow: hidden; }
  .bar > div { background: #a5c694; height: 100%; transition: width .3s; }
  textarea { width: 100%; min-height: 130px; font-size: 17px; line-height: 1.5; background: #1d1d24; color: #eee; border: 1px solid #333; border-radius: 8px; padding: 12px; box-sizing: border-box; }
  audio { width: 100%; margin: 14px 0; }
  button { font-size: 15px; padding: 10px 22px; border-radius: 8px; border: 0; cursor: pointer; margin-right: 8px; }
  .save { background: #a5c694; font-weight: 700; }
  .edit { background: #2f5d94; color: #fff; }
  .skip { background: #444; color: #ddd; }
  .reject { background: #94432f; color: #fff; }
  .hint { color: #a5c694; font-size: 13px; margin: 6px 0 2px; }
  .meta { color: #888; font-size: 13px; }
  .who { color: #a5c694; }
  .rules { background: #1d1d24; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #aaa; line-height: 1.6; margin-top: 2rem; }
  label { font-size: 14px; color: #ccc; }
  #gate { text-align: center; margin-top: 4rem; }
  #gate input { font-size: 18px; padding: 10px 14px; border-radius: 8px; border: 1px solid #333; background: #1d1d24; color: #eee; }
</style></head><body>
  <div id="gate">
    <h2>Transcript correction</h2>
    <p class="meta">Enter your name so clips aren't handed to two people at once.</p>
    <p><input id="name" placeholder="your name" autofocus> <button class="save" onclick="start()">Start</button></p>
  </div>
  <div id="work" style="display:none">
    <h2>Transcript correction <span class="meta">— <span class="who" id="me"></span></span></h2>
    <div class="bar"><div id="prog" style="width:0%"></div></div>
    <p class="meta"><span id="count"></span> · <span id="online"></span></p>
    <div id="main">
      <audio id="player" controls autoplay></audio>
      <textarea id="text" spellcheck="true"></textarea>
      <p><label><input type="checkbox" id="hasref"> clip contains a verse reference or navigation (“John chapter three verse sixteen”, or a bare “verse ten”)</label></p>
      <p class="hint" id="hint"></p>
      <p>
        <button class="save" id="btnCorrect" onclick="save('corrected')">✓ Correct</button>
        <button class="edit" id="btnEdit" onclick="edit()">Edit</button>
        <button class="skip" id="btnSkip" onclick="save('skipped')">Skip — exclude</button>
        <button class="reject" id="btnReject" onclick="save('rejected')">Reject</button>
      </p>
      <p class="meta" id="clipinfo"></p>
    </div>
    <div id="waitmsg" style="display:none"><p class="meta">All remaining clips are checked out by other reviewers. Waiting…</p></div>
    <div id="donemsg" style="display:none"><h3>All clips reviewed 🎉</h3><p>Run <code>scripts/06_build_manifests.py</code> next.</p></div>
    <div id="bulk" style="display:none; margin-top:1.8rem; background:#1d1d24; border:1px solid #3a3a44; border-radius:8px; padding:14px 16px;">
      <b>Bulk accept the easy tail</b> <span class="meta">— owner only</span>
      <p class="meta">Accept every remaining clip whose draft confidence is at or above the threshold, as-is, without listening. Trades a little accuracy for speed on the clips the model already got right. Reference clips aren't auto-marked — leave the threshold high and hand-review the rest.</p>
      <p>confidence ≥
        <input id="thr" type="number" step="0.01" value="-0.25" style="width:84px; font-size:15px; padding:6px; border-radius:6px; border:1px solid #333; background:#14141a; color:#eee;">
        <button class="skip" onclick="bulkPreview()">Preview</button>
        <span id="bulkcount" class="who"></span>
      </p>
      <p id="bulkdist" class="meta"></p>
      <button class="save" onclick="bulkAccept()">Accept matching clips as-is</button>
    </div>
  </div>
  <div class="rules"><b>Correction rules</b><br>
    · Transcribe what was <i>said</i>, not what was meant (“First Corinthians” if spoken in words; numerals where a number was said — be consistent).<br>
    · Natural punctuation and capitalization. Skip hesitations (“uh”).<br>
    · Tick the reference box for full references <i>and</i> bare verse navigations (“verse ten”) — both should put a verse on screen.<br>
    · <b>Correct</b> keeps the clip — already-right drafts just need the accept shortcut. <b>Skip</b> leaves the clip <i>out</i> of the dataset (use it when unsure, not for correct clips). <b>Reject</b> also excludes — for music / unintelligible / non-English clips.<br>
    · Pidgin or vernacular sentences: reject — v1 is English-only; mixed clips teach the model noise.
  </div>
<script>
let me = localStorage.getItem('reviewer') || '';
let current = null;
if (me) { document.getElementById('name').value = me; }

// ⌘ on Mac, Ctrl on Windows/Linux — for the action shortcuts
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
const MODKEY = IS_MAC ? '⌘' : 'Ctrl+';   // ⌘ / Ctrl+
function chord(k) { return MODKEY + k; }
function pressedMod(e) { return IS_MAC ? e.metaKey : e.ctrlKey; }
function labelShortcuts() {
  document.getElementById('btnCorrect').textContent = '✓ Correct (' + chord('Enter') + ')';
  document.getElementById('btnEdit').textContent = 'Edit (' + chord('E') + ')';
  document.getElementById('btnSkip').textContent = 'Skip — exclude (' + chord('S') + ')';
  document.getElementById('btnReject').textContent = 'Reject (' + chord('R') + ')';
  document.getElementById('hint').innerHTML =
    'Draft already correct? Press <b>' + chord('Enter') + '</b> to accept it as-is. ' +
    'To fix it, press <b>' + chord('E') + '</b> (or click the text), edit, then <b>' + chord('Enter') + '</b>.';
}
labelShortcuts();
function start() {
  me = (document.getElementById('name').value || '').trim();
  if (!me) return;
  localStorage.setItem('reviewer', me);
  document.getElementById('gate').style.display = 'none';
  document.getElementById('work').style.display = 'block';
  document.getElementById('me').textContent = me;
  document.getElementById('bulk').style.display = (me === 'Kubiat') ? 'block' : 'none';
  next();
}
async function bulkPreview() {
  const thr = document.getElementById('thr').value;
  const r = await fetch('/api/bulk_preview?reviewer=' + encodeURIComponent(me) + '&threshold=' + thr);
  if (!r.ok) { document.getElementById('bulkcount').textContent = '(not permitted)'; return; }
  const d = await r.json();
  document.getElementById('bulkcount').textContent = d.at_threshold + ' of ' + d.pending + ' pending clips match';
  document.getElementById('bulkdist').textContent = 'matches by threshold — ' + d.distribution.map(x => x.threshold.toFixed(2) + ': ' + x.count).join('  ·  ');
}
async function bulkAccept() {
  const thr = document.getElementById('thr').value;
  const pr = await fetch('/api/bulk_preview?reviewer=' + encodeURIComponent(me) + '&threshold=' + thr);
  if (!pr.ok) { alert('Not permitted.'); return; }
  const pd = await pr.json();
  if (!pd.at_threshold) { alert('No pending clips at confidence ≥ ' + thr + '.'); return; }
  if (!confirm('Accept ' + pd.at_threshold + ' clips as-is at confidence ≥ ' + thr + '?\\nThey go into the dataset uncorrected. Recoverable only via the journal.')) return;
  const r = await fetch('/api/bulk_accept', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: me, threshold: parseFloat(thr) }) });
  const d = await r.json();
  alert('Accepted ' + d.accepted + ' clips as-is.');
  bulkPreview();
  next();
}
async function next() {
  const r = await fetch('/api/next?reviewer=' + encodeURIComponent(me)); const d = await r.json();
  document.getElementById('prog').style.width = (100 * d.corrected / Math.max(d.total, 1)) + '%';
  document.getElementById('count').textContent = d.corrected + ' / ' + d.total + ' reviewed';
  document.getElementById('online').textContent = (d.online && d.online.length ? d.online.length + ' online: ' + d.online.join(', ') : 'just you');
  document.getElementById('main').style.display = d.done || d.waiting ? 'none' : 'block';
  document.getElementById('donemsg').style.display = d.done ? 'block' : 'none';
  document.getElementById('waitmsg').style.display = d.waiting ? 'block' : 'none';
  if (d.waiting) { setTimeout(next, 5000); return; }   // a lease may free up
  if (d.done) return;
  current = d;
  document.getElementById('player').src = '/audio/' + d.clip_path;
  document.getElementById('text').value = d.draft_text;
  document.getElementById('hasref').checked = false;
  document.getElementById('clipinfo').textContent = d.clip_path + ' · ' + d.start + 's–' + d.end + 's · draft confidence ' + d.avg_logprob;
  // stay in nav mode (textarea NOT focused) so Enter accepts the draft as-is
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function edit() {
  const t = document.getElementById('text');
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
}
async function save(status) {
  if (!current) return;
  await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clip_path: current.clip_path, text: document.getElementById('text').value, status, has_reference: document.getElementById('hasref').checked, reviewer: me }) });
  next();
}
document.addEventListener('keydown', (e) => {
  const working = document.getElementById('work').style.display !== 'none';
  if (!working) { if (e.key === 'Enter') start(); return; }   // name screen
  if (e.key === 'Escape') { document.getElementById('text').blur(); return; }
  // every action requires the platform modifier (⌘ on Mac, Ctrl elsewhere),
  // so the same chords work whether or not the text box is focused
  if (!pressedMod(e) || !current) return;
  const k = e.key.toLowerCase();
  if (e.key === 'Enter') { e.preventDefault(); save('corrected'); }
  else if (k === 'e') { e.preventDefault(); edit(); }
  else if (k === 's') { e.preventDefault(); save('skipped'); }
  else if (k === 'r') { e.preventDefault(); save('rejected'); }
});
</script></body></html>"""


@app.get("/")
def index():
    return PAGE


def lan_ip() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no packets sent; just resolves the local iface
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true", help="bind 127.0.0.1 only (no LAN sharing)")
    ap.add_argument("--port", type=int, default=7860)
    ap.add_argument("--rebuild", action="store_true", help="rebuild corrected CSVs from _journal.jsonl, then exit")
    args = ap.parse_args()

    if args.rebuild:
        rebuild_from_journal()
        raise SystemExit(0)

    host = "127.0.0.1" if args.local else "0.0.0.0"
    print("correction app:")
    print(f"  this machine   http://127.0.0.1:{args.port}")
    if not args.local:
        ip = lan_ip()
        if ip:
            print(f"  other laptops  http://{ip}:{args.port}   (same Wi-Fi/LAN)")
        print("  note: serves your sermon clips to anyone on this network — run it on a trusted LAN only.")
    app.run(host=host, port=args.port, threaded=True)
