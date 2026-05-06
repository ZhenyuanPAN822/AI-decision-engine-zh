"""
Decision Simulator — deterministic Monte Carlo engine.

Pipeline contract:
    LLM (MODEL-PARAMS) -> sim_spec (JSON) -> simulator.simulate() -> sim_results (JSON) -> LLM (MODEL-INTERPRET)

The LLM never writes simulation code. It selects from a fixed distribution
menu and fills numeric parameters. This module owns all numeric work:
sampling, normalization, weighted aggregation, and sensitivity analysis.

Pure standard library — no numpy / scipy.
"""

import math
import random
import time
from statistics import mean, median, pstdev


DISTRIBUTIONS = {
    "normal":      ["mean", "sd"],
    "lognormal":   ["mean", "sd"],          # mean & sd of the underlying normal
    "triangular":  ["min", "mode", "max"],
    "beta":        ["alpha", "beta", "min", "max"],
    "uniform":     ["min", "max"],
    "bernoulli":   ["p"],
    "categorical": ["choices"],             # [{"value": float, "p": float}, ...]
}

MIN_ITER = 1000
MAX_ITER = 100_000
DEFAULT_ITER = 10_000
HARD_TIMEOUT_SEC = 15.0
SENSITIVITY_DELTA = 0.20  # ±20% perturbation


class SpecError(ValueError):
    """Raised when a sim_spec fails validation."""


# ── Validation ───────────────────────────────────────────────

def validate(spec):
    """Return a list of error strings; empty list means OK."""
    errors = []
    if not isinstance(spec, dict):
        return ["spec must be a JSON object"]

    options = spec.get("options")
    if not isinstance(options, list) or len(options) < 2:
        errors.append("options: need a list of at least 2 option names")
        options = []

    scenarios = spec.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        errors.append("scenarios: need at least 1 scenario")
        scenarios = []
    else:
        ptot = 0.0
        seen_ids = set()
        for s in scenarios:
            sid = s.get("id")
            if not sid or sid in seen_ids:
                errors.append(f"scenario id missing or duplicated: {sid!r}")
            seen_ids.add(sid)
            p = s.get("probability", 0)
            if not isinstance(p, (int, float)) or not (0 <= p <= 1):
                errors.append(f"scenario {sid!r}: probability must be in [0,1]")
            else:
                ptot += p
        if not (0.95 <= ptot <= 1.05):
            errors.append(f"scenario probabilities must sum to ~1.0 (got {ptot:.3f})")

    outcomes = spec.get("outcomes")
    if not isinstance(outcomes, list) or not outcomes:
        errors.append("outcomes: need at least 1 outcome")
        outcomes = []
    else:
        wtot = 0.0
        seen_ids = set()
        for o in outcomes:
            oid = o.get("id")
            if not oid or oid in seen_ids:
                errors.append(f"outcome id missing or duplicated: {oid!r}")
            seen_ids.add(oid)

            w = o.get("weight", 0)
            if not isinstance(w, (int, float)) or w < 0:
                errors.append(f"outcome {oid!r}: weight must be a number >= 0")
            else:
                wtot += w

            if o.get("direction") not in ("higher_better", "lower_better"):
                errors.append(f"outcome {oid!r}: direction must be 'higher_better' or 'lower_better'")

            r = o.get("expected_range")
            if not (isinstance(r, list) and len(r) == 2
                    and isinstance(r[0], (int, float)) and isinstance(r[1], (int, float))
                    and r[0] < r[1]):
                errors.append(f"outcome {oid!r}: expected_range must be [min, max] with min<max")

            per_opt = o.get("per_option")
            if not isinstance(per_opt, dict):
                errors.append(f"outcome {oid!r}: per_option must be an object keyed by option name")
                continue
            for opt in options:
                if opt not in per_opt:
                    errors.append(f"outcome {oid!r}: missing per_option entry for {opt!r}")
                    continue
                opt_block = per_opt[opt]
                if not isinstance(opt_block, dict):
                    errors.append(f"outcome {oid!r} option {opt!r}: must be a scenario->dist map")
                    continue
                for s in scenarios:
                    sid = s.get("id")
                    dist_def = opt_block.get(sid)
                    if not isinstance(dist_def, dict):
                        errors.append(f"outcome {oid!r} {opt!r}/{sid!r}: missing distribution spec")
                        continue
                    dn = dist_def.get("dist")
                    pr = dist_def.get("params") or {}
                    if dn not in DISTRIBUTIONS:
                        errors.append(f"unknown distribution {dn!r} (allowed: {list(DISTRIBUTIONS)})")
                        continue
                    for need in DISTRIBUTIONS[dn]:
                        if need not in pr:
                            errors.append(f"outcome {oid!r} {opt!r}/{sid!r}: dist '{dn}' missing param '{need}'")
                    errors.extend(_check_dist_params(dn, pr, f"outcome {oid!r} {opt!r}/{sid!r}"))

        if wtot <= 0:
            errors.append("outcome weights must sum to > 0")

    n = spec.get("n_iterations", DEFAULT_ITER)
    if not (isinstance(n, int) and MIN_ITER <= n <= MAX_ITER):
        errors.append(f"n_iterations must be an integer in [{MIN_ITER}, {MAX_ITER}]")

    return errors


def _check_dist_params(dn, pr, ctx):
    e = []
    try:
        if dn in ("normal", "lognormal"):
            if not (isinstance(pr.get("sd"), (int, float)) and pr["sd"] > 0):
                e.append(f"{ctx}: {dn} sd must be > 0")
        elif dn == "triangular":
            mn, md, mx = pr.get("min"), pr.get("mode"), pr.get("max")
            if None in (mn, md, mx) or not (mn <= md <= mx) or mn == mx:
                e.append(f"{ctx}: triangular requires min <= mode <= max with min < max")
        elif dn == "beta":
            a, b = pr.get("alpha"), pr.get("beta")
            mn, mx = pr.get("min"), pr.get("max")
            if not (isinstance(a, (int, float)) and a > 0):
                e.append(f"{ctx}: beta alpha must be > 0")
            if not (isinstance(b, (int, float)) and b > 0):
                e.append(f"{ctx}: beta beta must be > 0")
            if mn is None or mx is None or mn >= mx:
                e.append(f"{ctx}: beta requires min < max")
        elif dn == "uniform":
            if pr.get("min") is None or pr.get("max") is None or pr["min"] >= pr["max"]:
                e.append(f"{ctx}: uniform requires min < max")
        elif dn == "bernoulli":
            p = pr.get("p")
            if not (isinstance(p, (int, float)) and 0 <= p <= 1):
                e.append(f"{ctx}: bernoulli p must be in [0,1]")
        elif dn == "categorical":
            ch = pr.get("choices")
            if not isinstance(ch, list) or not ch:
                e.append(f"{ctx}: categorical requires non-empty 'choices' list")
            else:
                ps = 0.0
                for c in ch:
                    if not isinstance(c, dict) or "value" not in c or "p" not in c:
                        e.append(f"{ctx}: each choice needs 'value' and 'p'")
                        return e
                    ps += c["p"]
                if not (0.95 <= ps <= 1.05):
                    e.append(f"{ctx}: categorical choice probabilities must sum to ~1.0 (got {ps:.3f})")
    except (TypeError, ValueError) as ex:
        e.append(f"{ctx}: parameter check error: {ex}")
    return e


# ── Sampling ─────────────────────────────────────────────────

def _sample(rng, dist_name, params):
    if dist_name == "normal":
        return rng.gauss(params["mean"], params["sd"])
    if dist_name == "lognormal":
        return rng.lognormvariate(params["mean"], params["sd"])
    if dist_name == "triangular":
        return rng.triangular(params["min"], params["max"], params["mode"])
    if dist_name == "beta":
        b = rng.betavariate(params["alpha"], params["beta"])
        return params["min"] + b * (params["max"] - params["min"])
    if dist_name == "uniform":
        return rng.uniform(params["min"], params["max"])
    if dist_name == "bernoulli":
        return 1.0 if rng.random() < params["p"] else 0.0
    if dist_name == "categorical":
        r = rng.random()
        cum = 0.0
        for ch in params["choices"]:
            cum += ch["p"]
            if r <= cum:
                return float(ch["value"])
        return float(params["choices"][-1]["value"])
    raise SpecError(f"unknown distribution {dist_name!r}")


def _normalize(value, expected_range, direction):
    lo, hi = expected_range
    v = max(lo, min(hi, value))
    norm = (v - lo) / (hi - lo) * 100.0
    if direction == "lower_better":
        norm = 100.0 - norm
    return norm


def _aggregate(samples):
    if not samples:
        return {"mean": 0.0, "median": 0.0, "std": 0.0,
                "p10": 0.0, "p50": 0.0, "p90": 0.0,
                "min": 0.0, "max": 0.0, "n": 0}
    s = sorted(samples)
    n = len(s)
    def pct(p):
        idx = max(0, min(n - 1, int(p * (n - 1))))
        return s[idx]
    return {
        "mean":   round(mean(s), 3),
        "median": round(median(s), 3),
        "std":    round(pstdev(s) if n > 1 else 0.0, 3),
        "p10":    round(pct(0.10), 3),
        "p50":    round(pct(0.50), 3),
        "p90":    round(pct(0.90), 3),
        "min":    round(s[0], 3),
        "max":    round(s[-1], 3),
        "n":      n,
    }


# ── Core simulation ──────────────────────────────────────────

def _run(spec, weight_overrides=None, scen_prob_overrides=None, seed=None):
    rng = random.Random(seed if seed is not None else spec.get("seed", 42))
    options = spec["options"]
    scenarios = spec["scenarios"]
    outcomes = spec["outcomes"]
    n = spec.get("n_iterations", DEFAULT_ITER)

    weights = {}
    wsum = 0.0
    for o in outcomes:
        w = (weight_overrides or {}).get(o["id"], o["weight"])
        weights[o["id"]] = max(0.0, w)
        wsum += weights[o["id"]]
    if wsum > 0:
        for k in weights:
            weights[k] /= wsum

    probs = []
    psum = 0.0
    for s in scenarios:
        p = (scen_prob_overrides or {}).get(s["id"], s["probability"])
        p = max(0.0, p)
        probs.append((s["id"], p))
        psum += p
    if psum <= 0:
        probs = [(sid, 1.0 / len(probs)) for sid, _ in probs]
    else:
        probs = [(sid, p / psum) for sid, p in probs]

    per_opt = {opt: {"utility": [],
                     "per_outcome": {o["id"]: [] for o in outcomes},
                     "per_scenario": {s["id"]: [] for s in scenarios}}
               for opt in options}

    for _ in range(n):
        r = rng.random()
        cum = 0.0
        chosen = probs[-1][0]
        for sid, p in probs:
            cum += p
            if r <= cum:
                chosen = sid
                break

        for opt in options:
            util = 0.0
            for o in outcomes:
                dist_def = o["per_option"][opt][chosen]
                raw = _sample(rng, dist_def["dist"], dist_def["params"])
                norm = _normalize(raw, o["expected_range"], o["direction"])
                per_opt[opt]["per_outcome"][o["id"]].append(norm)
                util += weights[o["id"]] * norm
            per_opt[opt]["utility"].append(util)
            per_opt[opt]["per_scenario"][chosen].append(util)

    summary = {}
    for opt in options:
        summary[opt] = {
            "utility":      _aggregate(per_opt[opt]["utility"]),
            "per_outcome":  {oid: _aggregate(v) for oid, v in per_opt[opt]["per_outcome"].items()},
            "per_scenario": {sid: _aggregate(v) for sid, v in per_opt[opt]["per_scenario"].items()},
        }
    return summary, weights, dict(probs)


def _rank(summary):
    return sorted(summary.keys(), key=lambda o: -summary[o]["utility"]["mean"])


# ── Public entry point ───────────────────────────────────────

def simulate(spec):
    """
    Run base simulation + sensitivity analysis.

    Raises SpecError on validation failure (caller should map to HTTP 400).
    Returns a JSON-serializable dict.
    """
    t0 = time.time()
    errs = validate(spec)
    if errs:
        raise SpecError(errs)

    base_summary, weights_used, probs_used = _run(spec)
    base_rank = _rank(base_summary)

    sens = []
    base_seed = int(spec.get("seed", 42))

    # Perturb each outcome weight ±SENSITIVITY_DELTA
    for o in spec["outcomes"]:
        for delta in (-SENSITIVITY_DELTA, SENSITIVITY_DELTA):
            if time.time() - t0 > HARD_TIMEOUT_SEC:
                break
            ow = {o["id"]: o["weight"] * (1 + delta)}
            res, _, _ = _run(spec, weight_overrides=ow, seed=base_seed + 101)
            r = _rank(res)
            sens.append({
                "type": "weight",
                "target": o["id"],
                "delta_pct": int(delta * 100),
                "perturbation": f"weight[{o['id']}] {('+' if delta > 0 else '')}{int(delta * 100)}%",
                "new_top": r[0],
                "rank_changed": r[0] != base_rank[0],
            })

    # Perturb each scenario probability ±SENSITIVITY_DELTA
    for s in spec["scenarios"]:
        for delta in (-SENSITIVITY_DELTA, SENSITIVITY_DELTA):
            if time.time() - t0 > HARD_TIMEOUT_SEC:
                break
            sp = {s["id"]: s["probability"] * (1 + delta)}
            res, _, _ = _run(spec, scen_prob_overrides=sp, seed=base_seed + 211)
            r = _rank(res)
            sens.append({
                "type": "scenario_probability",
                "target": s["id"],
                "delta_pct": int(delta * 100),
                "perturbation": f"P[{s['id']}] {('+' if delta > 0 else '')}{int(delta * 100)}%",
                "new_top": r[0],
                "rank_changed": r[0] != base_rank[0],
            })

    flips = sum(1 for s in sens if s["rank_changed"])
    if flips == 0:
        stability = "stable"
    elif flips <= max(1, len(sens) // 4):
        stability = "partially_stable"
    else:
        stability = "unstable"

    if len(base_rank) >= 2:
        u1 = base_summary[base_rank[0]]["utility"]["mean"]
        u2 = base_summary[base_rank[1]]["utility"]["mean"]
        gap_pct = (u1 - u2) / u1 * 100.0 if u1 > 0 else 0.0
    else:
        gap_pct = 0.0

    return {
        "ok": True,
        "ranking": base_rank,
        "per_option": base_summary,
        "weights_used": {k: round(v, 4) for k, v in weights_used.items()},
        "scenario_probs_used": {k: round(v, 4) for k, v in probs_used.items()},
        "top1_vs_top2_utility_gap_pct": round(gap_pct, 2),
        "sensitivity": sens,
        "rank_flip_count": flips,
        "ranking_stability": stability,
        "n_iterations": spec.get("n_iterations", DEFAULT_ITER),
        "elapsed_sec": round(time.time() - t0, 3),
    }


# ── Self-test ────────────────────────────────────────────────

if __name__ == "__main__":
    import json
    demo = {
        "options": ["A", "B", "C"],
        "scenarios": [
            {"id": "baseline", "probability": 0.6},
            {"id": "downside", "probability": 0.4},
        ],
        "outcomes": [
            {
                "id": "satisfaction",
                "name": "Satisfaction",
                "direction": "higher_better",
                "weight": 0.6,
                "expected_range": [0, 100],
                "per_option": {
                    "A": {"baseline": {"dist": "triangular", "params": {"min": 50, "mode": 75, "max": 90}},
                          "downside": {"dist": "normal",     "params": {"mean": 55, "sd": 10}}},
                    "B": {"baseline": {"dist": "normal",     "params": {"mean": 70, "sd": 8}},
                          "downside": {"dist": "normal",     "params": {"mean": 50, "sd": 12}}},
                    "C": {"baseline": {"dist": "uniform",    "params": {"min": 40, "max": 80}},
                          "downside": {"dist": "uniform",    "params": {"min": 30, "max": 60}}},
                },
            },
            {
                "id": "cost",
                "name": "Cost",
                "direction": "lower_better",
                "weight": 0.4,
                "expected_range": [0, 1000],
                "per_option": {
                    "A": {"baseline": {"dist": "normal", "params": {"mean": 600, "sd": 100}},
                          "downside": {"dist": "normal", "params": {"mean": 700, "sd": 150}}},
                    "B": {"baseline": {"dist": "normal", "params": {"mean": 400, "sd": 80}},
                          "downside": {"dist": "normal", "params": {"mean": 500, "sd": 100}}},
                    "C": {"baseline": {"dist": "normal", "params": {"mean": 300, "sd": 60}},
                          "downside": {"dist": "normal", "params": {"mean": 350, "sd": 80}}},
                },
            },
        ],
        "n_iterations": 5000,
        "seed": 42,
    }
    out = simulate(demo)
    print(json.dumps(out, indent=2))
