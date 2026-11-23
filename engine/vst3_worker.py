#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""VST3 音源渲染 worker：一行 JSON 进、一行 JSON 出，走 stdin/stdout 管道。

用法：
    python -X utf8 vst3_worker.py
    python -X utf8 vst3_worker.py --selftest

协议行：
    worker → 调用方  {"type":"ready","sampleRate":48000}
    调用方 → worker  {"op":"render","id":N,"plugin":"...","notes":[
                        {"pitch":60,"start":0.0,"dur":0.5,"vel":100},...],
                      "duration":4.0,"out":"...wav"}
    worker → 调用方  {"type":"result","id":N,"ok":true,"peak":0.79,"seconds":4.0}
    worker → 调用方  {"type":"result","id":N,"ok":false,"kind":"param|load|render","error":"..."}
    调用方 → worker  {"op":"shutdown"}

Windows 的 .vst3 是目录包，pedalboard 只认内层 DLL；传目录或 DLL 都行，这里自己找。
Ample 系列采样器是流式加载，刚加载就渲染会静音：先预热到有声，再正式渲染。
"""
import json
import os
import sys
import traceback
import wave
from pathlib import Path

import numpy as np

# stdout 只留给协议行；三方库里的 print 全部改道 stderr。
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr
# 协议行固定 UTF-8，不受调用方是否带 -X utf8 影响。
for _stream in (_PROTOCOL_OUT, sys.stdin):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

try:
    from mido import Message
except ImportError as _mido_error:  # 缺依赖时按 load 错误上报，不让进程直接崩
    Message = None
    _MIDO_ERROR = _mido_error

SAMPLE_RATE = 48000
BUFFER_SIZE = 8192
SILENCE_PEAK = 0.001
MAX_SECONDS = 600.0
WARMUP_ATTEMPTS = 8
WARMUP_SECONDS = 2.5
FLUSH_SECONDS = 2.0

# 实测音域（MIDI）：超出会静音，提前拦下比渲染出空文件好。
PLUGIN_RANGES = {
    "abpl": (40, 72),
    "agml": (42, 84),
}

SELFTEST_PLUGIN = r"C:\Program Files\Common Files\VST3\ABPL.vst3\Contents\x86_64-win\ABPL.vst3"
SELFTEST_NOTES = [
    {"pitch": 40, "start": 0.0, "dur": 0.45, "vel": 100},
    {"pitch": 43, "start": 0.5, "dur": 0.45, "vel": 100},
    {"pitch": 45, "start": 1.0, "dur": 0.45, "vel": 100},
    {"pitch": 47, "start": 1.5, "dur": 0.45, "vel": 100},
]


class WorkerError(Exception):
    """带错误类别的协议错误：param 请求有误，load 插件加载失败，render 渲染失败。"""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def send(payload):
    _PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _peak(audio):
    if audio.size == 0:
        return 0.0
    return float(np.abs(audio).max())


def resolve_plugin_path(raw):
    """把调用方给的路径落到 pedalboard 能加载的文件上。

    Windows 的 .vst3 是目录包，pedalboard 只认 Contents/x86_64-win 里的 DLL，
    所以目录包要往里找一层；直接给 DLL 也接受。
    """
    path = Path(raw)
    if path.is_file():
        return path
    if path.is_dir():
        inner = path / "Contents" / "x86_64-win"
        candidates = sorted(inner.glob("*.vst3")) if inner.is_dir() else []
        if candidates:
            return candidates[0]
        raise WorkerError("load", f"VST3 目录包里找不到 x86_64-win 插件：{path}")
    raise WorkerError("load", f"插件路径不存在：{path}")


def plugin_range(path):
    name = path.name.lower()
    for key, bounds in PLUGIN_RANGES.items():
        if key in name:
            return bounds
    return None


def check_range(path, notes):
    bounds = plugin_range(path)
    if not bounds:
        return
    low, high = bounds
    bad = sorted({note["pitch"] for note in notes if not low <= note["pitch"] <= high})
    if bad:
        raise WorkerError(
            "param",
            f"音高超出 {path.stem} 的实测音域 MIDI {low}-{high}：{bad}（超出会静音）",
        )


def parse_notes(raw, duration):
    if not isinstance(raw, list) or not raw:
        raise WorkerError("param", "notes 必须是非空数组")
    notes = []
    for index, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise WorkerError("param", f"第 {index} 个音符不是对象")
        pitch = item.get("pitch")
        if not isinstance(pitch, int) or isinstance(pitch, bool) or not 0 <= pitch <= 127:
            raise WorkerError("param", f"第 {index} 个音符 pitch 必须是 0-127 的整数")
        start = item.get("start", 0.0)
        if not _number(start) or start < 0:
            raise WorkerError("param", f"第 {index} 个音符 start 必须是不小于 0 的秒数")
        dur = item.get("dur")
        if not _number(dur) or dur <= 0:
            raise WorkerError("param", f"第 {index} 个音符 dur 必须是大于 0 的秒数")
        vel = item.get("vel", 100)
        if not isinstance(vel, int) or isinstance(vel, bool) or not 0 <= vel <= 127:
            raise WorkerError("param", f"第 {index} 个音符 vel 必须是 0-127 的整数")
        if start >= duration:
            raise WorkerError("param", f"第 {index} 个音符 start={start} 超出渲染时长 {duration}")
        notes.append({"pitch": pitch, "start": float(start), "dur": float(dur), "vel": vel})
    return notes


def write_wav(path, audio):
    if audio.ndim == 1:
        audio = np.stack([audio, audio])
    data = np.clip(audio.T, -1.0, 1.0)
    pcm = (data * 32767).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 先写临时文件再替换，避免失败时留下半个 WAV 被当成成品。
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with wave.open(str(tmp), "wb") as handle:
            handle.setnchannels(pcm.shape[1])
            handle.setsampwidth(2)
            handle.setframerate(SAMPLE_RATE)
            handle.writeframes(pcm.tobytes())
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


class PluginCache:
    """按路径缓存已加载并预热过的插件实例。"""

    def __init__(self):
        self._plugins = {}

    def get(self, path):
        key = str(path).lower()
        plugin = self._plugins.get(key)
        if plugin is None:
            plugin = self._load(path)
            self._plugins[key] = plugin
        return plugin

    def _load(self, path):
        if Message is None:
            raise WorkerError("load", f"mido 未安装：{_MIDO_ERROR}")
        try:
            from pedalboard import load_plugin
        except ImportError as exc:
            raise WorkerError("load", f"pedalboard 未安装：{exc}")
        try:
            plugin = load_plugin(str(path))
        except Exception as exc:
            raise WorkerError("load", f"VST3 加载失败：{exc}")
        if not getattr(plugin, "is_instrument", False):
            raise WorkerError("load", f"不是乐器插件：{path.name}")
        self._warmup(plugin, path)
        return plugin

    def _warmup(self, plugin, path):
        """采样器流式加载，刚加载就渲染会拿到静音；渲染到有声为止。"""
        bounds = plugin_range(path)
        pitch = bounds[0] if bounds else 60
        messages = [
            Message("note_on", note=pitch, velocity=100, time=0.1),
            Message("note_off", note=pitch, velocity=0, time=0.8),
        ]
        for attempt in range(1, WARMUP_ATTEMPTS + 1):
            audio = plugin(
                messages,
                duration=WARMUP_SECONDS,
                sample_rate=SAMPLE_RATE,
                buffer_size=BUFFER_SIZE,
                reset=False,
            )
            peak = _peak(audio)
            print(f"预热 {path.name} 第 {attempt} 次：峰值 {peak:.4f}", file=sys.stderr)
            if peak > SILENCE_PEAK:
                return
        raise WorkerError("load", f"{path.name} 预热 {WARMUP_ATTEMPTS} 次仍无声音，插件可能没有加载采样")


def render_audio(plugin, notes, duration):
    # reset=False 是采样器的要求，代价是插件内部状态会跨调用保留。先空跑一段，
    # 让上一段的尾音衰减掉，否则新片段开头会混进旧尾音，静音检测也会被它骗过。
    plugin(
        [],
        duration=FLUSH_SECONDS,
        sample_rate=SAMPLE_RATE,
        buffer_size=BUFFER_SIZE,
        reset=False,
    )
    messages = []
    for note in notes:
        messages.append(Message("note_on", note=note["pitch"], velocity=note["vel"], time=note["start"]))
        messages.append(Message("note_off", note=note["pitch"], velocity=0, time=note["start"] + note["dur"]))
    # 同一时刻先收上一个音再起新音，避免同音重触发被截断。
    messages.sort(key=lambda message: (message.time, 0 if message.type == "note_off" else 1))
    return plugin(
        messages,
        duration=duration,
        sample_rate=SAMPLE_RATE,
        buffer_size=BUFFER_SIZE,
        reset=False,
    )


def handle_render(cache, msg):
    plugin_raw = msg.get("plugin")
    if not isinstance(plugin_raw, str) or not plugin_raw.strip():
        raise WorkerError("param", "缺少 plugin：需要 VST3 路径")
    out_raw = msg.get("out")
    if not isinstance(out_raw, str) or not out_raw.strip():
        raise WorkerError("param", "缺少 out：需要 WAV 输出路径")
    duration = msg.get("duration")
    if not _number(duration) or duration <= 0:
        raise WorkerError("param", "duration 必须是大于 0 的秒数")
    if duration > MAX_SECONDS:
        raise WorkerError("param", f"duration 超过上限 {MAX_SECONDS:.0f} 秒")
    duration = float(duration)

    notes = parse_notes(msg.get("notes"), duration)
    path = resolve_plugin_path(plugin_raw)
    check_range(path, notes)
    plugin = cache.get(path)
    audio = render_audio(plugin, notes, duration)
    peak = _peak(audio)
    if not np.isfinite(peak) or peak < SILENCE_PEAK:
        raise WorkerError(
            "render",
            f"渲染结果全静音（峰值 {peak:.4f}）：检查音高是否在音域内、插件是否加载了采样",
        )
    try:
        write_wav(Path(out_raw), audio)
    except Exception as exc:
        raise WorkerError("render", f"写 WAV 失败：{exc}")
    return {"peak": round(peak, 4), "seconds": round(audio.shape[-1] / SAMPLE_RATE, 3)}


def selftest():
    import shutil
    import tempfile

    work = Path(tempfile.mkdtemp(prefix="vst3-selftest-"))
    try:
        result = handle_render(
            PluginCache(),
            {
                "plugin": SELFTEST_PLUGIN,
                "notes": SELFTEST_NOTES,
                "duration": 2.5,
                "out": str(work / "selftest.wav"),
            },
        )
        print(f"自检通过：峰值 {result['peak']:.4f}，时长 {result['seconds']} 秒", file=sys.stderr)
        _PROTOCOL_OUT.write("OK\n")
        _PROTOCOL_OUT.flush()
        return 0
    except Exception as exc:
        traceback.print_exc()
        print(f"自检失败：{exc}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv):
    if "--selftest" in argv[1:]:
        return selftest()

    send({"type": "ready", "sampleRate": SAMPLE_RATE})
    cache = PluginCache()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            send({"type": "result", "ok": False, "kind": "param", "error": f"协议行不是 JSON：{exc}"})
            continue
        if not isinstance(msg, dict):
            send({"type": "result", "ok": False, "kind": "param", "error": "协议行必须是 JSON 对象"})
            continue
        if msg.get("op") == "shutdown":
            return 0
        if msg.get("op") != "render":
            send({"type": "result", "id": msg.get("id"), "ok": False,
                  "kind": "param", "error": f"未知 op：{msg.get('op')}"})
            continue
        try:
            result = handle_render(cache, msg)
            send({"type": "result", "id": msg.get("id"), "ok": True, **result})
        except WorkerError as exc:
            if exc.kind != "param":
                traceback.print_exc()
            send({"type": "result", "id": msg.get("id"), "ok": False,
                  "kind": exc.kind, "error": str(exc)})
        except Exception as exc:
            traceback.print_exc()
            send({"type": "result", "id": msg.get("id"), "ok": False,
                  "kind": "render", "error": str(exc) or exc.__class__.__name__})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
