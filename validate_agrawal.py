"""
================================================================================
validate_agrawal.py — Automated Textbook Validation Suite (Agrawal 5th Ed.)
================================================================================
Course:        26ECE31H — Fiber Optic Communications (BUE)
Project:       Option 2 — Attenuation and Link Power Budget Tool (Group 9)
Primary Ref:   Govind P. Agrawal, "Fiber-Optic Communication Systems,"
               5th Edition, John Wiley & Sons (2021).

Purpose
-------
Validates `physics_engine.py` programmatically against four exact textbook
benchmarks extracted verbatim from `agrawal2021 Fifth Edition.pdf`:
  1. Chapter 5, Section 5.2.3, Table 5.1 (book pp. 158–159, PDF pp. 170–171):
     0.85-um lightwave system power budget (Laser+PIN, LED+PIN, LED+APD).
  2. Chapter 5, Problem 5.4 (book pp. 179–180, PDF pp. 191–192):
     1.3-um LED link with periodic 2-km cable-reel splices.
  3. Chapter 2, Section 2.5.3, Eq. (2.5.4) & Sec. 2.5.4 (book p. 48, PDF p. 62):
     Rayleigh scattering alpha_R = C_R / lam^4 at 1.55 um and macrobend floor.
  4. Chapter 7, Section 7.1.2 (book p. 237, PDF p. 248):
     Periodic lumped optical amplification (G_A = alpha_f * L_A) via Design Mode.

Exit Code
---------
Exits with status code 0 if and only if ALL benchmark assertions pass within
the required < 0.1% error tolerance against exact textbook equations.
================================================================================
"""

from __future__ import annotations

import math
import sys
from typing import Any, Dict, List

from physics_engine import (
    FiberParams,
    LinkConfig,
    compute_fiber_attenuation,
    evaluate_link_budget,
    get_preset_config,
    mw_to_dbm,
    receiver_sensitivity_from_photons,
    solve_max_reach,
    solve_required_amplifiers,
)


def _rel_error_pct(expected: float, computed: float) -> float:
    """Compute relative error in percent; uses absolute diff * 100 when expected == 0."""
    if abs(expected) < 1e-12:
        return abs(computed - expected) * 100.0
    return abs(computed - expected) / abs(expected) * 100.0


def run_all_validations(tolerance_pct: float = 0.1) -> Dict[str, Any]:
    """
    Execute all Agrawal 5th Edition benchmark checks and return a structured
    JSON-serializable report dictionary (also consumed by Phase 3 `/api/validate`).
    """
    checks: List[Dict[str, Any]] = []

    def add_numeric_check(
        group: str,
        name: str,
        expected: float,
        computed: float,
        unit: str,
        note: str = "",
        tol_pct: float = tolerance_pct,
    ) -> None:
        err_pct = _rel_error_pct(expected, computed)
        passed = err_pct < tol_pct
        checks.append({
            "group": group,
            "name": name,
            "expected": expected,
            "computed": computed,
            "unit": unit,
            "error_pct": err_pct,
            "tolerance_pct": tol_pct,
            "passed": passed,
            "note": note,
        })

    def add_exact_check(
        group: str,
        name: str,
        expected: Any,
        computed: Any,
        note: str = "",
    ) -> None:
        passed = expected == computed
        checks.append({
            "group": group,
            "name": name,
            "expected": expected,
            "computed": computed,
            "unit": "exact",
            "error_pct": 0.0 if passed else 100.0,
            "tolerance_pct": 0.0,
            "passed": passed,
            "note": note,
        })

    # ==========================================================================
    # BENCHMARK 1: Agrawal 5e, Ch. 5, Sec. 5.2.3, Table 5.1 (pp. 158–159)
    # 0.85-um, 100 Mb/s, target L = 8 km, alpha_f = 3.5 dB/km, alpha_con = 2 dB, M_s = 6 dB
    # ==========================================================================
    g1 = "Agrawal 5e Table 5.1 (pp. 158-159)"

    # 1a. Laser + p-i-n (P_tr = 0 dBm, P_rec = -42 dBm)
    cfg_laser = get_preset_config("agrawal_table5_1_laser")
    res_laser = evaluate_link_budget(cfg_laser)
    sol_laser = solve_max_reach(cfg_laser)

    add_numeric_check(g1, "Laser+PIN: Available C_L", 36.0, res_laser.available_channel_loss_db, "dB")
    add_numeric_check(
        g1,
        "Laser+PIN: Max Reach L_max (exact 34/3.5)",
        34.0 / 3.5,
        sol_laser.solved_max_reach_km or 0.0,
        "km",
        note="Table 5.1 prints 9.7 km (1-dec rounded; exact 34/3.5 = 9.7143 km)",
    )
    add_numeric_check(g1, "Laser+PIN: P_rx at L=8 km", -30.0, res_laser.received_power_dbm, "dBm")
    add_numeric_check(g1, "Laser+PIN: Net Margin at L=8 km", 6.0, res_laser.net_margin_db, "dB")
    add_exact_check(g1, "Laser+PIN: Pass/Fail at L=8 km", "PASS", res_laser.status_label)

    # 1b. LED + p-i-n (P_tr = -13 dBm, P_rec = -42 dBm)
    cfg_led = get_preset_config("agrawal_table5_1_led")
    res_led = evaluate_link_budget(cfg_led)
    sol_led = solve_max_reach(cfg_led)

    add_numeric_check(g1, "LED+PIN: Available C_L", 23.0, res_led.available_channel_loss_db, "dB")
    add_numeric_check(
        g1,
        "LED+PIN: Max Reach L_max",
        6.0,
        sol_led.solved_max_reach_km or 0.0,
        "km",
        note="Matches Table 5.1 (6 km) identically",
    )
    add_numeric_check(g1, "LED+PIN: P_rx at L=8 km", -43.0, res_led.received_power_dbm, "dBm")
    add_numeric_check(g1, "LED+PIN: Net Margin at L=8 km", -7.0, res_led.net_margin_db, "dB")
    add_exact_check(g1, "LED+PIN: Pass/Fail at L=8 km", "FAIL", res_led.status_label)

    # 1c. LED + APD (P_tr = -13 dBm, P_rec = -49 dBm [+7 dB APD improvement])
    cfg_apd = get_preset_config("agrawal_table5_1_led_apd")
    res_apd = evaluate_link_budget(cfg_apd)
    sol_apd = solve_max_reach(cfg_apd)

    add_numeric_check(g1, "LED+APD: Available C_L", 30.0, res_apd.available_channel_loss_db, "dB")
    add_numeric_check(
        g1,
        "LED+APD: Max Reach L_max",
        8.0,
        sol_apd.solved_max_reach_km or 0.0,
        "km",
        note="Matches Sec. 5.2.3 text (8 km) identically",
    )
    add_numeric_check(g1, "LED+APD: P_rx at L=8 km", -43.0, res_apd.received_power_dbm, "dBm")
    add_numeric_check(g1, "LED+APD: Net Margin at L=8 km", 0.0, res_apd.net_margin_db, "dB")
    add_exact_check(g1, "LED+APD: Pass/Fail at L=8 km", "PASS", res_apd.status_label)

    # 1d. Photon-limit sensitivity consistency check (N_p=2500, B=100 Mb/s, 850 nm -> -42.33 dBm ≈ -42 dBm)
    p_rec_photon = receiver_sensitivity_from_photons(2500.0, 100e6, 850.0)
    expected_p_rec_photon = 10.0 * math.log10(2500.0 * 6.62607015e-34 * 2.99792458e8 / 0.85e-6 * 100e6 / 1e-3)
    add_numeric_check(
        g1,
        "Photon Sensitivity (2500 ph/bit, 100 Mb/s)",
        expected_p_rec_photon,
        p_rec_photon,
        "dBm",
        note="Textbook rounds -42.33 dBm to -42 dBm",
    )

    # ==========================================================================
    # BENCHMARK 2: Agrawal 5e, Ch. 5, Problem 5.4 (book pp. 179–180, PDF pp. 191–192)
    # 1.3-um LED (0.1 mW = -10 dBm), P_rec = 100 nW = -40 dBm, alpha_f = 1.0 dB/km,
    # 0.2 dB splice every 2 km, 2 x 1 dB connectors, M_s = 6 dB
    # ==========================================================================
    g2 = "Agrawal 5e Problem 5.4 (pp. 179-180)"

    p_tx_54 = mw_to_dbm(0.1)          # -10.0 dBm
    p_rec_54 = mw_to_dbm(100e-6)      # 100 nW = 1e-4 mW = -40.0 dBm
    cfg_p54 = LinkConfig(
        wavelength_nm=1300.0,
        fiber_length_km=20.0,
        tx_power_dbm=p_tx_54,
        rx_sensitivity_dbm=p_rec_54,
        system_margin_db=6.0,
        num_connectors=2,
        loss_per_connector_db=1.0,
        splice_mode="reel",
        reel_length_km=2.0,
        loss_per_splice_db=0.2,
        splitter_mode="ratio",
        split_ratio=1,
        num_amplifiers=0,
        fiber_params=FiberParams(name="Problem 5.4 Cable", alpha_override_db_per_km=1.0),
    )
    res_p54 = evaluate_link_budget(cfg_p54)
    sol_p54 = solve_max_reach(cfg_p54)

    add_numeric_check(g2, "Available C_L", 24.0, res_p54.available_channel_loss_db, "dB")
    add_numeric_check(
        g2,
        "Max Reach L_max (distributed 1.1 dB/km)",
        20.0,
        sol_p54.solved_max_reach_distributed_km or 0.0,
        "km",
    )
    add_numeric_check(
        g2,
        "Max Reach L_max (discrete 2-km reels)",
        20.0,
        sol_p54.solved_max_reach_km or 0.0,
        "km",
        note="9 interior splices at 2..18 km -> 21.8 dB <= 22 dB; 10th splice at 20+ km exceeds budget",
    )

    # ==========================================================================
    # BENCHMARK 3: Agrawal 5e, Ch. 2, Sec. 2.5.3 Eq. (2.5.4) & Sec. 2.5.4 (p. 48)
    # Rayleigh scattering alpha_R(1.55 um) = C_R / 1.55^4 for C_R in [0.7, 0.9]
    # ==========================================================================
    g3 = "Agrawal 5e Eq. (2.5.4) & Sec. 2.5.4 (p. 48)"

    att_cr07 = compute_fiber_attenuation(1550.0, FiberParams(rayleigh_coeff_cr=0.7))
    att_cr09 = compute_fiber_attenuation(1550.0, FiberParams(rayleigh_coeff_cr=0.9))
    expected_r07 = 0.7 / (1.55 ** 4)
    expected_r09 = 0.9 / (1.55 ** 4)

    add_numeric_check(
        g3,
        "Rayleigh alpha_R at 1550 nm (C_R=0.7)",
        expected_r07,
        att_cr07.rayleigh_db_per_km,
        "dB/km",
        note="Textbook quotes 0.12-0.16 dB/km range",
    )
    add_numeric_check(
        g3,
        "Rayleigh alpha_R at 1550 nm (C_R=0.9)",
        expected_r09,
        att_cr09.rayleigh_db_per_km,
        "dB/km",
        note="Textbook quotes 0.12-0.16 dB/km range",
    )
    add_exact_check(
        g3,
        "Macrobending negligible (<0.01 dB/km) at R=30 mm",
        True,
        att_cr07.macrobending_db_per_km < 0.01,
        note=f"Computed {att_cr07.macrobending_db_per_km:.2e} dB/km",
    )

    # ==========================================================================
    # BENCHMARK 4: Agrawal 5e, Ch. 7, Sec. 7.1.2 (book p. 237, PDF p. 248)
    # Periodic Lumped Amplification: 400 km, 0.2 dB/km, 0 dBm TX, -28 dBm RX,
    # 4 dB margin, 2 dB connectors, G_amp = 20 dB -> N_amp = 3 (4 spans of 100 km)
    # ==========================================================================
    g4 = "Agrawal 5e Sec. 7.1.2 (p. 237)"

    cfg_amp = LinkConfig(
        wavelength_nm=1550.0,
        fiber_length_km=400.0,
        tx_power_dbm=0.0,
        rx_sensitivity_dbm=-28.0,
        system_margin_db=4.0,
        num_connectors=2,
        loss_per_connector_db=1.0,
        splice_mode="fixed",
        num_splices=0,
        loss_per_splice_db=0.0,
        splitter_mode="ratio",
        split_ratio=1,
        num_amplifiers=0,
        amp_gain_db=20.0,
        amp_sat_enabled=False,
        fiber_params=FiberParams(name="Sec. 7.1.2 1550 nm Fiber", alpha_override_db_per_km=0.2),
    )
    sol_amp = solve_required_amplifiers(cfg_amp, target_length_km=400.0)

    add_exact_check(g4, "Design Mode: Required Amplifiers N_amp", 3, sol_amp.solved_num_amplifiers)
    add_numeric_check(g4, "Uniform Span Length L_span", 100.0, sol_amp.span_length_km or 0.0, "km")
    add_numeric_check(
        g4,
        "Per-Span Loss G_A = alpha_f * L_span",
        20.0,
        sol_amp.span_loss_db or 0.0,
        "dB",
    )
    add_numeric_check(
        g4,
        "Verified Received Power P_rx (with 3 amps)",
        -22.0,
        sol_amp.verified_result.received_power_dbm,
        "dBm",
    )
    add_numeric_check(
        g4,
        "Spatial Trace Endpoint vs. Budget P_rx",
        sol_amp.verified_result.received_power_dbm,
        sol_amp.verified_result.power_profile[-1].power_dbm,
        "dBm",
        note="Verifies exact self-consistency between P(z) profile and scalar power budget",
    )

    total = len(checks)
    passed_count = sum(1 for c in checks if c["passed"])
    return {
        "all_passed": passed_count == total,
        "passed_count": passed_count,
        "total_count": total,
        "tolerance_pct": tolerance_pct,
        "checks": checks,
    }


def print_validation_report(report: Dict[str, Any]) -> None:
    """Print a clean formatted engineering benchmark table to stdout."""
    sep = "=" * 108
    sub = "-" * 108
    print(sep)
    print("  AGRAWAL (5th Ed., 2021) AUTOMATED PHYSICS VALIDATION SUITE — Option 2: Link Power Budget Tool")
    print(sep)
    header = f"{'Test Case':<46} | {'Expected':>14} | {'Computed':>14} | {'Error (%)':>10} | {'Status':>6}"
    print(header)
    print(sub)

    current_group = None
    for item in report["checks"]:
        if item["group"] != current_group:
            current_group = item["group"]
            print(f"[{current_group}]")

        if item["unit"] == "exact":
            exp_str = str(item["expected"])
            cmp_str = str(item["computed"])
        else:
            exp_str = f"{item['expected']:.4f} {item['unit']}"
            cmp_str = f"{item['computed']:.4f} {item['unit']}"

        err_str = f"{item['error_pct']:.5f}%"
        status = "PASS" if item["passed"] else "FAIL"
        print(f"  {item['name']:<44} | {exp_str:>14} | {cmp_str:>14} | {err_str:>10} | {status:>6}")

    print(sub)
    verdict = "ALL TESTS PASSED" if report["all_passed"] else "VALIDATION FAILED"
    print(
        f"  SUMMARY: {report['passed_count']}/{report['total_count']} checks passed "
        f"(tolerance < {report['tolerance_pct']:.2f}%)  -->  {verdict}"
    )
    print(sep)


def main() -> int:
    report = run_all_validations(tolerance_pct=0.1)
    print_validation_report(report)
    return 0 if report["all_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
