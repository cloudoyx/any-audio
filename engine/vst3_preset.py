#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""VST3 预设加载：把厂商预设的状态内容装进插件状态容器。

插件状态（pedalboard 的 ``preset_data``）是两层容器：

外层 —— VST3 预设文件
    0..47   48 字节头（"VST3" 魔数、版本、插件 class ID）
    40      i64 小端：块索引偏移
    48..    块数据
    索引    "List" + 块数(i32) + 每块 20 字节（4 字节 ID + i64 偏移 + i64 大小）

内层 —— VST2 FXB 持久化（大端），装在 "Comp" 块里
    "VstW" + i32 大小 + 版本 + 旁通
    "CcnK" + i32 大小 + "FBCh"/"FPCh" 块头 + 一个长度前缀的状态块

厂商预设文件是状态块里的那段文档，不是容器本身：直接把它当 ``preset_data``
赋给插件，插件读不到自己的块头，会失败甚至崩。所以加载预设 = 在状态块里把旧
文档换成新文档，再把每一层描述长度的字段改对。

不认任何厂商：
  · 状态块靠结构定位（块头之后那个长度前缀的块），块头魔数来自 VST2 FXB 格式
    本身，不是厂商 ID；
  · 文档靠 XML 结构定位（根元素起止），不认固定偏移；
  · 长度字段靠"值等于旧文档长度"定位，不认固定偏移。

任何一步对不上都抛 :class:`PresetError`，由调用方按 ``load`` 错误上报——宁可
拒绝加载，也不把一份结构可疑的状态塞给插件。
"""
import struct

# VST2 FXB 持久化的块魔数（格式常量，与厂商无关）。
_PRIVATE_CHUNK = b"VstW"
_COMPONENT_CHUNK = b"CcnK"
_CHUNK_BANK = b"FBCh"
_CHUNK_PROGRAM = b"FPCh"

# 外层容器：48 字节头，索引偏移在 40，索引项 20 字节。
_HEADER_BYTES = 48
_INDEX_OFFSET_POS = 40
_INDEX_ENTRY_BYTES = 20

# FBCh 块头里 currentProgram 之后固定 124 字节保留区。
_BANK_RESERVED_BYTES = 124
# FPCh 块头里程序名固定 28 字节。
_PROGRAM_NAME_BYTES = 28

_UTF8_BOM = b"\xef\xbb\xbf"


class PresetError(Exception):
    """预设装不进插件状态容器。调用方按 load 错误上报，不让进程崩。"""


def apply_preset(preset_data, state):
    """把预设的状态内容 ``state`` 装进插件状态 ``preset_data``，返回新状态。

    ``preset_data`` 是插件当前的完整状态（容器），``state`` 是预设文件的内容
    （状态文档）。两者都按字节处理，不做编码假设。
    """
    if not isinstance(preset_data, (bytes, bytearray)) or len(preset_data) <= _HEADER_BYTES:
        raise PresetError("插件没有可用的状态容器（preset_data 为空或过短）")
    if not isinstance(state, (bytes, bytearray)) or not state:
        raise PresetError("预设文件是空的")
    state = bytes(state)
    if state.startswith(_UTF8_BOM):
        state = state[len(_UTF8_BOM):]
    root = _root_name(state)
    if not root:
        raise PresetError("预设文件不是 XML：找不到根元素")

    container = _Container.parse(bytes(preset_data))
    index = container.index_of(b"Comp")
    if index is None:
        raise PresetError("插件状态里没有 Comp 块（组件状态）")
    new_component = _splice_component(container.chunks[index][1], state, root)
    return container.rebuild(index, new_component)


# ---------------------------------------------------------------------------
# 外层容器


class _Container:
    """VST3 预设文件：48 字节头 + 块数据 + 尾部索引。"""

    def __init__(self, header, chunks):
        self.header = header
        self.chunks = chunks  # [(4 字节 ID, 块内容), ...]

    @classmethod
    def parse(cls, data):
        if len(data) <= _HEADER_BYTES:
            raise PresetError("插件状态容器过短")
        if data[:4] != b"VST3":
            raise PresetError("插件状态不是 VST3 预设容器（缺少 VST3 魔数）")
        index_offset = struct.unpack_from("<q", data, _INDEX_OFFSET_POS)[0]
        if index_offset < _HEADER_BYTES or index_offset + 8 > len(data):
            raise PresetError("插件状态容器的索引偏移越界")
        if data[index_offset:index_offset + 4] != b"List":
            raise PresetError("插件状态容器的索引不是 List")
        count = struct.unpack_from("<i", data, index_offset + 4)[0]
        if count < 0 or index_offset + 8 + count * _INDEX_ENTRY_BYTES > len(data):
            raise PresetError("插件状态容器的块数越界")
        chunks = []
        pos = index_offset + 8
        for _ in range(count):
            chunk_id = data[pos:pos + 4]
            offset, size = struct.unpack_from("<qq", data, pos + 4)
            if offset < _HEADER_BYTES or size < 0 or offset + size > index_offset:
                raise PresetError("插件状态容器的块偏移越界")
            chunks.append((chunk_id, data[offset:offset + size]))
            pos += _INDEX_ENTRY_BYTES
        return cls(data[:_HEADER_BYTES], chunks)

    def index_of(self, chunk_id):
        for index, (current, _) in enumerate(self.chunks):
            if current == chunk_id:
                return index
        return None

    def rebuild(self, index, new_data):
        """换掉第 index 块，重排块数据并重建索引（偏移和大小必须与实情一致）。"""
        chunks = list(self.chunks)
        chunks[index] = (chunks[index][0], new_data)
        header = bytearray(self.header)
        body = bytearray()
        entries = []
        for chunk_id, chunk_data in chunks:
            entries.append((chunk_id, _HEADER_BYTES + len(body), len(chunk_data)))
            body += chunk_data
        struct.pack_into("<q", header, _INDEX_OFFSET_POS, _HEADER_BYTES + len(body))
        out = bytearray(header)
        out += body
        out += b"List" + struct.pack("<i", len(entries))
        for chunk_id, offset, size in entries:
            out += chunk_id + struct.pack("<qq", offset, size)
        return bytes(out)


# ---------------------------------------------------------------------------
# 内层组件块


def _splice_component(component, state, root):
    """在 Comp 块里换掉状态文档。"""
    if component[:4] == _PRIVATE_CHUNK:
        return _splice_fxb(component, state, root)
    # 没有 FXB 包装：Comp 块本身就是状态块（可能带自己的头尾）。
    return _splice_document(component, state, root)


def _splice_fxb(component, state, root):
    """在 VST2 FXB 包装里换掉状态块，并修正 CcnK 与状态块的长度。"""
    pos = 0
    if component[:4] == _PRIVATE_CHUNK:
        size = _be_i32(component, 4)
        if size < 0:
            raise PresetError("VstW 私有块长度非法")
        pos = 8 + size
    if component[pos:pos + 4] != _COMPONENT_CHUNK:
        raise PresetError("VstW 之后不是 CcnK 组件块")
    size_pos = pos + 4
    body_start = pos + 8
    body_end = body_start + _be_i32(component, size_pos)
    if body_end > len(component) or body_end < body_start:
        raise PresetError("CcnK 组件块长度越界")

    magic = component[body_start:body_start + 4]
    if magic == _CHUNK_BANK:
        cursor = body_start + 4
        bank_version = _be_i32(component, cursor)
        cursor += 4 + 4 + 4 + 4  # bankVersion 之后：fxUniqueID、fxVersion、numPrograms
        if bank_version > 1:
            cursor += 4 + _BANK_RESERVED_BYTES  # currentProgram + 保留区
    elif magic == _CHUNK_PROGRAM:
        cursor = body_start + 4
        cursor += 4 + 4 + 4 + 4 + _PROGRAM_NAME_BYTES  # formatVersion、fxId、fxVersion、numParams、name
    else:
        raise PresetError(f"组件块是 {_text(magic)}，里面没有状态块（只有参数表）")

    chunk_size = _be_i32(component, cursor)
    chunk_start = cursor + 4
    chunk_end = chunk_start + chunk_size
    if chunk_size < 0 or chunk_end > body_end:
        raise PresetError("状态块长度越界")

    new_chunk = _splice_document(component[chunk_start:chunk_end], state, root)
    new_body = (
        component[body_start:cursor]
        + struct.pack(">i", len(new_chunk))
        + new_chunk
        + component[chunk_end:body_end]
    )
    return (
        component[:size_pos]
        + struct.pack(">i", len(new_body))
        + new_body
        + component[body_end:]
    )


def _splice_document(chunk, state, root):
    """在状态块里换掉 XML 文档，并修正描述它长度的字段。"""
    start = _document_start(chunk, root)
    end = _document_end(chunk, start)
    old_root = _root_name(chunk[start:end])
    if old_root and old_root != root:
        raise PresetError(f"预设根元素 <{_text(root)}> 与插件状态根元素 <{_text(old_root)}> 不一致")
    prefix = _fix_lengths(chunk[:start], end - start, len(state))
    return prefix + state + chunk[end:]


# ---------------------------------------------------------------------------
# 状态文档定位


def _document_start(chunk, root):
    """状态文档在状态块里的起点：优先 XML 声明，其次根元素起始标签。"""
    for marker in (b"<?xml", b"<" + root):
        first = chunk.find(marker)
        if first < 0:
            continue
        if chunk.find(marker, first + 1) >= 0:
            raise PresetError(f"状态块里有多个 {_text(marker)}，无法确定状态文档")
        return first
    raise PresetError("状态块里找不到 XML 文档")


def _document_end(chunk, start):
    """从文档起点扫到根元素闭合，返回结束偏移（不含）。"""
    depth = 0
    cursor = start
    total = len(chunk)
    while cursor < total:
        lt = chunk.find(b"<", cursor)
        if lt < 0:
            break
        if chunk.startswith(b"<!--", lt):
            close = chunk.find(b"-->", lt + 4)
            if close < 0:
                break
            cursor = close + 3
            continue
        if chunk.startswith(b"<![CDATA[", lt):
            close = chunk.find(b"]]>", lt + 9)
            if close < 0:
                break
            cursor = close + 3
            continue
        if chunk.startswith(b"<?", lt):
            close = chunk.find(b"?>", lt + 2)
            if close < 0:
                break
            cursor = close + 2
            continue
        if chunk.startswith(b"<!", lt):
            close = _tag_close(chunk, lt + 2)
            if close < 0:
                break
            cursor = close + 1
            continue
        close = _tag_close(chunk, lt + 1)
        if close < 0:
            break
        tag = chunk[lt:close + 1]
        if tag.startswith(b"</"):
            depth -= 1
            if depth <= 0:
                return close + 1
        elif tag.endswith(b"/>"):
            if depth == 0:
                return close + 1
        else:
            depth += 1
        cursor = close + 1
    raise PresetError("状态块里的 XML 文档没有闭合")


def _root_name(document):
    """XML 文档的根元素名（bytes）；不是 XML 返回 None。"""
    cursor = 0
    total = len(document)
    while cursor < total:
        lt = document.find(b"<", cursor)
        if lt < 0:
            return None
        if document.startswith(b"<?", lt) or document.startswith(b"<!", lt):
            close = _tag_close(document, lt + 2)
            if close < 0:
                return None
            cursor = close + 1
            continue
        if document.startswith(b"</", lt):
            return None
        close = _tag_close(document, lt + 1)
        if close < 0:
            return None
        name = document[lt + 1:close].split(None, 1)[0].rstrip(b"/")
        return name or None
    return None


def _tag_close(buffer, cursor):
    """从 cursor 起找标签的 '>'，跳过引号里的内容；找不到返回 -1。"""
    quote = 0
    total = len(buffer)
    while cursor < total:
        byte = buffer[cursor]
        if quote:
            if byte == quote:
                quote = 0
        elif byte in (0x22, 0x27):
            quote = byte
        elif byte == 0x3E:
            return cursor
        cursor += 1
    return -1


# ---------------------------------------------------------------------------
# 长度字段


def _fix_lengths(prefix, old_length, new_length):
    """把 prefix 里描述状态文档长度的字段改成新长度。

    长度字段靠值定位：4 字节窗口按小端/大端读出来等于旧长度，就是它。i64 字段
    在值小于 2^32 时低 4 字节同样命中，所以 4 字节扫描也覆盖 i64。一个都没命中
    而 prefix 非空，说明这份状态块的长度字段不在文档旁边，拒绝硬改。
    """
    if old_length == new_length or not prefix:
        return prefix
    out = bytearray(prefix)
    hits = 0
    for offset in range(0, len(prefix) - 3):
        window = prefix[offset:offset + 4]
        if struct.unpack("<i", window)[0] == old_length:
            struct.pack_into("<i", out, offset, new_length)
            hits += 1
        elif struct.unpack(">i", window)[0] == old_length:
            struct.pack_into(">i", out, offset, new_length)
            hits += 1
    if hits == 0:
        raise PresetError("状态块里找不到描述状态文档长度的字段，无法安全替换")
    return bytes(out)


# ---------------------------------------------------------------------------


def _be_i32(buffer, offset):
    if offset < 0 or offset + 4 > len(buffer):
        raise PresetError("状态容器被截断：读不到 4 字节整数")
    return struct.unpack_from(">i", buffer, offset)[0]


def _text(raw):
    return raw.decode("ascii", "replace")
