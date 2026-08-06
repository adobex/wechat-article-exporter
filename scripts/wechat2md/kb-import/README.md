# WeChat KB Import Scripts

Scripts in this directory write exported WeChat article data into Knowledge Vault.
Product-account workflows now land in `knowledge-vault/structured/products`.

## Files

- `batch-products-structured-import.py`: current product-account import entrypoint. `--data-json` is required; dry-run writes an expiring SHA256/candidate/quality receipt, and confirm requires an exact receipt match.
- `cleanup-legacy-product-wiki-import.py`: removes old product-account rows only after every JSONL/embedding pair validates; confirm builds synchronized staging files, keeps a persistent backup, atomically replaces each file, and rolls back on failure.
- `cleanup-wechat-products-structured-noise.py`: removes noisy WeChat product-analysis source docs from active `structured/products` by marking them rejected and refreshing the corresponding source-doc record.
- `batch-wiki-import.py`: legacy wiki-synthesis importer kept only for historical reference. Do not use it for product-account backfill or as a final products KB landing path.
- `write-known-products.py`: write known product records.
- `write-multi-pub-light.py`: write lightweight multi-publication records.
- `write-single-pub.py`: write a single publication record.

## Before Running

Confirm the target knowledge system and output paths first. Do not substitute a
temporary memory file for the named business store.

For scheduled product-account workflows, only import from the current run's
publisher-analysis output directory into `structured/products`. Do not run
no-argument imports that read stale static artifacts.

Normal confirm is blocked when analysis quality fails. The human-only escape
hatch is the explicit `--high-risk-override-quality-gate` plus a written reason;
it always writes an override audit report and must not be used by automation.
Same-slug source rows are merged. Conflicting publishers remain visible as
`needs-review` and never produce a stable attribution edge.

Article-level publisher labels, including a single non-conflicting label, are
stored as candidates only (`attribution_verified: false`). Any article-side
`attribution_verified` flag is retained as an observation but cannot promote a
stable edge; promotion must come from a single-product store-evidence run. The structured
builder must not turn an article mapping into `final_chinese_subject` or a
stable publisher edge; verified single-product OSINT is the promotion path.
Strong package, bundle, Google Play, or App Store identities are used as the
batch grouping key when the extractor captured them, so same-name shells are
not merged accidentally.

For legacy correction, first produce/verify a subject allowlist from the active
wiki rows, then run `batch-products-structured-import.py --include-subjects-file
... --dry-run/--confirm`, then run `cleanup-legacy-product-wiki-import.py
--dry-run/--confirm`. Do not delete wiki rows until the structured dry-run and
confirm have both passed.

The products importer and canonical structured builder share one writer lock.
Document changes are staged and backed up until the staged products runtime has
passed JSONL/SQLite/manifest validation. Temporary staging is removed in
`finally`; explicit cleanup backups and receipts are retained.
