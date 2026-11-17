# 歌声合成引擎

本目录的 Python 代码是本项目自行实现的：负责把外部音符转成 DiffSinger 曲谱、
管理合成进程（一行 JSON 进 / 一行 JSON 出）。设计思路参考了
[cortico-world-singer-for-coopanion](https://github.com/wocwang/cortico-world-singer-for-coopanion)
（MIT），未复制其源码。

真正的推理由开源库 `diffsinger-utau`（pip 安装）完成；拼音用 `pypinyin` 查询。
运行环境与声库均不随项目打包，首次使用时另行安装。
