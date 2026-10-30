"""Recipe ingestion module (t_20f1e116, contract §16).

Source (url/upload/manual) → background worker → draft → persist. The whole
module is default-OFF at the route level (SOLIN_INGEST flag, §16.8) and
never touches inventory media slots, media URLs, seeds, or the live unit-
resolver chain (R5). Companion spec: use_cases.md §16 + design/INGESTION.md.
"""
