"""Solin real-product inventory package.

Layout (contract `use_cases.md`):

* :mod:`app.inventory.store`    — canonical flat-file JSON storage at
  ``<DATA_DIR>/store/products.json`` (single-file store; the contract allows
  either JSONB or sibling tables, and a flat store keeps the API shape
  normative and the QA surface identical).
* :mod:`app.inventory.service`  — the CRUD service layer + image slot
  handling. All validation and error semantics live here so the HTTP layer
  stays a thin adapter.
* :mod:`app.inventory.routes`   — the FastAPI ``/inventory`` router (§3).

Paths are NEVER hard-coded in code: ``config.settings.media_root`` /
``config.settings.data_dir`` are the single source of truth (C7).
"""
