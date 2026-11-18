# -*- coding: utf-8 -*-
"""engine/score.py 读音映射单测（t14 Bug A）。

覆盖：声库自带 dsdict-zh.yaml 覆盖 opencpop 的 yan/ye 错误读音；
全量 603 读音用正式声库音素表校验零不匹配（正式环境存在时）。
不联网。运行：<formal python> -X utf8 test/singing-score.py
"""
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "engine"))
from score import ScoreConverter  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok   {name}")
    else:
        FAIL += 1
        print(f"FAIL {name}  {detail}")


with tempfile.TemporaryDirectory() as tmp:
    bank = Path(tmp)
    (bank / "dsdur").mkdir(parents=True, exist_ok=True)
    phones = {"AP": 1, "SP": 2, "zh/y": 3, "zh/ian": 4, "zh/ie": 5, "zh/in": 6}
    (bank / "test.phonemes.json").write_text(json.dumps(phones), encoding="utf-8")
    (bank / "dsdur" / "dsdict-zh.yaml").write_text(
        "- grapheme: yan\n  phonemes:\n  - zh/y\n  - zh/ian\n"
        "- grapheme: ye\n  phonemes:\n  - zh/y\n  - zh/ie\n"
        "- grapheme: yin\n  phonemes:\n  - zh/y\n  - zh/in\n",
        encoding="utf-8",
    )
    loaded = ScoreConverter._load_bank_pinyin_dict(bank)
    check("浅解析声库字典 yan/ye", loaded.get("yan") == ["zh/y", "zh/ian"] and loaded.get("ye") == ["zh/y", "zh/ie"], str(loaded))

    # 复现 bug：opencpop 的 yan/ye 错误，声库字典覆盖后应纠正。
    opencpop = {"yan": "y En", "ye": "y E", "yin": "y in"}
    opencpop.update(loaded)
    conv = ScoreConverter(set(phones.keys()), opencpop)
    check("yan 读音映射为 y+ian", conv.phonemes_from_reading("yan") == ["zh/y", "zh/ian"], str(conv.phonemes_from_reading("yan")))
    check("ye 读音映射为 y+ie", conv.phonemes_from_reading("ye") == ["zh/y", "zh/ie"], str(conv.phonemes_from_reading("ye")))
    check("yin 读音保持", conv.phonemes_from_reading("yin") == ["zh/y", "zh/in"], str(conv.phonemes_from_reading("yin")))
    # 无字典时未知读音返回空——证明声库字典是必要修复，不是可有可无。
    fallback = ScoreConverter(set(phones.keys()), {"yan": "y En", "ye": "y E"})
    check("无字典时未知读音不臆造音素", fallback.phonemes_from_reading("yan") == [], "must not invent phonemes")

# 全量扫描（正式环境存在时）
FORMAL_BANK = Path.home() / ".dsh" / "anyaudio" / "singing" / "voicebank" / "Qixuan_v2.7.0_DiffSinger_OpenUtau"
if (FORMAL_BANK / "dsconfig.yaml").is_file():
    try:
        conv = ScoreConverter.from_voicebank(FORMAL_BANK)
        from diffsinger_utau.voice_bank.commons.ds_reader import DSTextReplacer
        op = dict(DSTextReplacer().opencpop_dict)
        bank_map = ScoreConverter._load_bank_pinyin_dict(FORMAL_BANK)
        miss = []
        for reading in op:
            chosen = bank_map.get(reading) or op[reading].split()
            for p in chosen:
                if p not in conv.phoneme_set and "zh/" + p not in conv.phoneme_set:
                    miss.append((reading, p))
                    break
        check(f"全量 {len(op)} 读音零不匹配（正式声库音素表）", len(miss) == 0, str(miss[:8]))
    except Exception as exc:  # noqa: BLE001
        print(f"SKIP 全量扫描（依赖不可用）：{exc}")

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
