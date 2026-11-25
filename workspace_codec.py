"""Lossless workspace archive pooling; normal API clients still receive canonical JSON."""
from __future__ import annotations

import json
import math

MAX_WORKSPACE_BYTES = 256 * 1024 * 1024
PACKED_WORKSPACE_KIND = "minipost.workspace.packed"
PACKED_WORKSPACE_MEDIA_TYPE = "application/vnd.minipost.workspace.packed+json"
MAX_WORKSPACE_DEPTH = 256


class WorkspaceSizeError(ValueError):
    status = 413


def compact_json(value):
    # JSON permits escaped lone UTF-16 surrogates. Keep those escaped while
    # writing ordinary Unicode directly, just as JSON.stringify does.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False).encode("utf-8", "backslashreplace")


def _too_large(max_bytes):
    return WorkspaceSizeError(f"保存データの展開後サイズが上限（{max_bytes / 1024 / 1024:g} MiB）を超えています。")


def _primitive(value):
    return value is None or type(value) in (str, int, bool) or (
        type(value) is float and math.isfinite(value))


def is_packed_workspace_bundle(value):
    return isinstance(value, dict) and value.get("kind") == PACKED_WORKSPACE_KIND


def _validate_plain(value, max_bytes):
    """Bound ordinary inputs too; a small deeply nested JSON is not a workspace."""
    ancestors = set()

    def visit(node, depth):
        if _primitive(node):
            return
        if depth >= MAX_WORKSPACE_DEPTH:
            raise ValueError("保存データの階層が深すぎます。")
        if not isinstance(node, (list, dict)):
            raise ValueError("保存データにJSONで表せない値があります。")
        identity = id(node)
        if identity in ancestors:
            raise ValueError("保存データに循環参照があります。")
        ancestors.add(identity)
        if isinstance(node, dict):
            if any(not isinstance(key, str) for key in node):
                raise ValueError("保存データのキーが不正です。")
            children = node.values()
        else:
            children = node
        for child in children:
            visit(child, depth + 1)
        ancestors.remove(identity)

    visit(value, 0)
    encoded = compact_json(value)
    if len(encoded) > max_bytes:
        raise _too_large(max_bytes)
    return encoded


def pack_workspace_bundle(value, *, max_bytes=MAX_WORKSPACE_BYTES):
    """Pool identical values and subtrees, keeping the old format when smaller."""
    original = _validate_plain(value, max_bytes)
    nodes, signatures, primitives = [], {}, {}

    def visit(node):
        if _primitive(node):
            # Type is significant: Python considers True == 1 and 1 == 1.0.
            signature = (type(node), node)
            if signature in primitives:
                return primitives[signature]
            index = len(nodes)
            primitives[signature] = index
            nodes.append(node)
            return index
        if isinstance(node, list):
            entry = ["a", [visit(child) for child in node]]
        else:
            children = []
            for key, child in node.items():
                children.extend((key, visit(child)))
            entry = ["o", children]
        signature = compact_json(entry)
        if signature in signatures:
            return signatures[signature]
        index = len(nodes)
        signatures[signature] = index
        nodes.append(entry)
        return index

    root = visit(value)
    packed = {"kind": PACKED_WORKSPACE_KIND, "version": 1, "root": root, "nodes": nodes}
    return packed if len(compact_json(packed)) < len(original) else value


def unpack_workspace_bundle(value, *, max_bytes=MAX_WORKSPACE_BYTES):
    """Validate all references and expansion costs before allocating the tree."""
    if not is_packed_workspace_bundle(value):
        _validate_plain(value, max_bytes)
        return value
    if (type(value.get("version")) is not int or value["version"] != 1 or
            type(value.get("root")) is not int or not isinstance(value.get("nodes"), list)):
        raise ValueError("保存データの圧縮形式が不正です。")
    nodes = value["nodes"]
    root = value["root"]
    if root < 0 or root >= len(nodes):
        raise ValueError("保存データの参照先が不正です。")
    sizes, depths = [], []

    for index, node in enumerate(nodes):
        if _primitive(node):
            size, depth = len(compact_json(node)), 0
        else:
            if (not isinstance(node, list) or len(node) != 2 or
                    node[0] not in ("a", "o") or not isinstance(node[1], list)):
                raise ValueError("保存データの値の形式が不正です。")
            entries = node[1]
            if node[0] == "o":
                if len(entries) % 2:
                    raise ValueError("保存データのオブジェクトが不正です。")
                keys, refs = entries[::2], entries[1::2]
                if any(not isinstance(key, str) for key in keys) or len(set(keys)) != len(keys):
                    raise ValueError("保存データのキーが不正または重複しています。")
                size = 2 + max(0, len(refs) - 1) + sum(len(compact_json(key)) + 1 for key in keys)
            else:
                refs = entries
                size = 2 + max(0, len(refs) - 1)
            depth = 1
            for ref in refs:
                if type(ref) is not int or ref < 0 or ref >= index:
                    raise ValueError("保存データに不正な参照または循環参照があります。")
                size += sizes[ref]
                depth = max(depth, depths[ref] + 1)
                if size > max_bytes:
                    raise _too_large(max_bytes)
            if depth > MAX_WORKSPACE_DEPTH:
                raise ValueError("保存データの階層が深すぎます。")
        if size > max_bytes:
            raise _too_large(max_bytes)
        sizes.append(size)
        depths.append(depth)

    def materialize(index):
        node = nodes[index]
        if _primitive(node):
            return node
        if node[0] == "a":
            return [materialize(ref) for ref in node[1]]
        return {key: materialize(ref) for key, ref in zip(node[1][::2], node[1][1::2])}

    # Each reference creates a fresh mutable subtree. Restoring/editing a
    # revision must never mutate another revision which shared its wire value.
    return materialize(root)
