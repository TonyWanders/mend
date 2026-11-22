[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/TonyWanders/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/TonyWanders/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

`mend` is a command-line tool that applies AI-written edits in four formats to a
tree of text files: unified diffs (often with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and text-editor tool calls as JSON. It finds the lines an
edit names even when the model drifted their whitespace or indentation, and it
changes every file or none. Built for the make.fun bounty "Build mend, one patch
tool for every AI edit format" ($100, ends Tue 24 Nov 2026 15:00 WAT); the full
contract is `SPEC.md`.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory. When
  it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a`, `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and PATCH may come in any order. `--` ends the options.

Node 22 and its standard library only; nothing is installed.

## Exit codes and output

- Exit 0: the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R <old> -> <new>` for a move), in byte order, then `ok: <n> files`.
- Exit 1: nothing is written. One `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then
  `failed: <k> of <n> edits`. Edits after a failed one still run, so every
  failure is reported.
- Exit 2: nothing is written, exactly one line: `error: usage`,
  `error: no-patch`, `error: format`, or `error: parse <N>`.

## Matching

An edit's old lines are found at the first of three tiers where they occur at
least once: tier 0 (every line equal), tier 1 (trailing spaces and tabs
ignored), tier 2 (leading and trailing spaces and tabs ignored). At tier 2,
new lines are re-indented from the old lines' leading whitespace to the
file's. Unified hunks take the occurrence nearest their (possibly wrong) line
number; SEARCH/REPLACE blocks need exactly one occurrence; V4A chunks take the
first at or after a cursor that moves through the file, with anchors and
end-of-file chunks.

## Practice checks

The kit's 100 public practice checks, and the three published practice trial
instances (300 checks), all pass:

    node check.ts kit/hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
    # 100 of 100 passed: practice score 1000

`runner.ts` is the kit's runner, kept as it is; the grader runs
`node main.ts` beside it with `MAKEFUN_ENV_URL` set.

## License

MIT — see `LICENSE` (SPDX-License-Identifier: MIT).
