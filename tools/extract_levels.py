#!/usr/bin/env python3
"""Extract Block Out! level files from YOUR OWN copy of the game APK/XAPK.

Levels ship inside the APK as Unity TextAssets (t249-level-N, t160-level-N, LevelsConfig, ...).
They are game content: the output folder (./levels) is gitignored — never commit it.

Usage:
    pip install UnityPy
    python tools/extract_levels.py path/to/game.xapk|base.apk [--out levels]
"""
import argparse
import collections
import io
import os
import shutil
import sys
import tempfile
import zipfile

KEEP = ("level", "config", "catalog")


def find_base_apk(path: str, tmp: str) -> str:
    """XAPK is a zip of APKs; the base APK holds assets/bin/Data."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if any(n.startswith("assets/bin/Data/") for n in names):
            return path
        apks = [n for n in names if n.endswith(".apk")]
        for n in sorted(apks, key=lambda n: -z.getinfo(n).file_size):
            with z.open(n) as f:
                data = f.read()
            with zipfile.ZipFile(io.BytesIO(data)) as inner:
                if any(m.startswith("assets/bin/Data/") for m in inner.namelist()):
                    out = os.path.join(tmp, os.path.basename(n))
                    with open(out, "wb") as w:
                        w.write(data)
                    return out
    sys.exit("No APK with assets/bin/Data found in " + path)


def extract_unity_data(apk: str, tmp: str) -> str:
    with zipfile.ZipFile(apk) as z:
        for i in z.infolist():
            if i.filename.startswith("assets/bin/Data/"):
                z.extract(i, tmp)
    data = os.path.join(tmp, "assets", "bin", "Data")
    # Unity splits large bundles into name.split0..N — merge them back.
    groups = collections.defaultdict(list)
    for n in os.listdir(data):
        if ".split" in n:
            base, idx = n.rsplit(".split", 1)
            groups[base].append(int(idx))
    for base, parts in groups.items():
        with open(os.path.join(data, base), "wb") as w:
            for p in sorted(parts):
                part = os.path.join(data, f"{base}.split{p}")
                with open(part, "rb") as r:
                    w.write(r.read())
                os.remove(part)
    return data


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("apk", help="game .xapk or base .apk")
    ap.add_argument("--out", default="levels")
    args = ap.parse_args()
    try:
        import UnityPy  # noqa: PLC0415
    except ImportError:
        sys.exit("pip install UnityPy")

    os.makedirs(args.out, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="jev-levels-")
    try:
        data = extract_unity_data(find_base_apk(args.apk, tmp), tmp)
        env = UnityPy.load(data)
        n = 0
        for o in env.objects:
            if o.type.name != "TextAsset":
                continue
            d = o.read()
            name = d.m_Name
            if not any(k in name.lower() for k in KEEP):
                continue
            script = d.m_Script
            raw = script.encode("utf-8", "surrogateescape") if isinstance(script, str) else bytes(script)
            with open(os.path.join(args.out, name + ".txt"), "wb") as w:
                w.write(raw)
            n += 1
        print(f"Wrote {n} files to {os.path.abspath(args.out)}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
