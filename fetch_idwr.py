#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IDWR（感染症発生動向調査・速報）の全数把握疾患CSVを取得し、
akta ダッシュボード用の data.json を生成する。

対象疾患: HIV（後天性免疫不全症候群） / 梅毒 / A型肝炎 / エムポックス
対象地域: 全国（総数）と東京都

出典: 国立健康危機管理研究機構（JIHS）感染症情報提供サイト
      https://id-info.jihs.go.jp/surveillance/idwr/index.html
※ 掲載値は速報値であり、後日修正されることがある。

使い方:
    python3 fetch_idwr.py                 # 差分更新（既存 data.json に追記）
    python3 fetch_idwr.py --years 2024 2025 2026   # 指定年を総ざらい
    python3 fetch_idwr.py --out data.json
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request

BASE = "https://id-info.jihs.go.jp/surveillance/idwr/provisional/{year}/{week}/{year}-{week}-zensu.csv"
UA = "akta-dashboard/0.1 (+https://akta.jp/ community HIV/STI information; contact: akta)"

# 出力キー -> CSV上の疾患名（NFKC正規化後の完全一致で照合。表記ゆれは複数登録）
TARGETS: dict[str, list[str]] = {
    # IDWRの届出カテゴリは「後天性免疫不全症候群」。
    # 無症候性キャリア（HIV感染者）とAIDS患者の合算値であり、内訳は含まれない。
    # 確定値・内訳は厚労省エイズ動向委員会の四半期／年次報告を参照のこと。
    "hiv": ["後天性免疫不全症候群"],
    "syphilis": ["梅毒"],
    "hepatitis_a": ["A型肝炎"],          # 全角Ａでも NFKC で A に揃う
    "mpox": ["エムポックス", "サル痘"],   # 2023年の改称前は「サル痘」
}

TOKYO = "東京都"
TOTAL = "総数"

PREF_SUFFIX = ("都", "道", "府", "県")

# 「2026年32週(08月03日～08月09日)」を拾う
RE_PERIOD = re.compile(
    r"(\d{4})\s*年\s*(\d{1,2})\s*週\s*[（(]\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"
    r"\s*[～~〜-]\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"
)


def norm(s: str) -> str:
    """全角/半角・空白の揺れを吸収する。"""
    s = unicodedata.normalize("NFKC", s or "")
    return s.replace(" ", "").replace("\u3000", "").strip()


def to_int(s: str):
    s = norm(s).replace(",", "")
    if s in ("", "-", "‐", "—", "･"):
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def decode(raw: bytes) -> str:
    """IDWRのCSVはShift-JIS(CP932)。念のため段階的にフォールバック。"""
    for enc in ("cp932", "shift_jis", "utf-8-sig", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("cp932", errors="replace")


def fetch(year: int, week: int, timeout: int = 30) -> bytes | None:
    url = BASE.format(year=year, week=week)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        print(f"  ! HTTP {e.code}: {url}", file=sys.stderr)
        return None
    except Exception as e:  # ネットワーク断など
        print(f"  ! {type(e).__name__}: {url} ({e})", file=sys.stderr)
        return None


def parse(text: str) -> dict | None:
    """1週分のCSV文字列を {'year':..,'week':..,'metrics':{...}} に変換する。"""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return None

    # --- 期間（年・週・開始日・終了日）------------------------------------
    head_blob = " ".join(" ".join(r) for r in rows[:3])
    m = RE_PERIOD.search(norm(head_blob))
    if not m:
        return None
    year, week = int(m.group(1)), int(m.group(2))
    sm, sd, em, ed = (int(m.group(i)) for i in (3, 4, 5, 6))
    # 年またぎ（第1週が前年12月始まり等）に対応
    start_year = year - 1 if (week <= 2 and sm == 12) else year
    end_year = year - 1 if (week <= 2 and em == 12) else year
    start = dt.date(start_year, sm, sd).isoformat()
    end = dt.date(end_year, em, ed).isoformat()

    # --- 疾患名ヘッダー行を探す -------------------------------------------
    # 列番号は年度により増減するため、必ず疾患名で位置を特定する
    header_i = None
    for i, row in enumerate(rows[:10]):
        if any(norm(c) == "梅毒" for c in row):
            header_i = i
            break
    if header_i is None:
        return None

    # 疾患名は「週/累積」の2列にまたがるので前方補完する
    names, last = [], ""
    for cell in rows[header_i]:
        c = norm(cell)
        if c:
            last = c
        names.append(last)

    sub = [norm(c) for c in rows[header_i + 1]] if len(rows) > header_i + 1 else []

    # 出力キー -> {'week': col, 'cum': col}
    colmap: dict[str, dict[str, int]] = {}
    for key, aliases in TARGETS.items():
        found: dict[str, int] = {}
        for idx, name in enumerate(names):
            if name in aliases:
                kind = sub[idx] if idx < len(sub) else ""
                if kind == "週" and "week" not in found:
                    found["week"] = idx
                elif kind in ("累積", "累積報告数") and "cum" not in found:
                    found["cum"] = idx
        # 「週/累積」ラベルが読めなかった場合は出現順で week, cum とみなす
        if not found:
            idxs = [i for i, n in enumerate(names) if n in aliases]
            if len(idxs) >= 2:
                found = {"week": idxs[0], "cum": idxs[1]}
        if found:
            colmap[key] = found

    if not colmap:
        return None

    # --- 地域行を拾う ------------------------------------------------------
    def pick(label: str) -> dict:
        for row in rows[header_i + 2:]:
            if not row:
                continue
            if norm(row[0]) == label:
                out = {}
                for key, cols in colmap.items():
                    out[key] = {
                        "week": to_int(row[cols["week"]]) if cols.get("week", -1) < len(row) else None,
                        "cum": to_int(row[cols["cum"]]) if cols.get("cum", -1) < len(row) else None,
                    }
                return out
        return {}

    national = pick(TOTAL)
    tokyo = pick(TOKYO)
    if not national and not tokyo:
        return None

    metrics = {}
    for key in colmap:
        metrics[key] = {
            "national": national.get(key, {"week": None, "cum": None}),
            "tokyo": tokyo.get(key, {"week": None, "cum": None}),
        }

    return {"year": year, "week": week, "start": start, "end": end, "metrics": metrics}


def load_existing(path: str) -> dict:
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"weeks": []}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data.json")
    ap.add_argument("--years", type=int, nargs="*", help="総ざらいする年（例: 2024 2025 2026）")
    ap.add_argument("--recheck", type=int, default=4, help="末尾から再取得する週数（速報値の修正取り込み）")
    ap.add_argument("--sleep", type=float, default=1.0, help="リクエスト間隔（秒）")
    args = ap.parse_args()

    existing = load_existing(args.out)
    have = {(w["year"], w["week"]): w for w in existing.get("weeks", [])}

    today = dt.date.today()
    if args.years:
        years = args.years
    else:
        years = sorted({today.year - 1, today.year})

    # 再取得対象（末尾N週）は have から一旦外す
    if have and args.recheck > 0:
        for k in sorted(have)[-args.recheck:]:
            have.pop(k, None)

    targets: list[tuple[int, int]] = []
    for y in years:
        last = 53 if y < today.year else min(53, today.isocalendar().week)
        for w in range(1, last + 1):
            if (y, w) not in have:
                targets.append((y, w))

    misses = 0
    for y, w in targets:
        raw = fetch(y, w)
        if raw is None:
            misses += 1
            # 直近の未公表週が続いたら打ち切る
            if misses >= 4 and y == today.year:
                break
            continue
        misses = 0
        rec = parse(decode(raw))
        if rec:
            have[(rec["year"], rec["week"])] = rec
            print(f"  + {rec['year']}年第{rec['week']}週 ({rec['start']}〜{rec['end']})")
        else:
            print(f"  ? parse failed: {y}-{w}", file=sys.stderr)
        time.sleep(args.sleep)

    weeks = [have[k] for k in sorted(have)]
    payload = {
        "demo": False,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": {
            "name": "国立健康危機管理研究機構（JIHS）感染症発生動向調査 週報（IDWR）速報データ",
            "url": "https://id-info.jihs.go.jp/surveillance/idwr/index.html",
            "note": "掲載値は速報値です。後日、週報および年報で修正されることがあります。",
        },
        "diseases": {
            "hiv": "HIV",
            "syphilis": "梅毒",
            "hepatitis_a": "A型肝炎",
            "mpox": "エムポックス",
        },
        "weeks": weeks,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"wrote {args.out}: {len(weeks)} weeks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
