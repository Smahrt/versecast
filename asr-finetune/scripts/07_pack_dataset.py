"""Stage C prep — pack corrected clips + manifests into training/dataset.tar.gz
for upload to the user's own Colab session (the one sanctioned, user-performed
exception to the no-upload rule). Audio for corrected clips only.
"""

import json
import tarfile
from pathlib import Path

from common import MANIFESTS, ROOT, SEGMENTS


def main() -> None:
    out = ROOT / "training" / "dataset.tar.gz"
    out.parent.mkdir(parents=True, exist_ok=True)

    manifests = list(MANIFESTS.glob("*.jsonl"))
    if not manifests:
        print("no manifests — run 06_build_manifests.py first")
        raise SystemExit(1)

    n_clips = 0
    with tarfile.open(out, "w:gz") as tar:
        for m in manifests:
            rewritten = []
            for line in m.read_text().splitlines():
                row = json.loads(line)
                src = Path(row["audio_filepath"])
                rel = f"segments/{src.relative_to(SEGMENTS)}"
                tar.add(src, arcname=f"dataset/{rel}")
                row["audio_filepath"] = rel
                rewritten.append(json.dumps(row))
                n_clips += 1
            data = ("\n".join(rewritten) + "\n").encode()
            info = tarfile.TarInfo(f"dataset/manifests/{m.name}")
            info.size = len(data)
            import io

            tar.addfile(info, io.BytesIO(data))

    print(f"packed {n_clips} clips → {out}  ({out.stat().st_size / 1e6:.0f} MB)")
    print("upload this single file in the Colab notebook (cell 2).")


if __name__ == "__main__":
    main()
