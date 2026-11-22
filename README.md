# sawit-site-generator

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/piningit23/sawit-site-generator/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/piningit23/sawit-site-generator/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0, written for the make.fun competition
[site-generator-speed-01-run-20261122](https://make.fun/competitions/site-generator-speed-01-run-20261122)
("Build a static site faster").

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
the output tree makefun-site 1.0.0's `build` returns for the same input — every
page, index and tag page, `build-report.txt` and static file, byte for byte —
but faster: HTML escaping that scans for special characters, memoised slugs
with an ASCII fast path, a hand-rolled Markdown lexer, a single-pass inline
renderer, and a template interpreter over compact node arrays. `main.ts` is
the harness driver: it reads every case from `/input/cases.json`, answers
each with `run`, and writes `/output/answers.json`.
