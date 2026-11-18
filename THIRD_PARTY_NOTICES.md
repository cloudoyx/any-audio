# Third-party notices

AnyAudio itself is MIT licensed (see `LICENSE`). This file lists every external
component that the plugin uses, downloads, or was designed after.

## Runtime dependencies

**spessasynth_core** — version 4.3.22, Apache License 2.0.
Pure TypeScript SoundFont / MIDI synthesizer used to render notes to audio.
Installed through npm as a normal dependency and not vendored in this
repository. License text: <https://www.apache.org/licenses/LICENSE-2.0>.
Copyright belongs to the Spessasynth project and its contributors.

**node-edge-tts** — version 1.2.x, MIT license.
Thin client for the Microsoft Edge read-aloud endpoint, used only by the
optional `anyaudio_tts` tool. Installed through npm, not vendored. This is an
unofficial interface and has no relationship with Microsoft; the tool can fail
whenever the endpoint changes.

**https-proxy-agent** — version 7.x, MIT license.
Proxy-aware HTTPS agent, used only when a proxy address is configured for Edge
TTS or MiMo. Installed through npm, not vendored. Copyright belongs to Nathan
Rajlich and the proxy-agents contributors.

## SoundFonts (not bundled)

**GeneralUser GS** — maintained by S. Christian Collins,
<https://github.com/mrbumpy409/GeneralUser-GS>. The bank is *not* included in
this repository or in the npm package. `scripts/fetch-font.mjs` downloads the
file from the author's GitHub release on the user's explicit request.

The author's license allows free use for private and commercial music
production, including use inside software projects, and allows modifying the
bank for personal use. The author also states that not all source samples could
be traced to an original author and asks that his download links are not
hot-linked by third-party sites. Because of that, the plugin never
redistributes the bank: the user either downloads it from the author's release
page or points the plugin at a file they obtained elsewhere.

**MuseScore General** (file `MuseScore_General.sf3`, 39,900,972 bytes,
SHA-256 `5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3`) —
MIT license, per the bank's own `MuseScore_General_License.md`: FluidR3 samples
by Frank Wen, FluidR3Mono conversion by Michael Cowgill, MuseScore adaptation by
S. Christian Collins. The plugin can download it from the OSUOSL mirror of the
MuseScore project on request; it is not bundled and its license text is not
reproduced here.

**Upright Piano KW** (SF2 57,377,848 bytes, SHA-256
`d9f5157720963671906727ca2e12b3293fd822c831bb0de477dd1c5f3ad37108`, CC0 1.0) —
FreePats project, version 2022-02-21,
<https://freepats.zenvoid.org/Piano/UprightPianoKW/>. Sampled from a Kawai
upright piano, 7z archive of 28,832,466 bytes. A single-instrument bank; the
plugin only prints the download address and expected file name, it does not
fetch or redistribute the archive.

**FSBS Electric Guitar Clean** (SF2, CC0 1.0) — FreePats project,
<https://freepats.zenvoid.org/ElectricGuitar/electric-guitar-FSBS-clean.html>,
release archives hosted on GitHub. Sampled from a Fender electric guitar by the
FreePats contributors; single-instrument bank, manual install only. The CC0 text
shipped inside the archive is the authoritative license.

**FluidR3_GM** — optional alternative bank, released under the MIT license by
Frank Wen. Not bundled, not downloaded automatically; described only as an
option for users who prefer it.

Other banks found in the market with unconfirmed or non-redistributable terms
are not referenced or fetched by the plugin.

## Singing runtime and models (downloaded on first use, not bundled)

The singing feature builds a minimal local environment on the user's request. None of the following is included in the npm package; each is downloaded by the installer, checked against its official SHA-256 where the publisher provides one, and installed under `~/.dsh/anyaudio/singing`. Their licenses and attribution requirements remain in force.

**CPython 3.12 runtime** — redistributable build from
<https://github.com/astral-sh/python-build-standalone> (`install_only` build).
CPython is under the PSF License; the python-build-standalone redistribution
project is under MPL 2.0. The runtime is installed independently of the plugin
and is not modified or redistributed by this repository.

**PyTorch (CPU wheel)** — <https://download.pytorch.org/whl/cpu>, BSD-style
license, from the official PyTorch CPU wheel index. It is pip-installed into the
singing runtime for inference.

**Qixuan (绮萱) DiffSinger voicebank** — the author's official release at
<https://github.com/yqzhishen/qixuan-diffsinger> (v2.7.0, OpenUTAU edition), also
announced by the author at <https://www.bilibili.com/opus/844555716205215764>.
The bank is not bundled. Per the author's published usage terms it may be used
commercially without extra permission, provided that released works credit the
voicebank name "绮萱", the synthesis technology "DiffSinger", and state visibly
that the content was synthesised with AI technology. This version downloads and
uses the bank as-is; the user is responsible for following those terms in the
works they publish.

**Neural vocoder** — the PC-NSF-HiFiGAN model from the OpenVPI / DiffSinger
Community Vocoders project, <https://github.com/openvpi/vocoders> (release page
<https://openvpi.github.io/vocoders/>). The model weights are licensed under
**CC BY-NC-SA 4.0**, a non-commercial license: redistribution and integration
are permitted under that license with attribution to OpenVPI / DiffSinger
Community and a link to the release page; synthesising or producing commercial
work with the vocoder is not restricted by the license. The plugin downloads the
weights on request and does not redistribute them itself.

**diffsinger-utau** — version 0.3.8, MIT license,
<https://pypi.org/project/diffsinger-utau/> (source:
<https://github.com/bingcheng1998/diffsinger_utau>). It performs the actual
DiffSinger inference and is pip-installed as a normal dependency into the
singing runtime, not vendored here. The remaining pip dependencies of that
runtime (onnxruntime, numpy, scipy, librosa, pypinyin, PyYAML, matplotlib) keep
their own open-source licenses.

## Design reference (no content copied)

**cortico-world-singer-for-coopanion** — <https://github.com/wocwang/cortico-world-singer-for-coopanion>, MIT License, Copyright (c) 2026 wocwang. AnyAudio's singing feature was **designed after** this project: we studied its approach to turning lyrics and notes into a DiffSinger score, but wrote our own engine and **copied no source code** from it. The project itself is not bundled or redistributed here.

**AI_MUSIC_CREATOR** — <https://github.com/maxtinnate/AI_MUSIC_CREATOR>.
Read only to understand how a music skill, a note-level score and a SoundFont
playback engine can be combined. Its `LICENSE_许可.txt` is
**CC BY-NC-SA 4.0** (non-commercial, share-alike) and additionally forbids any
paid distribution; its `SKILL.md`, `engine/` and `mix_kit.py` are therefore not
licensed for reuse in a commercially usable plugin, and this project is
independently implemented in JavaScript. No source code, skill text, program
structure or audio asset from that project is included here, and its license
does not apply to this repository. Its bundled SoundFont and renderer keep their
own licenses (GeneralUser GS, and TinySoundFont under MIT) and neither is used
or shipped by this plugin.

## Development references

The plugin manifest format (`dsh.bundle.patch`, `cordis.patch.yml`) and the
service names (`tools`, `skills`, `systemPrompt`) were derived from the public
DeepSeek Harness distribution and from the structure of the user's own
installed plugins; no DeepSeek Harness source code is redistributed here.

## External tools (not bundled)

**ffmpeg** — not bundled and not downloaded by the plugin. It is only used when
the user already has it: converting Edge TTS audio and muxing a mixed WAV back
into a video. The user installs it themselves and its own license applies.

## Node.js built-ins

`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:os`,
`node:url`, `node:process` — no license obligations for the environment.
