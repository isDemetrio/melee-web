"""Strict, stdlib-only GameCube header and filesystem table reader.

Paths are relative to the FST root; extraction adds the conventional files/ prefix.
Offsets and sizes are bytes (GameCube, not Wii word offsets).
"""
from dataclasses import dataclass
from pathlib import Path
import struct


class DiscError(ValueError):
    """Invalid or unsafe disc structure."""


@dataclass(frozen=True)
class Header:
    game_id: str
    revision: int
    dol_offset: int
    fst_offset: int
    fst_size: int


@dataclass(frozen=True)
class FileEntry:
    path: str
    offset: int
    size: int


def read_header(stream):
    stream.seek(0)
    raw = stream.read(0x440)
    if len(raw) != 0x440:
        raise DiscError('truncated GameCube header')
    try:
        game_id = raw[:6].decode('ascii')
    except UnicodeDecodeError as error:
        raise DiscError('invalid game id') from error
    if struct.unpack_from('>I', raw, 0x1c)[0] != 0xc2339f3d:
        raise DiscError('invalid GameCube magic')
    return Header(game_id, raw[7], *struct.unpack_from('>III', raw, 0x420))


def read_disc(path):
    """Return (header, files), rejecting malformed trees and out-of-disc ranges."""
    with Path(path).open('rb') as stream:
        stream.seek(0, 2)
        disc_size = stream.tell()
        header = read_header(stream)
        if not 0x440 <= header.dol_offset < disc_size:
            raise DiscError('DOL offset outside disc')
        if (header.fst_offset < 0x440 or header.fst_size < 12
                or header.fst_offset + header.fst_size > disc_size):
            raise DiscError('FST range outside disc')
        stream.seek(header.fst_offset)
        root = stream.read(12)
        kind_name, parent, count = struct.unpack('>III', root)
        if kind_name != 0x01000000 or parent != 0 or not 1 <= count <= header.fst_size // 12:
            raise DiscError('invalid FST root or entry count')
        # Read records individually; do not allocate a potentially disc-sized FST.
        names_start = header.fst_offset + count * 12
        names_size = header.fst_size - count * 12
        stack = [(0, count, '')]
        seen = set()
        files = []
        for index in range(1, count):
            while index >= stack[-1][1]:
                stack.pop()
            stream.seek(header.fst_offset + index * 12)
            word, offset, size = struct.unpack('>III', stream.read(12))
            kind, name_offset = word >> 24, word & 0xffffff
            if kind not in (0, 1) or name_offset >= names_size:
                raise DiscError(f'invalid FST entry {index}')
            stream.seek(names_start + name_offset)
            raw_name = bytearray()
            for _ in range(min(names_size - name_offset, 256)):
                byte = stream.read(1)
                if byte == b'\0':
                    break
                raw_name.extend(byte)
            else:
                raise DiscError(f'unterminated or oversized FST name at {index}')
            try:
                name = raw_name.decode('ascii')
            except UnicodeDecodeError as error:
                raise DiscError(f'non-ASCII FST name at {index}') from error
            if name in ('', '.', '..') or any(c in name for c in '/\\:') or any(ord(c) < 32 for c in name):
                raise DiscError(f'unsafe FST name at {index}')
            path = stack[-1][2] + name
            if path in seen:
                raise DiscError(f'duplicate FST path: {path}')
            seen.add(path)
            if kind:
                if offset != stack[-1][0] or not index < size <= stack[-1][1]:
                    raise DiscError(f'invalid directory bounds/parent: {path}')
                stack.append((index, size, path + '/'))
            else:
                if offset > disc_size or size > disc_size - offset:
                    raise DiscError(f'file range outside disc: {path}')
                files.append(FileEntry(path, offset, size))
        return header, files
