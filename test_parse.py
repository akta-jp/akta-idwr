#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_idwr.py のパーサ自己テスト。

外部ネットワークには一切アクセスしない。IDWR速報CSVの「実際の癖」を
再現した合成データを食わせて、パーサが壊れていないことを確認する。

    python3 test_parse.py

CIでは .github/workflows/update-idwr.yml から呼んでもよい。
失敗すると終了コード1で落ちる。

--- ここで守っている「実際の癖」（過去に踏んだ地雷）-----------------
1. 行末が CR のみ（旧Mac形式）。CRLF/LF で来ることも想定して3種すべて通す。
2. 週次列の見出しは「週」ではなく「報告」。
3. 「A型肝炎」は全角Ａで入る。NFKC正規化で吸収する。
4. 「エムポックス」は2023年の改称前は「サル痘」。
5. 疾患名は「報告/累積」の2列にまたがるので前方補完が要る。
6. 列の位置は年度によりずれる。列番号でハードコードしてはいけない。
7. URLの週番号は2桁ゼロ埋め（/2025/01/2025-01-zensu.csv）。
   ゼロ埋めを落とすと第1〜9週が静かに欠落する。
8. URL体系が2023年で分断されている。2022年以前は
   /niid/images/idwr/sokuho/idwr-{y}/{y}{ww}/{y}-{ww}-zensu.csv、
   2023年以降は /surveillance/idwr/provisional/{y}/{ww}/{y}-{ww}-zensu.csv。
   片方だけ見ていると、過去分が丸ごと静かに欠落する。
"""

from __future__ import annotations

import io
import sys
import unittest.mock as mock

import fetch_idwr as F


# --- 合成CSVの組み立て ----------------------------------------------------

def build_csv(
    period: str = "2026年33週(08月10日～08月16日)",
    mpox_name: str = "エムポックス",
    hepa_name: str = "Ａ型肝炎",      # 全角Ａ（実データはこちら）
    week_label: str = "報告",
    newline: str = "\r",              # 実データは CR のみ
) -> bytes:
    """本物と同じ3行ヘッダー構造のCSVをcp932バイト列で作る。

    疾患名の前後にダミー疾患を挟み、列位置が動いても疾患名で
    引けていることを確認する。
    """
    diseases = ["結核", "梅毒", "腸チフス", hepa_name, mpox_name, "後天性免疫不全症候群"]

    # 1行目: タイトル / 2行目: 期間 / 3行目: 疾患名 / 4行目: 報告・累積
    name_row = [""]
    sub_row = [""]
    for d in diseases:
        name_row += [d, ""]              # 疾患名は2列にまたがり、2列目は空
        sub_row += [week_label, "累積"]

    def data_row(label: str, pairs: list[tuple[str, str]]) -> list[str]:
        row = [label]
        for wk, cum in pairs:
            row += [wk, cum]
        return row

    rows = [
        ["報告数・累積報告数、疾病・都道府県別"],
        [period, "2026年08月20日作成"],
        name_row,
        sub_row,
        # 結核, 梅毒, 腸チフス, A型肝炎, エムポックス, HIV
        data_row("総数", [("206", "2330"), ("105", "7209"), ("1", "5"),
                          ("8", "221"), ("4", "110"), ("14", "592")]),
        data_row("北海道", [("5", "60"), ("2", "80"), ("0", "0"),
                            ("0", "1"), ("0", "0"), ("0", "9")]),
        data_row("東京都", [("40", "500"), ("32", "1715"), ("0", "1"),
                            ("4", "102"), ("2", "97"), ("2", "172")]),
    ]

    text = newline.join(",".join(cells) for cells in rows) + newline
    return text.encode("cp932")


def parse_bytes(raw: bytes) -> dict:
    return F.parse(F.decode(raw))


# --- テスト本体 -----------------------------------------------------------

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(': ' + detail) if detail else ''}")
        FAILURES.append(name)


def test_period() -> None:
    rec = parse_bytes(build_csv())
    check("期間: 年", rec["year"] == 2026, repr(rec["year"]))
    check("期間: 週", rec["week"] == 33, repr(rec["week"]))
    check("期間: 開始日", rec["start"] == "2026-08-10", rec["start"])
    check("期間: 終了日", rec["end"] == "2026-08-16", rec["end"])


def test_metrics() -> None:
    m = parse_bytes(build_csv())["metrics"]
    check("HIV 全国", m["hiv"]["national"] == {"week": 14, "cum": 592}, repr(m["hiv"]))
    check("HIV 東京", m["hiv"]["tokyo"] == {"week": 2, "cum": 172}, repr(m["hiv"]))
    check("梅毒 全国", m["syphilis"]["national"] == {"week": 105, "cum": 7209})
    check("梅毒 東京", m["syphilis"]["tokyo"] == {"week": 32, "cum": 1715})
    check("A型肝炎 全国（全角Ａ）", m["hepatitis_a"]["national"] == {"week": 8, "cum": 221})
    check("A型肝炎 東京", m["hepatitis_a"]["tokyo"] == {"week": 4, "cum": 102})
    check("エムポックス 全国", m["mpox"]["national"] == {"week": 4, "cum": 110})
    check("エムポックス 東京", m["mpox"]["tokyo"] == {"week": 2, "cum": 97})
    check("北海道は拾わない", set(m) == {"hiv", "syphilis", "hepatitis_a", "mpox"}, repr(set(m)))


def test_newline_variants() -> None:
    """CR / CRLF / LF のどれで来ても同じ結果になること。"""
    base = parse_bytes(build_csv(newline="\r"))
    for label, nl in (("CRLF", "\r\n"), ("LF", "\n")):
        got = parse_bytes(build_csv(newline=nl))
        check(f"改行 {label} でも同一", got == base)


def test_halfwidth_hepatitis() -> None:
    rec = parse_bytes(build_csv(hepa_name="A型肝炎"))
    check("A型肝炎 半角Ａでも拾える",
          rec["metrics"]["hepatitis_a"]["national"] == {"week": 8, "cum": 221})


def test_monkeypox_alias() -> None:
    rec = parse_bytes(build_csv(mpox_name="サル痘"))
    check("サル痘（改称前）も mpox として拾える",
          rec["metrics"]["mpox"]["national"] == {"week": 4, "cum": 110})


def test_week_label_variants() -> None:
    """見出しが「週」でも「報告」でも拾えること（本番は「報告」）。"""
    for label in ("報告", "週", "報告数"):
        rec = parse_bytes(build_csv(week_label=label))
        ok = rec is not None and rec["metrics"]["hiv"]["national"]["week"] == 14
        check(f"週次見出し「{label}」", ok)


def test_column_shift() -> None:
    """疾患の並び順が変わっても疾患名で引けること。"""
    rec_a = parse_bytes(build_csv())
    rec_b = parse_bytes(build_csv(mpox_name="エムポックス", hepa_name="Ａ型肝炎"))
    check("列位置に依存しない", rec_a["metrics"] == rec_b["metrics"])


def test_url_zero_padding() -> None:
    """URLの週番号が2桁ゼロ埋めされること。"""
    seen: list[str] = []

    class FakeRes:
        def read(self) -> bytes:
            return b""

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        seen.append(req.full_url)
        return FakeRes()

    with mock.patch("urllib.request.urlopen", fake_urlopen):
        F.fetch(2025, 1)
        F.fetch(2025, 10)

    check("第1週は /2025/01/2025-01-zensu.csv",
          seen and seen[0].endswith("/2025/01/2025-01-zensu.csv"),
          seen[0] if seen else "(呼ばれていない)")
    check("第10週は /2025/10/2025-10-zensu.csv",
          len(seen) > 1 and seen[1].endswith("/2025/10/2025-10-zensu.csv"),
          seen[1] if len(seen) > 1 else "(呼ばれていない)")


def _seen_urls(calls: list[tuple[int, int]]) -> list[str]:
    """F.fetch を叩いて、実際に要求されたURLだけを回収する（通信はしない）。"""
    seen: list[str] = []

    class FakeRes:
        def read(self) -> bytes:
            return b""

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        seen.append(req.full_url)
        return FakeRes()

    with mock.patch("urllib.request.urlopen", fake_urlopen):
        for y, w in calls:
            F.fetch(y, w)
    return seen


def test_url_legacy_generation() -> None:
    """2022年以前は旧系統（/niid/images/idwr/sokuho/...）を叩くこと。"""
    u = F.build_url(2022, 42)
    check("旧系統: 2022年第42週のパス",
          u == "https://id-info.jihs.go.jp/niid/images/idwr/sokuho"
               "/idwr-2022/202242/2022-42-zensu.csv", u)

    u1 = F.build_url(2021, 1)
    check("旧系統: 第1週もディレクトリ・ファイル名ともゼロ埋め",
          u1.endswith("/idwr-2021/202101/2021-01-zensu.csv"), u1)

    check("旧系統: 収録最古 2012年第37週",
          F.build_url(2012, 37).endswith("/idwr-2012/201237/2012-37-zensu.csv"),
          F.build_url(2012, 37))

    # fetch() 経由でも同じURLが出ること（build_url を素通りしていないか）
    seen = _seen_urls([(2022, 42)])
    check("旧系統: fetch() が build_url を使っている",
          seen and seen[0] == u, seen[0] if seen else "(呼ばれていない)")


def test_url_boundary_2023() -> None:
    """2023年第1週で新旧が切り替わること。"""
    legacy = F.build_url(2022, 52)
    current = F.build_url(2023, 1)
    check("2022年第52週は旧系統", "/niid/images/idwr/sokuho/" in legacy, legacy)
    check("2023年第1週は新系統", "/surveillance/idwr/provisional/" in current, current)
    check("2023年第1週のパス",
          current.endswith("/provisional/2023/01/2023-01-zensu.csv"), current)
    check("2026年は新系統のまま",
          "/surveillance/idwr/provisional/" in F.build_url(2026, 33),
          F.build_url(2026, 33))
    check("新旧で系統が重ならない",
          ("/niid/" in legacy) and ("/niid/" not in current))


def test_url_earliest_guard() -> None:
    """収録開始（2012年第37週）より前は、そもそもリクエストしないこと。"""
    seen = _seen_urls([(2012, 36), (2011, 52), (2012, 37)])
    check("2012年第36週は叩かない",
          not any("2012-36" in u for u in seen), repr(seen))
    check("2011年は叩かない",
          not any("/idwr-2011/" in u for u in seen), repr(seen))
    check("2012年第37週は叩く",
          any(u.endswith("/2012-37-zensu.csv") for u in seen), repr(seen))
    check("ガードに掛かった週は None を返す", F.fetch(2012, 36) is None)


def test_to_int() -> None:
    check("to_int: 通常", F.to_int("123") == 123)
    check("to_int: カンマ区切り", F.to_int("1,234") == 1234)
    check("to_int: 全角数字", F.to_int("１２") == 12)
    check("to_int: ハイフン/空欄は None",
          F.to_int("-") is None and F.to_int("") is None and F.to_int("－") is None)


def test_garbage_returns_none() -> None:
    check("期間が読めないCSVは None",
          F.parse("なにか,別のCSV\r1,2\r") is None)
    check("空文字は None", F.parse("") is None)


def main() -> int:
    tests = [
        ("期間の抽出", test_period),
        ("指標の抽出", test_metrics),
        ("改行コード", test_newline_variants),
        ("A型肝炎の表記ゆれ", test_halfwidth_hepatitis),
        ("サル痘エイリアス", test_monkeypox_alias),
        ("週次見出しの表記ゆれ", test_week_label_variants),
        ("列位置の非依存", test_column_shift),
        ("URLのゼロ埋め", test_url_zero_padding),
        ("旧系統URLの生成", test_url_legacy_generation),
        ("2023年のURL体系の境界", test_url_boundary_2023),
        ("収録開始より前のガード", test_url_earliest_guard),
        ("to_int", test_to_int),
        ("壊れた入力", test_garbage_returns_none),
    ]
    for title, fn in tests:
        print(f"\n[{title}]")
        try:
            fn()
        except Exception as e:  # パーサが例外で落ちるのも失敗として扱う
            print(f"  FAIL {title}: {type(e).__name__}: {e}")
            FAILURES.append(title)

    print()
    if FAILURES:
        print(f"NG: {len(FAILURES)} 件失敗 -> {', '.join(FAILURES)}")
        return 1
    print("OK: すべて通過")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
