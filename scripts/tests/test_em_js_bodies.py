#!/usr/bin/env python3
"""The EM_JS bodies in the WebGPU backend must survive the C preprocessor.

`EM_JS(ret, name, params, ...)` stringifies its last argument, and the preprocessor
lexes that text *first*, with its own rules:

* `//` and `/*` start a comment wherever they appear, including inside a JavaScript
  string or template literal. The comment is gone before stringification, so the
  rest of that line is gone from the emitted body — the generated JavaScript is then
  a template literal that never closes;
* a parenthesis inside a string literal is not counted as a parenthesis, so a
  `(`/`)` written inside a quoted fragment moves the macro's argument list out of
  balance and the build stops with "unterminated function-like macro invocation".

Both are silent in the source, cost a full WASM build to find, and are invisible to
any JavaScript-level check because the source is valid JavaScript. Measured on
`render/webgpu-lighting` (run 37014818279): the `// colour channel ${j}` inside a
template literal at `gx_webgpu.cpp:220` was the whole failure.

Run with:  python -m unittest discover -s scripts/tests -v
"""

from __future__ import annotations

import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Every file whose EM_JS bodies this guard covers.
SOURCES = ("wasm/render/gx_webgpu.cpp",)

_OPENERS = ("'", '"', "`")


def split_bodies(text: str) -> list[tuple[int, str]]:
    """Every EM_JS body in `text`, as (first line number, body text).

    The invocations sit at file scope and each body opens with `, {` and closes with
    `});` before the next invocation, which is what the repository's style uses; a body
    that does not follow it fails here rather than being silently skipped.
    """
    bodies: list[tuple[int, str]] = []
    lines = text.split("\n")
    starts = [i for i, line in enumerate(lines) if line.startswith("EM_JS(")]
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(lines)
        chunk = lines[start:end]
        marker = [i for i, line in enumerate(chunk) if line.rstrip().endswith(", {")]
        if len(marker) != 1:
            raise AssertionError(
                f"EM_JS at line {start + 1} does not open its body with ', {{' on one line"
            )
        body_lines = chunk[marker[0] :]
        # The body itself starts at the `{`; the parameters before it are not body text.
        body_lines[0] = body_lines[0][body_lines[0].rindex(", {") + 2 :]
        # The invocation ends with `});` at column 0, followed by at most blank lines and
        # the comments that introduce the next one.
        closers = [i for i, line in enumerate(body_lines) if line.strip() == "});"]
        if not closers:
            raise AssertionError(
                f"EM_JS at line {start + 1} does not close with '}});' before the next one"
            )
        body_lines = body_lines[: closers[-1] + 1]
        body_lines[-1] = body_lines[-1].rstrip()[: -len(");")]
        body = "\n".join(body_lines)
        bodies.append((start + marker[0] + 1, body))
    return bodies


def cpp_comment_mask(text: str) -> list[bool]:
    """Which characters the C preprocessor sees inside a comment.

    Its lexer, in order: `//` to end of line, `/*` to `*/`, `"..."` and `'...'` (with
    backslash escapes) as literals. Backticks mean nothing to it, which is the trap.
    """
    mask = [False] * len(text)
    i = 0
    while i < len(text):
        c = text[i]
        if c == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            j = len(text) if j < 0 else j
            for k in range(i, j):
                mask[k] = True
            i = j
        elif c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = len(text) if j < 0 else j + 2
            for k in range(i, j):
                mask[k] = True
            i = j
        elif c in _OPENERS[:2]:
            quote = c
            i += 1
            while i < len(text):
                if text[i] == "\\":
                    i += 2
                elif text[i] == quote:
                    i += 1
                    break
                else:
                    i += 1
        else:
            i += 1
    return mask


def js_comment_mask(text: str) -> list[bool]:
    """Which characters JavaScript sees inside a comment.

    Strings and template literals (including `${...}` interpolations) are code-free
    zones for `//` and `/*`. Regular-expression literals are not modelled: none of the
    bodies uses one, and a `//` inside one would be reported as a real comment.
    """
    mask = [False] * len(text)
    # A stack of quoting contexts: None for code, else the quote character.
    stack: list[str | None] = [None]
    i = 0
    while i < len(text):
        context = stack[-1]
        c = text[i]
        if context is not None:
            if c == "\\":
                i += 2
            elif c == context:
                stack.pop()
                i += 1
            elif context == "`" and text.startswith("${", i):
                stack.append(None)
                i += 2
            else:
                i += 1
            continue
        if c in _OPENERS:
            stack.append(c)
            i += 1
        elif c == "}" and len(stack) > 1:
            stack.pop()
            i += 1
        elif c == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            j = len(text) if j < 0 else j
            for k in range(i, j):
                mask[k] = True
            i = j
        elif c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = len(text) if j < 0 else j + 2
            for k in range(i, j):
                mask[k] = True
            i = j
        else:
            i += 1
    return mask


def cpp_code_paren_balance(text: str) -> int:
    """Parentheses the preprocessor counts inside a body, minus the ones it ignores.

    Parentheses inside `//`/`/*` comments and inside string or character literals do
    not count, which is why a quoted `(` or `)` can unbalance the macro invocation.
    """
    mask = cpp_comment_mask(text)
    balance = 0
    i = 0
    while i < len(text):
        c = text[i]
        if mask[i]:
            i += 1
        elif c in _OPENERS[:2]:
            quote = c
            i += 1
            while i < len(text):
                if text[i] == "\\":
                    i += 2
                elif text[i] == quote:
                    i += 1
                    break
                else:
                    i += 1
        elif c == "(":
            balance += 1
            i += 1
        elif c == ")":
            balance -= 1
            i += 1
        else:
            i += 1
    return balance


class EmJsBodyTest(unittest.TestCase):
    def bodies(self) -> list[tuple[str, int, str]]:
        found = []
        for relative in SOURCES:
            text = (REPO_ROOT / relative).read_text(encoding="utf-8")
            for line, body in split_bodies(text):
                found.append((relative, line, body))
        self.assertTrue(found, "no EM_JS body was found; the guard is looking at nothing")
        return found

    def test_every_body_has_balanced_parentheses_for_the_preprocessor(self) -> None:
        for relative, line, body in self.bodies():
            balance = cpp_code_paren_balance(body)
            self.assertEqual(
                balance,
                0,
                f"{relative}:{line}: the preprocessor counts {balance:+d} parentheses in this "
                "EM_JS body, so the macro invocation never closes",
            )

    def test_no_comment_token_hides_inside_a_javascript_literal(self) -> None:
        for relative, line, body in self.bodies():
            cpp = cpp_comment_mask(body)
            js = js_comment_mask(body)
            differing = [i for i in range(len(body)) if cpp[i] != js[i]]
            if not differing:
                continue
            first = differing[0]
            excerpt = body[max(0, first - 30) : first + 30].replace("\n", "\\n")
            self.fail(
                f"{relative}:{line}: the preprocessor and JavaScript disagree about what is a "
                f"comment at offset {first} (…{excerpt}…): the preprocessor strips the text "
                "the author meant to emit"
            )


if __name__ == "__main__":
    unittest.main()
