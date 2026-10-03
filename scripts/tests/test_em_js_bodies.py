#!/usr/bin/env python3
"""The EM_JS bodies in the WebGPU backend must survive the C preprocessor.

`EM_JS(ret, name, params, ...)` stringifies its last argument, and the preprocessor
lexes that text *first*, with its own rules. Two traps are measured, and each one cost
a full WASM build to find:

* A comment region is removed before stringification. Inside an EM_JS body a template
  literal's backticks are not C string delimiters, so a `//` written inside one starts
  a C comment that runs to the end of the line, and the emitted body loses everything
  after it. When what it loses is the text that closes a literal, an interpolation or
  a call, the generated JavaScript never parses. Measured on `render/webgpu-lighting`
  (run 37014818279): the `// colour channel ${j}` inside a template literal at
  `gx_webgpu.cpp:220` was the whole failure.
* The other direction -- the preprocessor removing text JavaScript would have emitted --
  is not a defect by itself, and it is the deliberate form here: a `//` at the start of a
  line of generated WGSL is written bare so that the preprocessor strips it. It has to
  be: stringification turns the body's newlines into spaces, so a live `//` in the
  emitted shader swallows the rest of its WGSL line. Emitting one as text instead cost
  run 37038473832, where the shader failed to parse with `unresolved value 'nidx'`
  because the comment had eaten `let nidx`. That is what
  `test_no_live_comment_reaches_the_shader_text` holds.

So the guard checks what the two mechanisms do to the body: the text JavaScript receives
must still close, and no comment may be written into the shader text through a string
literal. It reads the source, not a compiler: it is a model of two lexers, and the
controls at the end of the file are the two measured shapes and the deliberate form.

Run with:  python -m unittest discover -s scripts/tests -v
"""

from __future__ import annotations

import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Every file whose EM_JS bodies this guard covers.
SOURCES = ("wasm/render/gx_webgpu.cpp",)

_OPENERS = ("'", '"', "`")
_CLOSERS = {")": "(", "]": "[", "}": "{"}


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


def emitted_body(body: str) -> str:
    """The body as the compiler emits it, one space per stripped character.

    The preprocessor removes every comment region before `#__VA_ARGS__` stringifies the
    body, and stringification then turns the newlines into spaces. Only the removal
    matters here: what is left is what JavaScript parses.
    """
    mask = cpp_comment_mask(body)
    return "".join(" " if mask[i] else c for i, c in enumerate(body))


def excerpt(text: str, offset: int, before: int = 30, after: int = 40) -> str:
    """`offset` in context, on one line, so a failure message can be read in a log."""
    return text[max(0, offset - before) : offset + after].replace("\n", "\\n")


def js_structure_failure(body: str) -> str | None:
    """Where the emitted body's delimiters stop closing, or None if they all close.

    A scan of the text JavaScript receives: string and template literals, the `${...}`
    interpolations inside them, and parentheses, brackets and braces. A construct still
    open at the end of the body, or a closer that matches nothing, is what "the emitted
    body is missing text it needs" looks like.
    """
    text = emitted_body(body)
    # Quote contexts, innermost last: None is code (the body's own, or an interpolation's),
    # a quote character is that literal. Brackets are counted only in code, and separately,
    # because a `(` does not open a literal.
    stack: list[str | None] = [None]
    brackets: list[str] = []
    interps: list[int] = []
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
                interps.append(len(brackets))
                i += 2
            else:
                i += 1
            continue
        if c in _OPENERS:
            stack.append(c)
            i += 1
        elif c in "([{":
            brackets.append(c)
            i += 1
        elif c in _CLOSERS:
            if c == "}" and interps and len(brackets) == interps[-1]:
                stack.pop()  # the `}` of a `${...}` interpolation
                interps.pop()
                i += 1
            elif brackets and brackets[-1] == _CLOSERS[c]:
                brackets.pop()
                i += 1
            else:
                return f"offset {i}: {c!r} closes nothing (…{excerpt(text, i)}…)"
        else:
            i += 1
    if len(stack) > 1 or brackets or interps:
        opened = [*( "interpolation" if s is None else s for s in stack[1:] ), *brackets]
        return (
            f"still open at the end of the body: {', '.join(opened)}; the preprocessor "
            "stripped the text that closed it"
        )
    return None


def live_shader_comments(body: str) -> list[int]:
    """Offsets of a `//` or `/*` written inside a string literal inside a template literal.

    Such a string is emitted into the generated WGSL, where stringification has already
    turned the body's newlines into spaces: a live `//` there swallows the rest of its
    WGSL line. Measured on `render/webgpu-lighting` (run 37038473832), where the viewport
    comment written as `${"// Emulate ..."}` produced a shader that failed to parse with
    `unresolved value 'nidx'`.
    """
    found: list[int] = []
    stack: list[str | None] = [None]
    brackets: list[str] = []
    interps: list[int] = []
    i = 0
    while i < len(body):
        context = stack[-1]
        c = body[i]
        if context is not None:
            if c == "\\":
                i += 2
            elif c == context:
                stack.pop()
                i += 1
            elif (
                context in ("'", '"')
                and "`" in stack
                and (body.startswith("//", i) or body.startswith("/*", i))
            ):
                found.append(i)
                i += 1
            elif context == "`" and body.startswith("${", i):
                stack.append(None)
                interps.append(len(brackets))
                i += 2
            else:
                i += 1
            continue
        if c in _OPENERS:
            stack.append(c)
            i += 1
        elif c in "([{":
            brackets.append(c)
            i += 1
        elif c in _CLOSERS:
            if c == "}" and interps and len(brackets) == interps[-1]:
                stack.pop()
                interps.pop()
            elif brackets and brackets[-1] == _CLOSERS[c]:
                brackets.pop()
            i += 1
        elif c == "/" and (body.startswith("//", i) or body.startswith("/*", i)):
            j = body.find("\n", i)
            i = len(body) if j < 0 else j
        else:
            i += 1
    return found


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

    def test_the_emitted_body_still_closes(self) -> None:
        """No stripped comment region may take a delimiter the emitted body needs."""
        for relative, line, body in self.bodies():
            failure = js_structure_failure(body)
            if failure is not None:
                self.fail(
                    f"{relative}:{line}: the body JavaScript receives does not close: {failure}"
                )

    def test_no_live_comment_reaches_the_shader_text(self) -> None:
        for relative, line, body in self.bodies():
            offsets = live_shader_comments(body)
            if offsets:
                first = offsets[0]
                self.fail(
                    f"{relative}:{line}: a comment is written into the shader text at offset "
                    f"{first} (…{excerpt(body, first)}…). The preprocessor leaves it alone "
                    "inside a string literal and the emitted WGSL has no newlines of its own, "
                    "so it swallows the rest of its line; write the comment bare instead, so "
                    "the preprocessor strips it (run 37038473832)."
                )

    # The controls. The guard is a model of two lexers, not a compiler: what it claims to
    # catch is checked against the two measured shapes, and against the deliberate form it
    # must keep allowing.

    def test_control_a_stripped_closing_backtick_is_caught(self) -> None:
        body = "  rows.push(`  { // colour channel ${j}`);\n"
        self.assertIsNotNone(js_structure_failure(body), "the guard missed run 37014818279's shape")

    def test_control_a_stripped_interpolation_close_is_caught(self) -> None:
        body = "  const s = `${x // comment }`;\n"
        self.assertIsNotNone(js_structure_failure(body), "the guard missed a stripped `}`")

    def test_control_an_unclosed_paren_is_caught(self) -> None:
        body = "  gpu.draw(x // );\n"
        self.assertIsNotNone(js_structure_failure(body), "the guard missed an unbalanced `(`")

    def test_control_a_bare_comment_inside_shader_text_is_allowed(self) -> None:
        body = '  const code = `a\n// Emulate the D3D viewport in clip space.\nlet nidx = 0;`;\n'
        self.assertIsNone(js_structure_failure(body))
        self.assertEqual(live_shader_comments(body), [])

    def test_control_a_live_comment_in_shader_text_is_caught(self) -> None:
        body = '  const code = `a\n${"// Emulate the D3D viewport."}\nlet nidx = 0;`;\n'
        self.assertEqual(len(live_shader_comments(body)), 1, "the guard missed run 37038473832")

    def test_control_a_slash_slash_inside_a_plain_string_is_allowed(self) -> None:
        body = '  const url = "https://example.invalid/a";\n  fetch(url);\n'
        self.assertEqual(live_shader_comments(body), [])
        self.assertIsNone(js_structure_failure(body))


if __name__ == "__main__":
    unittest.main()
