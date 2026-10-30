"""Module wiring (t_20f1e116): build the store + workers + router.

main.py calls register_ingestion(app, settings) ONCE (like
register_inventory). Everything env-driven reads Settings (Tier-B).

Two independent switches (contract §16.6/§16.8, commit c8e1e7b):
- SOLIN_INGEST_ENABLED=off (DEFAULT) → the router mounts with ZERO
  routes and no workers. Not a silent 503 chain.
- flag ON → ingestion_run_chain gates the CHAIN:
  * off (default, v1 recipe production) → manual/resubmit stays live:
    no queue-drain, no auto-fallback queue, transcript persisted by
    default;
  * on (CI/experiment only) → in-flight queue + ATTEMPTS cap +
    transcript-persist-off engage.
The two default-ON pure-local gates (identity 20/60s, inflight cap)
are wired whenever the router mounts — an empty seed_cluster simply
means "worker input" (§16.6), never a queue-drain mode. seed_inventory
is consumed ONLY via cluster_rules(name); probe_one stays the §5.3
single entry.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI

from .api import build_router
from .pipeline import IngestWorker
from .store import IngestStore


def register_ingestion(app: FastAPI, settings) -> Optional[IngestStore]:
    if not getattr(settings, "ingest_enabled", False):
        return None                          # module OFF (default, C6)

    chain = getattr(settings, "ingestion_run_chain", False)
    data_root = os.path.join(settings.ingest_data_root or "media", "ingest")
    store = IngestStore(
        data_root,
        max_records=settings.ingest_max_records,
        queue_inflight=settings.ingest_queue_inflight,
        submit_per_min=settings.ingest_identity_per_min,
        submit_window_s=settings.ingest_identity_window_s,
        expiry_h=settings.ingest_expiry_h,
    )
    cfg = {
        "enabled": True,
        "data_root": data_root,
        "seed_cluster": settings.ingest_seed_cluster,   # default OFF: ""
        "max_chars": settings.ingest_transcript_max_chars,
        "min_confidence": settings.ingest_trust_threshold,
        "trust_threshold": settings.ingest_trust_threshold,
        "poll_s": settings.worker_poll_s,
        "block_timeout_s": settings.worker_block_timeout_s,
        "asr_cmd": settings.ingest_asr_cmd,            # "" = no provider
        "expiry_h": settings.ingest_expiry_h,
        # defaults from use_cases.md §16.6; ATTEMPTS/queue/persist only
        # mean anything with the chain flag ON (worker-ON scope):
        "chain": chain,
        "attempts": settings.ingest_attempts,
        "queue_inflight": settings.ingest_queue_inflight,
        "transcript_persist": settings.ingest_transcript_persist,
        # §16.3/§16.4: URL kind never queues while the flag is OFF;
        # when ON it queues honestly (no extractor ships in v1).
        "url_fetch": settings.url_fetch,
        "url_fetch_hosts": settings.url_fetch_hosts,
        "services": None,          # CI-injected translator placeholder
    }
    threads = min(4, max(1, settings.worker_threads))   # default 2, max 4
    workers = [IngestWorker(store, cfg, i) for i in range(threads)]
    for w in workers:
        w.start()

    router = build_router(store, cfg)
    app.include_router(router, prefix="/api/v1", tags=["ingestion"])
    app.state.ingest_store = store
    app.state.ingest_workers = workers
    return store
