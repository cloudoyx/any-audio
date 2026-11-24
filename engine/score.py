# -*- coding: utf-8 -*-
"""外部音符 → DiffSinger 曲谱段落的转换。

输入音符四字段：[起始秒, 时长秒, 音高(MIDI 或 null), 歌词]。
只做中文：整串查拼音消歧多音字，按字取音素；声母前移到上一个音符末尾、
韵母占满本音符；浊响音（m/n/l/r/y/w）留在音符开头；拖腔标连音；
按休止切句并把每句时间轴归零（句间靠分段 + 段首短休止形成气口）。

依赖公开约定：pypinyin 查拼音，声库自带的 dsdict-zh.yaml 提供权威拼音→音素映射，
diffsinger-utau 的 opencpop 词典作为兜底，*.phonemes.json 提供合法音素表。
依赖均可注入，便于不加载推理模型单测。
"""
import json
import re
from pathlib import Path

HAN = re.compile(r"[\u4e00-\u9fff]")
HAN_RUN = re.compile(r"[\u4e00-\u9fff]+")
# 英文词：允许撇号（don't / we're）与弯撇号
LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z'\u2019]*")
# 联合分词：单个汉字 或 一个英文词，保持歌词里的原始顺序
TOKEN = re.compile(r"[\u4e00-\u9fff]|[A-Za-z][A-Za-z'\u2019]*")
SONORANTS = {"m", "n", "l", "r", "y", "w"}
MIDI_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
LEADING_REST_SEC = 0.15
GAP_EPS = 1e-3


def midi_to_name(midi):
    return f"{MIDI_NAMES[midi % 12]}{midi // 12 - 1}"


def default_pinyin_fn(run):
    """连续汉字串 → 每个字的无声调拼音。pypinyin 不可用时返回空串，让调用方跳过。"""
    try:
        from pypinyin import pinyin, Style
    except ImportError:
        return [""] * len(run)
    return [item[0] for item in pinyin(run, style=Style.NORMAL)]


class ScoreConverter:
    """把外部音符转换为 DS 段落。音素表/拼音词典/拼音函数都可注入。"""

    def __init__(self, phoneme_set, pinyin_dict, pinyin_fn=None, word_dict=None):
        self.phoneme_set = set(phoneme_set)
        self.pinyin_dict = pinyin_dict
        # 英文词 → 音素（dsdict-en.yaml，268k 条）。空字典表示声库不支持英文。
        self.word_dict = word_dict or {}
        self._pinyin = pinyin_fn or default_pinyin_fn

    @classmethod
    def from_voicebank(cls, voicebank_dir, pinyin_fn=None):
        """从声库目录装配：读音素表 + 声库权威拼音词典（缺时回退 opencpop）。"""
        bank = Path(voicebank_dir)
        tables = sorted(bank.glob("*.phonemes.json"))
        if not tables:
            raise FileNotFoundError(f"声库里没有 *.phonemes.json：{bank}")
        info = json.loads(tables[0].read_text(encoding="utf-8"))
        phoneme_set = set(info.keys()) if isinstance(info, dict) else set(info)

        from diffsinger_utau.voice_bank.commons.ds_reader import DSTextReplacer
        pinyin_dict = dict(DSTextReplacer().opencpop_dict)
        # 声库自带的 dsdict-zh.yaml 才是权威读音表：opencpop 的 yan/ye 写成
        # y En / y E，绮萱音素表里没有 En/E（只有 ian/ie），整字会哑。用声库
        # 字典覆盖：601 条读音与全量 yaml 解析一致，行扫描 ~0.18s（yaml 全量要 5s）。
        bank_dict = cls._load_bank_pinyin_dict(bank)
        pinyin_dict.update(bank_dict)
        word_dict = cls._load_bank_word_dict(bank)
        return cls(phoneme_set, pinyin_dict, pinyin_fn, word_dict)

    @staticmethod
    def _load_bank_pinyin_dict(bank):
        """从 dsdict-zh.yaml 轻量提取 拼音 → [音素]，只认纯小写拼音条目。"""
        for candidate in (Path(bank) / "dsdur" / "dsdict-zh.yaml", Path(bank) / "dsdict-zh.yaml"):
            if not candidate.is_file():
                continue
            result = {}
            current = None
            with candidate.open(encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("- grapheme: "):
                        key = line[len("- grapheme: "):].strip()
                        if re.fullmatch(r"[a-z]{1,7}", key) and key not in result:
                            current = key
                            result[current] = []
                        else:
                            current = None
                    elif current is not None and line.startswith("  - "):
                        result[current].append(line[4:].strip())
            if result:
                return result
        return {}

    @staticmethod
    def _load_bank_word_dict(bank):
        """从 dsdur/dsdict-en.yaml 提取 英文词 → [音素]。

        与中文词典同一套行扫描；键是小写英文词（允许撇号），值是 en/* 音素。
        声库没有这份词典时返回空字典，英文歌词会明确报错而不是静默哑掉。
        """
        for candidate in (Path(bank) / "dsdur" / "dsdict-en.yaml", Path(bank) / "dsdict-en.yaml"):
            if not candidate.is_file():
                continue
            result = {}
            current = None
            with candidate.open(encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("- grapheme: "):
                        key = line[len("- grapheme: "):].strip().lower()
                        if re.fullmatch(r"[a-z][a-z'\u2019-]{0,31}", key) and key not in result:
                            current = key
                            result[current] = []
                        else:
                            current = None
                    elif current is not None and line.startswith("  - "):
                        result[current].append(line[4:].strip())
            if result:
                return result
        return {}

    # ---------- 拼音 → 音素 ----------

    def phrase_readings(self, run):
        return self._pinyin(run)

    def map_phonemes(self, raw):
        """裸音素按语言前缀补齐并对照声库音素表；有一个查不到就整字不唱。"""
        if self.phoneme_set is None:
            return list(raw)
        mapped = []
        for phoneme in raw:
            if phoneme in self.phoneme_set:
                mapped.append(phoneme)
                continue
            for prefix in ("zh/", "en/", "ja/"):
                if prefix + phoneme in self.phoneme_set:
                    mapped.append(prefix + phoneme)
                    break
            else:
                return []
        return mapped

    def phonemes_from_reading(self, reading):
        if not reading:
            return []
        raw = self.pinyin_dict.get(reading)
        if not raw:
            return []
        # 声库字典的值可能是 list（权威）或空格串（opencpop 兜底）。
        phones = raw.split() if isinstance(raw, str) else list(raw)
        return self.map_phonemes(phones)

    def phonemes_from_word(self, word):
        """英文词 → 音素。整词查 dsdict-en；查不到返回空列表，由调用方报错。"""
        if not word:
            return []
        raw = self.word_dict.get(word.lower())
        if not raw:
            return []
        return self.map_phonemes(raw)

    @staticmethod
    def split_onset(phones):
        """音素串 → (声母, 韵母)。中文音节最后一个音素是韵母，前面都算声母。"""
        if len(phones) <= 1:
            return [], list(phones)
        return list(phones[:-1]), [phones[-1]]

    @staticmethod
    def is_sonorant(phoneme):
        return phoneme.split("/")[-1] in SONORANTS

    # ---------- 音符 → 音节 → DS 段落 ----------

    @staticmethod
    def _parse_items(score):
        items = []
        for raw in score:
            if not isinstance(raw, (list, tuple)) or len(raw) < 3:
                raise ValueError(f"音符格式不对：{raw!r}，应为 [起始秒, 时长秒, 音高, 歌词]")
            start, dur = float(raw[0]), float(raw[1])
            midi = raw[2]
            lyric = str(raw[3]).strip() if len(raw) > 3 and raw[3] is not None else ""
            if dur <= 0:
                raise ValueError(f"音符时长必须大于 0：{raw!r}")
            items.append((start, dur, midi, lyric))
        items.sort(key=lambda item: item[0])
        return items

    def _readings_by_index(self, items):
        """整串查拼音，按音符索引归集——多音字只能靠上下文消歧。"""
        chars = []
        for index, (_, _, _, lyric) in enumerate(items):
            chars.extend((index, ch) for ch in HAN.findall(lyric))
        run = "".join(ch for _, ch in chars)
        readings = self.phrase_readings(run) if run else []
        at = {}
        for (index, _), reading in zip(chars, readings):
            at.setdefault(index, []).append(reading)
        return at

    @staticmethod
    def _rest(dur):
        return {"notes": [(None, round(dur, 4))], "onset": [], "final": [], "rest": True}

    @staticmethod
    def _has_sung(syllables):
        return any(not s["rest"] for s in syllables)

    def _syllables(self, items, reading_at):
        """第一遍：拆音节。一个音节 = 一个词，可能跨多个音符（拖腔）。

        中英混排时按歌词里的原始顺序取词：汉字走拼音读音，英文词走整词查表。
        """
        syllables, text = [], []
        has_latin = False
        cursor = 0.0
        for index, (start, dur, midi, lyric) in enumerate(items):
            if start > cursor + GAP_EPS:
                syllables.append(self._rest(start - cursor))
                cursor = start
            if midi is None or (not lyric and not self._has_sung(syllables)):
                syllables.append(self._rest(dur))
                cursor = start + dur
                continue
            if not lyric:
                # 拖腔：并入上一个音节的音符，不新增词
                if syllables and not syllables[-1]["rest"]:
                    syllables[-1]["notes"].append((int(midi), round(dur, 4)))
                cursor = start + dur
                continue
            units = []
            readings = list(reading_at.get(index, []))
            han_seen = 0
            for match in TOKEN.finditer(lyric):
                tok = match.group(0)
                latin = not HAN.fullmatch(tok)
                if latin:
                    phones = self.phonemes_from_word(tok)
                    has_latin = has_latin or bool(phones)
                else:
                    reading = readings[han_seen] if han_seen < len(readings) else ""
                    han_seen += 1
                    phones = self.phonemes_from_reading(reading)
                if phones:
                    units.append((tok, phones, latin))
            if not units:
                raise ValueError(f"「{lyric}」没有可唱的音素（声库音素表里查不到读音）")
            step = dur / len(units)
            for grapheme, phones, latin in units:
                if latin:
                    # 英文音节不做中文的「声母前移」：整个词的音素留在本音符
                    onset, final = [], list(phones)
                else:
                    onset, final = self.split_onset(phones)
                syllables.append({
                    "notes": [(int(midi), round(step, 4))],
                    "onset": onset,
                    "final": final,
                    "rest": False,
                })
                text.append(grapheme)
            cursor = start + dur
        return syllables, text, has_latin

    def build_from_score(self, score, max_seconds=300):
        """外部音符 → (notes, text, lang)。"""
        items = self._parse_items(score)
        if not items:
            return [], "", "zh"
        reading_at = self._readings_by_index(items)
        syllables, text, has_latin = self._syllables(items, reading_at)

        # 首字的清声母前面补一个短休止，否则它会挤占第一个音符的时长；
        # 浊响音本身带音高，留在本音符开头即可。
        first = next((i for i, s in enumerate(syllables) if not s["rest"]), None)
        if first is not None and syllables[first]["onset"] and not all(
            self.is_sonorant(p) for p in syllables[first]["onset"]
        ):
            syllables.insert(first, self._rest(LEADING_REST_SEC))

        # 第二遍：每个词 = 自己的韵母 + 下一个字的清声母（浊响音留在下一个字开头）
        for i, syl in enumerate(syllables):
            word = ["SP"] if syl["rest"] else list(syl["onset"]) + list(syl["final"])
            for nxt in syllables[i + 1:]:
                if nxt["rest"]:
                    continue
                if nxt["onset"] and not all(self.is_sonorant(p) for p in nxt["onset"]):
                    word = word + nxt["onset"]
                    nxt["onset"] = []
                break
            syl["word"] = word

        # 第三遍：铺成音符。一个音节跨多个音符时只有第一个带音素，其余标连音。
        notes = []
        for syl in syllables:
            for k, (midi, dur) in enumerate(syl["notes"]):
                notes.append({
                    "phones": syl["word"] if k == 0 else [],
                    "midi": midi,
                    "dur": dur,
                    "rest": midi is None,
                    "slur": 0 if k == 0 else 1,
                })

        # 超长按音符边界截断，并去掉结尾休止
        total, kept = 0.0, []
        for note in notes:
            if total + note["dur"] > max_seconds:
                break
            kept.append(note)
            total += note["dur"]
        while kept and kept[-1]["rest"]:
            kept.pop()
        lang = "en" if has_latin else "zh"
        return kept, " ".join(text) if has_latin else "".join(text), lang

    def build_ds(self, notes, text, lang="zh"):
        """内部音符 → DS 段落字段。ph_num 按词不按音符，连音音符不占 ph_num。"""
        ph_seq, ph_num = [], []
        note_seq, note_dur, note_slur = [], [], []
        for note in notes:
            if not note.get("slur"):
                ph_seq.extend(note["phones"])
                ph_num.append(len(note["phones"]))
            note_seq.append("rest" if note["rest"] else midi_to_name(note["midi"]))
            note_dur.append(round(note["dur"], 4))
            note_slur.append(int(note.get("slur", 0)))
        return {
            "offset": 0,
            "text": text,
            "lang": lang,
            "ph_seq": " ".join(ph_seq),
            "ph_num": " ".join(str(n) for n in ph_num),
            "note_seq": " ".join(note_seq),
            "note_slur": " ".join(str(s) for s in note_slur),
            "note_dur": " ".join(str(d) for d in note_dur),
        }

    def convert(self, score, max_seconds=300):
        notes, text, lang = self.build_from_score(score, max_seconds)
        return self.build_ds(notes, text, lang), notes, text, lang


def split_phrases(score):
    """按休止（音高为 null）切句，每句时间轴归零。

    休止音符作为分隔符不进任何一段；句尾靠分段 + 段首前导短休止形成气口，
    句与句因此不粘连（唯一模式：按句分段）。
    """
    phrases, current = [], []
    for raw in score:
        midi = raw[2] if isinstance(raw, (list, tuple)) and len(raw) >= 3 else None
        if midi is None:
            if current:
                phrases.append(current)
                current = []
            continue
        current.append(raw)
    if current:
        phrases.append(current)

    result = []
    for phrase in phrases:
        base = float(phrase[0][0])
        local = [
            [round(float(n[0]) - base, 4), n[1], n[2], n[3] if len(n) > 3 else ""]
            for n in phrase
        ]
        result.append(local)
    return result
