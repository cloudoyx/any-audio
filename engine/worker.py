#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地歌声合成 worker：一行 JSON 进、一行 JSON 出，走 stdin/stdout 管道。

用法：
    python -X utf8 worker.py <声库目录> [auto|cpu|cuda]

一个进程只跑一种设备（A.7 第 8 条：同进程先 GPU 后 CPU 会串用），设备由启动参数
固定。调用方先读到一行 ready，再按需写入任务行；每次写入读回一行结果；写完发
shutdown。stderr 由调用方继承（不接管道），库的进度日志都走 stderr，stdout 只留协议行。

协议行：
    worker → 调用方  {"type":"ready","device":"cpu","sampleRate":44100,...}
    调用方 → worker  {"op":"sing","id":1,"notes":[[秒,时长,MIDI|null,歌词],...],
                      "out":"...","maxSeconds":300,"speaker":"..."}
    worker → 调用方  {"type":"result","id":1,"ok":true,"seconds":...,"notes":...,...}
    worker → 调用方  {"type":"result","id":1,"ok":false,"kind":"param|infer","error":"..."}
    调用方 → worker  {"op":"shutdown"}
"""
import json
import sys
import traceback
from pathlib import Path

# 派生 venv 的 site-packages 必须排在共享运行时之前，否则装进 venv 的显卡版
# onnxruntime 会被基础运行时的 CPU 版盖住（附录 B.7 第 6 条）。
_site = Path(sys.prefix) / "Lib" / "site-packages"
if _site.is_dir():
    sys.path.insert(0, str(_site))
# 无论从哪个工作目录启动，都能找到同目录的 score.py。
_engine_dir = str(Path(__file__).resolve().parent)
if _engine_dir not in sys.path:
    sys.path.insert(0, _engine_dir)

# stdout 只留给协议行；三方库里的 print 全部改道 stderr。
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

from score import ScoreConverter  # noqa: E402

MIDI_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def send(payload):
    _PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def prepare_device(requested):
    """按请求挑推理设备；显卡不可用（没装 onnxruntime-gpu / CUDA）就退回 CPU。"""
    if requested not in ("auto", "cuda"):
        return "cpu"
    try:
        import onnxruntime as ort
    except Exception as exc:
        print(f"onnxruntime 载入失败，改用 CPU：{exc}", file=sys.stderr)
        return "cpu"
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        print("没有 CUDA provider，改用 CPU", file=sys.stderr)
        return "cpu"
    return "cuda"


def force_basic_optimization(device):
    """把 ORT 图优化降到 basic 并接管 provider。

    绮萱的声学模型在 extended/all 优化级别会原生崩溃，basic 正常；device=cuda 时
    给每个 session 挂 CUDA provider，首次建 session 失败就退回 CPU。
    """
    import onnxruntime as ort

    original = ort.InferenceSession
    state = {"device": "cuda" if device == "cuda" else "cpu"}

    def session(path_or_bytes, sess_options=None, **kwargs):
        options = sess_options or ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        if state["device"] == "cuda":
            try:
                return original(
                    path_or_bytes,
                    sess_options=options,
                    providers=[
                        ("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
                        "CPUExecutionProvider",
                    ],
                )
            except Exception as exc:
                print(f"CUDA 推理不可用，回退 CPU：{exc}", file=sys.stderr)
                state["device"] = "cpu"
        return original(path_or_bytes, sess_options=options, providers=["CPUExecutionProvider"])

    ort.InferenceSession = session
    return state


def normalize_bank_text(bank_dir):
    """把声库元数据修成推理库能读的样子：非 UTF-8 的 character 文件转 UTF-8，
    并给老版 OpenUtau 的 subbanks 补齐必需字段。"""
    bank = Path(bank_dir)
    for name in ("character.yaml", "character.txt"):
        path = bank / name
        if not path.is_file():
            continue
        raw = path.read_bytes()
        try:
            raw.decode("utf-8")
            continue
        except UnicodeDecodeError:
            pass
        for encoding in ("cp932", "shift_jis", "gbk"):
            try:
                path.write_text(raw.decode(encoding), encoding="utf-8")
                print(f"声库元数据 {name} 从 {encoding} 转为 UTF-8", file=sys.stderr)
                break
            except (UnicodeDecodeError, UnicodeEncodeError):
                continue

    path = bank / "character.yaml"
    if not path.is_file():
        return
    import yaml

    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        print(f"character.yaml 解析失败：{exc}", file=sys.stderr)
        return
    subbanks = data.get("subbanks") or []
    need = {"color", "prefix", "suffix", "tone_ranges"}
    if subbanks and any(not need.issubset(bank) for bank in subbanks):
        data["subbanks"] = [
            {
                "color": b.get("color", ""),
                "prefix": b.get("prefix", ""),
                "suffix": b.get("suffix", ""),
                "tone_ranges": b.get("tone_ranges") or [],
            }
            for b in subbanks
        ]
        path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


WARMUP_NOTES = [[0.0, 1.0, 60, "啊"]]


class Singer:
    """加载一个声库、按外部音符合成歌声。曲谱转换委托给 score.py。"""

    def __init__(self, voicebank_dir, device="cpu"):
        self.bank = Path(voicebank_dir)
        self.requested_device = device
        self.device_state = {"device": device if device in ("cpu", "cuda") else "cpu"}
        self.pred = None
        self.converter = None
        self.sample_rate = 44100

    def load(self):
        normalize_bank_text(self.bank)
        self.device_state = force_basic_optimization(self.requested_device)
        from diffsinger_utau.voice_bank import PredAll

        self.pred = PredAll(self.bank)
        self.sample_rate = int(self.pred.dsvocoder.sample_rate)
        self.converter = ScoreConverter.from_voicebank(self.bank)
        speakers = list(getattr(self.pred, "available_speakers", None) or [])
        return {"speakers": speakers, "sampleRate": self.sample_rate,
                "device": self.device_state["device"]}

    def _pick_lang(self, lang):
        content = getattr(getattr(getattr(self.pred, "dsvariance", None), "languages", None), "content", None)
        if content and lang not in content:
            return next(iter(content))
        return lang

    def _resolve_speaker(self, wanted):
        names = list(getattr(self.pred, "available_speakers", None) or [])
        if wanted:
            for name in names:
                if str(name).split("_")[-1].lower() == str(wanted).lower():
                    return name
            return wanted
        return names[0] if names else None

    def sing(self, task):
        from diffsinger_utau.voice_bank.commons.ds_reader import DSReader

        score = task.get("notes")
        if not score:
            raise ValueError("缺少 notes：本引擎只接受外部音符，按指定旋律演唱")
        max_seconds = float(task.get("maxSeconds") or 60)
        ds, notes, text, lang = self.converter.convert(score, max_seconds)
        if not notes:
            raise ValueError("没有可唱的音符：歌词需为声库音素表里查得到读音的汉字")
        section = DSReader.DSSection(ds)

        out = Path(task["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        work = out.parent / (out.stem + ".work")
        work.mkdir(parents=True, exist_ok=True)
        results = self.pred.predict_full_pipeline(
            ds=section,
            lang=self._pick_lang(lang),
            speaker=self._resolve_speaker(task.get("speaker")),
            key_shift=0,
            pitch_steps=int(task.get("pitchSteps") or 10),
            variance_steps=int(task.get("varianceSteps") or 10),
            acoustic_steps=int(task.get("acousticSteps") or 40),
            gender=float(task.get("gender") or 0),
            output_dir=str(work),
            save_intermediate=False,
        )
        produced = Path(results["audio_path"])
        if not produced.exists():
            raise RuntimeError(f"声码器没有写出音频：{produced}")
        import os
        os.replace(produced, out)
        for leftover in work.glob("*.ds"):
            leftover.unlink(missing_ok=True)
        try:
            work.rmdir()
        except OSError:
            pass
        seconds = len(results["wav"]) / float(self.sample_rate)
        return {
            "seconds": round(seconds, 3),
            "notes": len(notes),
            "sungChars": len(text),
            "lang": lang,
            "sampleRate": self.sample_rate,
            "text": text,
        }


def warmup(singer):
    """显卡档首次建 CUDA session 的一次性开销挪到启动阶段。"""
    import tempfile
    import shutil

    work = Path(tempfile.mkdtemp(prefix="singing-warmup-"))
    try:
        singer.sing({"notes": WARMUP_NOTES, "maxSeconds": 2, "out": str(work / "warmup.wav")})
        print("显卡热身完成", file=sys.stderr)
    except Exception as exc:
        print(f"热身没唱成（不影响就绪）：{exc}", file=sys.stderr)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv):
    if len(argv) < 2:
        send({"type": "fatal", "error": "用法：worker.py <声库目录> [auto|cpu|cuda]"})
        return 2
    bank = Path(argv[1])
    if not bank.is_dir():
        send({"type": "fatal", "error": f"声库目录不存在：{bank}"})
        return 2
    requested = argv[2] if len(argv) > 2 else "auto"

    singer = Singer(bank, requested)
    try:
        info = singer.load()
    except Exception as exc:
        send({"type": "fatal", "error": f"声库加载失败：{exc}"})
        traceback.print_exc()
        return 1
    if singer.device_state["device"] == "cuda":
        warmup(singer)
    send({"type": "ready", "voicebank": bank.name, "speakers": info["speakers"],
          "sampleRate": info["sampleRate"], "device": singer.device_state["device"]})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            send({"type": "result", "ok": False, "kind": "param", "error": f"协议行不是 JSON：{exc}"})
            continue
        if msg.get("op") == "shutdown":
            return 0
        if msg.get("op") != "sing":
            send({"type": "result", "id": msg.get("id"), "ok": False,
                  "kind": "param", "error": f"未知 op：{msg.get('op')}"})
            continue
        try:
            stats = singer.sing(msg)
            send({"type": "result", "id": msg.get("id"), "ok": True, **stats})
        except Exception as exc:
            traceback.print_exc()
            kind = "param" if isinstance(exc, ValueError) else "infer"
            send({"type": "result", "id": msg.get("id"), "ok": False,
                  "kind": kind, "error": str(exc) or exc.__class__.__name__})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
