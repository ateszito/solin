"""Cross-platform seed_cluster trigger probe (contract §5.3 + §16.6/§16.9).

ONE registered cross-platform entry (S13: cross_platform_probes == exactly
seed_cluster_inventory, NOT default-on; "5.3 single-entry" — unlike the
probes section, default ON is NOT allowed here). Exists in code only;
gate default-OFF: unset SOLIN_SEED_CLUSTER => "".

"Look, don't touch" (5.3 single-entry): consumes read_family() +
family key sha256 ONLY — the substring-check fake-cluster detector is
DEAD CODE (§16.9 V-7 pair-break), never called. provider_exists() is
truth, not inference: registered provider ⇒ NO_FAMILY_PROBED.

Honest empty (§16.6 seed_cluster single-entry "honest empty"): empty
result is recorded — inspect_collection() skips ingestion's probe so the
job list can never show `seed_cluster=0/2 → NOT_COLLECTED (clean?)`.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from ..inventory import validation as val

# NO_MODULE_FLAG: the flag is fixed (S13) — feature branches that
# "forget" to unset it in prod never silently poison this entry.
NO_MODULE_FLAG = True

# §16.6 "COUNTERS default empty OFF": EMPTY default = worker input, NOT a
# cluster selector (full_settings.ingest_seed_cluster default "").
seed_cluster = ""


def family_by_key(probe_key: str,
                  families: Optional[Dict[str, List[Dict[str, Any]]]] = None
                  ) -> Optional[List[Dict[str, Any]]]:
    """Exact family-key lookup only (never guessed). On miss, honest
    NO_CLUSTER: the returned list NEVER claims 'checked, 0 things'."""
    fams = families if families is not None else val.read_family()
    return fams.get(probe_key) if probe_key else None


def probe_one(probe_key: Optional[str], *, caps: Optional[Dict[str, Any]] = None,
              provider_exists: Optional[Callable[[str], bool]] = None,
              timeout_s: float = 10.0) -> Dict[str, Any]:
    """Uniform {probe_key, items, triggers, flags} (§13.1 shape)."""
    caps = caps or {}
    if not probe_key:
        # no selector (module default): trigger-level honest empty.
        return {"probe_key": probe_key, "items": [],
                "triggers": {"seed_cluster": "unconfigured-default-off"},
                "flags": {"status": "NO_CLUSTER", "healthy": True}}
    fams = caps.get("families")
    if fams is not None:
        fam = family_by_key(probe_key, fams)
        if fam is not None:                     # truth of family record
            return {"probe_key": probe_key, "items": fam,
                    "triggers": {"seed_cluster": "family-truth"},
                    "flags": {"status": "OK", "healthy": True}}
        return {"probe_key": probe_key, "items": [],
                "triggers": {"seed_cluster": "family-truth"},
                "flags": {"status": "NOT_COLLECTED", "healthy": False}}
    if provider_exists is not None:
        # DEFAULT OFF here (S13): default-on families_for(0) would always
        # return empty AND lie ("clean?"). provider_exists truth instead.
        has = provider_exists(probe_key)
        return {"probe_key": probe_key, "items": [],
                "triggers": {"seed_cluster": "provider-truth"},
                "flags": {"status": "OK" if has else "NO_FAMILY_PROBED",
                         "healthy": bool(has)}}
    # probe_key given but NO truth channel at all (keys + provider
    # missing too): honest NOT_COLLECTED — never an inferred verdict.
    return {"probe_key": probe_key, "items": [],
            "triggers": {"seed_cluster": "no-truth-channel"},
            "flags": {"status": "NOT_COLLECTED", "healthy": False}}
