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
                      "duration":4.0,"out":"...wav","preset":"...state"}
    worker → 调用方  {"type":"result","id":N,"ok":true,"peak":0.79,"seconds":4.0}
    调用方 → worker  {"op":"probe","id":N,"plugin":"..."}
    worker → 调用方  {"type":"result","id":N,"ok":true,"programs":[
                        {"parameter":"program","values":["Say Again.",...]}]}
    worker → 调用方  {"type":"result","id":N,"ok":false,"kind":"param|load|render","error":"..."}
    调用方 → worker  {"op":"shutdown"}

preset 可选，三种写法：
    状态文件路径（字符串）          厂商预设状态，装进插件状态容器再渲染；
    {"kind":"state","path":"..."}   同上，显式写法；
    {"kind":"file","path":"..."}    插件自己的预设文件，走 load_preset；
    {"kind":"parameter","parameter":"program","value":"PHAROH"}
                                    具名程序参数，渲染前 setattr 到插件上。
不给就用插件默认状态（上一次渲染用过的预设会被撤掉）。预设装不进插件按 load 报错。

probe 只加载插件、枚举参数，找出「参数名像 program/preset/patch 且取值是一串具名值」
的参数（Dexed 的 program 就是这种），给调用方写进音色档案用；不预热、不出声。

Windows 的 .vst3 是目录包，pedalboard 只认内层 DLL；传目录或 DLL 都行，这里自己找。
Ample 系列采样器是流式加载，刚加载就渲染会静音：先预热到有声，再正式渲染。
"""
import json
import os
import re
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
# 插件里的 C 代码直接写 fd 1（Dexed 加载时会打 banner），会混进协议行：
# 把 fd 1 接到 stderr，协议行走复制出来的那个句柄。
try:
    _protocol_fd = os.dup(1)
    os.dup2(2, 1)
    _PROTOCOL_OUT = os.fdopen(_protocol_fd, "w", encoding="utf-8", newline="\n")
except OSError:
    pass

try:
    from mido import Message
except ImportError as _mido_error:  # 缺依赖时按 load 错误上报，不让进程直接崩
    Message = None
    _MIDO_ERROR = _mido_error

from vst3_preset import PresetError, apply_preset

SAMPLE_RATE = 48000
BUFFER_SIZE = 8192
SILENCE_PEAK = 0.001
MAX_SECONDS = 600.0
WARMUP_ATTEMPTS = 8
WARMUP_SECONDS = 2.5
FLUSH_SECONDS = 2.0
# 具名程序参数：参数名像 program/preset/patch，取值又是一串具名值。
PROGRAM_PARAMETER = re.compile(r"program|preset|patch", re.IGNORECASE)

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


def read_preset_file(raw):
    """读预设状态文件。路径不存在、读不了都按 load 报错，不往下走。"""
    path = Path(raw)
    try:
        if not path.is_file():
            raise WorkerError("load", f"预设文件不存在：{path}")
        return path.read_bytes()
    except OSError as exc:
        raise WorkerError("load", f"预设文件读不了：{exc}")


def parse_preset(raw):
    """把协议里的 preset 归一成 None 或 {kind, ...}；写法见模块开头的协议说明。"""
    if raw is None:
        return None
    if isinstance(raw, str):
        path = raw.strip()
        if not path:
            raise WorkerError("param", "preset 必须是非空字符串：预设状态文件路径")
        return {"kind": "state", "path": os.path.abspath(path)}
    if not isinstance(raw, dict):
        raise WorkerError("param", "preset 必须是状态文件路径或 {kind, ...} 对象")
    kind = raw.get("kind")
    if kind == "parameter":
        parameter = raw.get("parameter")
        value = raw.get("value")
        if not isinstance(parameter, str) or not parameter.strip():
            raise WorkerError("param", "参数型预设缺少 parameter：需要参数名")
        if not isinstance(value, str) or not value.strip():
            raise WorkerError("param", "参数型预设缺少 value：需要具名取值")
        return {"kind": "parameter", "parameter": parameter.strip(), "value": value.strip()}
    if kind in ("state", "file"):
        path = raw.get("path")
        if not isinstance(path, str) or not path.strip():
            raise WorkerError("param", f"{kind} 型预设缺少 path：需要预设文件路径")
        return {"kind": kind, "path": os.path.abspath(path.strip())}
    raise WorkerError("param", f"未知 preset kind：{kind!r}（可用 state / file / parameter）")


def preset_key(preset):
    """预设的比较键：同一份预设重复请求时不必再切一次。"""
    if preset is None:
        return None
    return json.dumps(preset, sort_keys=True, ensure_ascii=False)


def plugin_parameters(plugin):
    try:
        parameters = plugin.parameters
    except Exception:
        return {}
    return parameters if hasattr(parameters, "items") else {}


def named_programs(plugin):
    """插件暴露的具名程序参数：[{parameter, values}]，供 probe 写进音色档案。"""
    programs = []
    for name, parameter in plugin_parameters(plugin).items():
        if not PROGRAM_PARAMETER.search(str(name)):
            continue
        values = getattr(parameter, "valid_values", None)
        if not isinstance(values, list) or not values:
            continue
        if not all(isinstance(value, str) for value in values):
            continue
        programs.append({"parameter": str(name), "values": list(values)})
    return programs


def current_string_value(parameter, values):
    """参数当前取的是哪个具名值：按 raw_value 反查，读不到就返回 None。"""
    try:
        raw = float(parameter.raw_value)
    except Exception:
        return None
    for value in values:
        try:
            if abs(float(parameter.get_raw_value_for(value)) - raw) < 1e-6:
                return value
        except Exception:
            continue
    return None


def string_parameter_defaults(plugin):
    """加载时的具名取值参数值：切走参数型预设时按它还原。"""
    defaults = {}
    for name, parameter in plugin_parameters(plugin).items():
        values = getattr(parameter, "valid_values", None)
        if not isinstance(values, list) or not values:
            continue
        current = current_string_value(parameter, values)
        if current is not None:
            defaults[str(name)] = current
    return defaults


def resolve_parameter_value(plugin, name, value):
    """把具名取值落到插件认的那个字符串上：有些插件会补空格（'PHAROH    '）。"""
    parameter = plugin_parameters(plugin).get(name)
    if parameter is None:
        raise WorkerError("load", f"插件没有参数 {name}")
    values = getattr(parameter, "valid_values", None)
    if not isinstance(values, list) or not values:
        return value
    if value in values:
        return value
    matches = [item for item in values if isinstance(item, str) and item.strip() == value]
    if len(matches) == 1:
        return matches[0]
    raise WorkerError("load", f"参数 {name} 没有取值 {value!r}；可用：{', '.join(values)}")


def plugin_range(path):
    name = path.name.lower()
    for key, bounds in PLUGIN_RANGES.items():
        if key in name:
            return bounds
    return None


def check_range(path, notes, keyswitches=()):
    bounds = plugin_range(path)
    if not bounds:
        return
    low, high = bounds
    # 演奏法键位音（24/26/28/30）本来就在音域外，它们是控制键，不是音符：
    # 调用方用 keyswitches 显式列出，才放行；普通音符仍然严格检查。
    exempt = set(keyswitches)
    bad = sorted({note["pitch"] for note in notes if not low <= note["pitch"] <= high and note["pitch"] not in exempt})
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
    """按路径缓存已加载并预热过的插件实例，并按需切换预设。

    一个实例只留一份"插件默认状态"（刚加载、还没被任何预设改过的那份），每次要
    预设都从它出发，所以连续换预设不会层层叠加；不给预设就切回默认。
    参数型预设改的是插件参数，不在状态容器里，所以切走时按加载时记下的默认值还原。
    """

    def __init__(self):
        self._plugins = {}

    def get(self, path, preset=None):
        key = str(path).lower()
        entry = self._plugins.get(key)
        if entry is None:
            plugin = self._load(path)
            entry = {
                "plugin": plugin,
                "defaultState": None,
                "defaults": string_parameter_defaults(plugin),
                "preset": None,
                "applied": None,
            }
            self._plugins[key] = entry
        self._select_state(entry, preset)
        return entry["plugin"]

    def load_plugin(self, path):
        """只加载不预热：probe 只读参数，不需要出声。"""
        return self._load_plugin(path)

    def _select_state(self, entry, preset):
        """把实例切到 preset 指定的状态；preset 为空就回到插件默认状态。"""
        key = preset_key(preset)
        if key == entry["preset"]:
            return
        self._restore(entry)
        # 先清掉记录再应用：应用失败时下一次请求会重试，而不是误以为已经切好了。
        entry["preset"] = None
        if preset is not None:
            if entry["defaultState"] is None:
                try:
                    entry["defaultState"] = bytes(entry["plugin"].preset_data)
                except Exception as exc:
                    raise WorkerError("load", f"读不到插件默认状态：{exc}")
            self._apply(entry, preset)
        entry["preset"] = key

    def _restore(self, entry):
        """撤掉上一次预设：状态型切回默认状态，参数型把参数设回加载时的值。"""
        applied = entry["applied"]
        if applied is None:
            return
        entry["applied"] = None
        if applied["kind"] == "parameter":
            default = entry["defaults"].get(applied["parameter"])
            if default is not None:
                try:
                    setattr(entry["plugin"], applied["parameter"], default)
                except Exception as exc:
                    raise WorkerError("load", f"参数 {applied['parameter']} 还原不了：{exc}")
                return
        self._set_state(entry, entry["defaultState"])

    def _apply(self, entry, preset):
        kind = preset["kind"]
        if kind == "parameter":
            name = preset["parameter"]
            value = resolve_parameter_value(entry["plugin"], name, preset["value"])
            try:
                setattr(entry["plugin"], name, value)
            except Exception as exc:
                raise WorkerError("load", f"参数 {name} 设不上：{exc}")
            entry["applied"] = {"kind": "parameter", "parameter": name}
            return
        if kind == "file":
            try:
                entry["plugin"].load_preset(preset["path"])
            except Exception as exc:
                raise WorkerError("load", f"预设文件装不进插件：{exc}")
            entry["applied"] = {"kind": "file"}
            return
        state = read_preset_file(preset["path"])
        try:
            merged = apply_preset(entry["defaultState"], state)
        except PresetError as exc:
            raise WorkerError("load", f"预设装不进插件状态：{exc}")
        self._set_state(entry, merged)
        entry["applied"] = {"kind": "state"}

    @staticmethod
    def _set_state(entry, state):
        try:
            entry["plugin"].preset_data = state
        except Exception as exc:
            raise WorkerError("load", f"插件拒绝加载状态：{exc}")

    def _load(self, path):
        plugin = self._load_plugin(path)
        self._warmup(plugin, path)
        return plugin

    @staticmethod
    def _load_plugin(path):
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
    raw_keyswitches = msg.get("keyswitches")
    keyswitches = set()
    if isinstance(raw_keyswitches, list):
        for pitch in raw_keyswitches:
            if isinstance(pitch, int) and not isinstance(pitch, bool) and 0 <= pitch <= 127:
                keyswitches.add(pitch)
    raw_preset = msg.get("preset")
    preset = parse_preset(raw_preset)
    path = resolve_plugin_path(plugin_raw)
    check_range(path, notes, keyswitches)
    plugin = cache.get(path, preset)
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


def handle_probe(cache, msg):
    """枚举插件的具名程序参数；只读参数，不预热也不出声。"""
    plugin_raw = msg.get("plugin")
    if not isinstance(plugin_raw, str) or not plugin_raw.strip():
        raise WorkerError("param", "缺少 plugin：需要 VST3 路径")
    path = resolve_plugin_path(plugin_raw)
    plugin = cache.load_plugin(path)
    return {"programs": named_programs(plugin)}


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
        op = msg.get("op")
        if op not in ("render", "probe"):
            send({"type": "result", "id": msg.get("id"), "ok": False,
                  "kind": "param", "error": f"未知 op：{msg.get('op')}"})
            continue
        try:
            result = handle_probe(cache, msg) if op == "probe" else handle_render(cache, msg)
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
