# 歌声合成引擎

本目录的 Python 代码是本项目自行实现的：负责把外部音符转成 DiffSinger 曲谱、
管理合成进程（一行 JSON 进 / 一行 JSON 出）。设计思路参考了
[cortico-world-singer-for-coopanion](https://github.com/wocwang/cortico-world-singer-for-coopanion)
（MIT），未复制其源码。

真正的推理由开源库 `diffsinger-utau`（pip 安装）完成；拼音用 `pypinyin` 查询。
运行环境与声库均不随项目打包，首次使用时另行安装。

## VST3 音源侧车（vst3_worker.py）

`vst3_worker.py` 用同一套 JSON 行协议驱动 VST3 乐器：加载插件、把音符渲染成 WAV。
依赖 `pedalboard`、`numpy`、`mido`（`pip install pedalboard numpy mido`）。

启动后先输出一行 ready，之后每个请求回一行 result：

```
worker → 调用方  {"type":"ready","sampleRate":48000}
调用方 → worker  {"op":"render","id":1,"plugin":"...","notes":[{"pitch":60,"start":0.0,"dur":0.5,"vel":100}],"duration":4.0,"out":"...wav"}
worker → 调用方  {"type":"result","id":1,"ok":true,"peak":0.79,"seconds":4.0}
worker → 调用方  {"type":"result","id":1,"ok":false,"kind":"param|load|render","error":"..."}
调用方 → worker  {"op":"shutdown"}
```

- `plugin` 可以传 Windows 的 `.vst3` 目录包，也可以传内层 DLL；目录包会自动找
  `Contents/x86_64-win/*.vst3`（pedalboard 只认内层 DLL）。
- 采样器是流式加载，刚加载就渲染会静音：每个插件先预热到峰值 > 0.001 再正式渲染，
  之后每次调用都用 `reset=False`。
- 实测音域：Ample Bass（ABPL）MIDI 40–72，Ample Guitar（AGML）42–84。超出音域的音
  会静音，worker 直接按 `param` 报错，不写空 WAV。
- 渲染后检查峰值，全静音按 `render` 报错；插件路径不存在或加载失败按 `load` 报错。
- 自检：`python -X utf8 engine/vst3_worker.py --selftest`（加载 Ample Bass 渲染 4 个音，
  成功打印 `OK`）。
