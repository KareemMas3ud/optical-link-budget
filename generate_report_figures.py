"""
================================================================================
generate_report_figures.py — 300 DPI Publication-Grade Report Figures
================================================================================
Course:        26ECE31H — Fiber Optic Communications (BUE)
Project:       Option 2 — Attenuation and Link Power Budget Tool (Group 9)

Generates five crisp, 300 DPI Matplotlib figures saved in `report_figures/`
for direct inclusion in the 5–8 page Technical Engineering Report:
  1. fig0_attenuation_spectrum.png  — Silica fiber attenuation spectrum (800–1700 nm)
                                      decomposed by physical mechanism (Agrawal Fig. 2.14–2.15)
  2. fig1_power_level_diagram.png   — Spatial Power-Level Diagram P(z) showing connector,
                                      splice, splitter drops & in-line EDFA gain jumps
  3. fig2_loss_breakdown.png        — Two-panel Loss Breakdown (FTTH GPON link budget +
                                      wavelength-dependent attenuation mechanism share)
  4. fig3_margin_vs_length.png      — Net Link Margin vs. Fiber Length at 850, 1310, 1550 nm
                                      with 0 dB Pass/Fail threshold and L_max crossings
  5. fig4_agrawal_validation.png    — Agrawal 5e Table 5.1 worked example validation plot
                                      (Laser+PIN, LED+PIN, LED+APD vs. 8 km target)
================================================================================
"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import List

import matplotlib
matplotlib.use("Agg")  # Non-interactive backend for reliable headless PNG rendering
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

from physics_engine import (
    FIBER_PRESETS,
    FiberParams,
    LinkConfig,
    compute_attenuation_spectrum,
    compute_fiber_attenuation,
    compute_margin_vs_length,
    evaluate_link_budget,
    get_preset_config,
    solve_max_reach,
)

# ------------------------------------------------------------------------------
# Consistent Optical-Engineering Figure Styling
# ------------------------------------------------------------------------------
OUT_DIR = Path(__file__).resolve().parent / "report_figures"
DPI = 300

COLORS = {
    "ink": "#0F172A",
    "muted": "#475569",
    "grid": "#CBD5E1",
    "bg": "#FFFFFF",
    "wl_850": "#C2410C",     # 850 nm — Burnt Vermilion
    "wl_1310": "#1D4ED8",    # 1310 nm — Cobalt Blue
    "wl_1550": "#0F766E",    # 1550 nm — Deep Teal
    "rayleigh": "#2563EB",
    "uv": "#7C3AED",
    "ir": "#D97706",
    "oh": "#DC2626",
    "wg": "#64748B",
    "bend": "#EA580C",
    "pass": "#15803D",
    "fail": "#B91C1C",
    "amp": "#15803D",
    "splitter": "#7C3AED",
    "connector": "#0284C7",
    "splice": "#D97706",
    "margin": "#475569",
    "dry_fiber": "#0F766E",
}


def _configure_matplotlib() -> None:
    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 10.0,
        "axes.titlesize": 12.0,
        "axes.titleweight": "bold",
        "axes.labelsize": 10.5,
        "axes.labelweight": "normal",
        "axes.edgecolor": "#334155",
        "axes.linewidth": 0.9,
        "axes.facecolor": COLORS["bg"],
        "figure.facecolor": COLORS["bg"],
        "xtick.labelsize": 9.5,
        "ytick.labelsize": 9.5,
        "xtick.color": COLORS["ink"],
        "ytick.color": COLORS["ink"],
        "text.color": COLORS["ink"],
        "legend.fontsize": 8.8,
        "legend.frameon": True,
        "legend.facecolor": "#FFFFFF",
        "legend.edgecolor": "#CBD5E1",
        "legend.framealpha": 0.95,
        "grid.color": COLORS["grid"],
        "grid.linestyle": "--",
        "grid.linewidth": 0.65,
        "grid.alpha": 0.75,
        "savefig.dpi": DPI,
    })


def _style_axes(ax: plt.Axes) -> None:
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.grid(True, which="major")


# ==============================================================================
# FIGURE 0: Silica Fiber Attenuation Spectrum & Mechanism Decomposition
# ==============================================================================
def make_fig0_attenuation_spectrum() -> Path:
    wl = np.linspace(800.0, 1700.0, 451)
    fp_conv = copy.deepcopy(FIBER_PRESETS["smf28_conventional"])
    fp_dry = copy.deepcopy(FIBER_PRESETS["smf28_dry"])

    spec_conv = compute_attenuation_spectrum(wl, fp_conv)
    spec_dry = compute_attenuation_spectrum(wl, fp_dry)

    fig, ax = plt.subplots(figsize=(9.2, 5.4))
    _style_axes(ax)

    # Shaded telecom bands (subtle)
    ax.axvspan(1260, 1360, color="#DBEAFE", alpha=0.35, zorder=0)
    ax.axvspan(1530, 1565, color="#CCFBF1", alpha=0.45, zorder=0)
    ax.text(1310, 7.2, "O-Band\n(1310 nm)", ha="center", va="top", fontsize=8.3, color=COLORS["wl_1310"], weight="bold")
    ax.text(1547.5, 7.2, "C-Band\n(1550 nm)", ha="center", va="top", fontsize=8.3, color=COLORS["wl_1550"], weight="bold")

    # Individual physical mechanisms (dashed/dotted)
    ax.semilogy(wl, spec_conv["rayleigh"], linestyle="--", linewidth=1.4, color=COLORS["rayleigh"],
                label=r"Rayleigh scattering ($\alpha_R = C_R / \lambda^4$)")
    ax.semilogy(wl, spec_conv["uv_absorption"], linestyle=":", linewidth=1.4, color=COLORS["uv"],
                label=r"UV electronic absorption tail ($\alpha_{\mathrm{UV}}$)")
    ax.semilogy(wl, spec_conv["ir_absorption"], linestyle="-.", linewidth=1.4, color=COLORS["ir"],
                label=r"IR vibrational absorption tail ($\alpha_{\mathrm{IR}}$)")
    ax.semilogy(wl, spec_conv["waveguide"], linestyle=(0, (3, 2, 1, 2)), linewidth=1.2, color=COLORS["wg"],
                label=r"Waveguide imperfections ($\alpha_{\mathrm{wg}} = 0.015\ \mathrm{dB/km}$)")

    # Total curves (conventional vs. dry fiber — matching Agrawal Fig. 2.15)
    ax.semilogy(wl, spec_conv["total"], linewidth=2.3, color=COLORS["ink"],
                label="Total — Conventional SMF-28 (G.652.B, 15 ppb OH⁻)", zorder=4)
    ax.semilogy(wl, spec_dry["total"], linewidth=2.0, linestyle="--", color=COLORS["dry_fiber"],
                label="Total — Dry SMF (G.652.D / AllWave, 0.5 ppb OH⁻)", zorder=5)

    # Highlight the 1385 nm OH- water peak
    a_oh_peak = compute_fiber_attenuation(1385.0, fp_conv).total_db_per_km
    ax.annotate(
        f"OH⁻ Water Peak\n1385 nm ({a_oh_peak:.2f} dB/km)",
        xy=(1385.0, a_oh_peak),
        xytext=(1415.0, 2.35),
        fontsize=8.5,
        color=COLORS["oh"],
        weight="bold",
        bbox=dict(boxstyle="round,pad=0.3", fc="#FFF5F5", ec=COLORS["oh"], lw=0.8),
        arrowprops=dict(arrowstyle="->", color=COLORS["oh"], lw=1.1, connectionstyle="arc3,rad=-0.15"),
    )

    # Standard window callouts: 850, 1310, 1550 nm
    window_specs = [
        (850.0, COLORS["wl_850"], (925.0, 3.85)),
        (1310.0, COLORS["wl_1310"], (1120.0, 0.145)),
        (1550.0, COLORS["wl_1550"], (1550.0, 0.048)),
    ]
    for w_nm, col, text_xy in window_specs:
        bd = compute_fiber_attenuation(w_nm, fp_conv)
        ax.axvline(w_nm, color=col, linestyle=":", linewidth=1.0, alpha=0.65, zorder=2)
        ax.scatter([w_nm], [bd.total_db_per_km], s=48, color=col, edgecolor="#FFFFFF", linewidth=1.0, zorder=6)
        ax.annotate(
            f"{int(w_nm)} nm\n{bd.total_db_per_km:.3f} dB/km\n(Rayleigh: {bd.rayleigh_db_per_km:.3f})",
            xy=(w_nm, bd.total_db_per_km),
            xytext=text_xy,
            ha="center",
            fontsize=8.3,
            color=col,
            weight="bold",
            bbox=dict(boxstyle="round,pad=0.3", fc="#FFFFFF", ec=col, lw=0.9),
            arrowprops=dict(arrowstyle="->", color=col, lw=1.0),
            zorder=7,
        )

    ax.set_xlim(800, 1700)
    ax.set_ylim(0.01, 10.0)
    ax.set_xlabel("Operating Wavelength, $\\lambda$ (nm)")
    ax.set_ylabel("Attenuation Coefficient, $\\alpha(\\lambda)$ (dB/km)")
    ax.set_title("Silica Fiber Attenuation Spectrum and Physical Loss Mechanisms (Agrawal 5e, Sec. 2.5)")
    ax.grid(True, which="minor", linestyle=":", linewidth=0.45, alpha=0.45)
    ax.legend(loc="lower left", ncol=1, fontsize=8.2)

    out_path = OUT_DIR / "fig0_attenuation_spectrum.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=DPI, bbox_inches="tight", pad_inches=0.14)
    plt.close(fig)
    return out_path


# ==============================================================================
# FIGURE 1: Power-Level Diagram P(z) (Drops at Components + Jumps at Amplifiers)
# ==============================================================================
def make_fig1_power_level_diagram() -> Path:
    # Representative 240 km 1550 nm amplified link including connectors, splices,
    # a 1:4 optical splitter tap, and 2 in-line EDFAs so EVERY component type is
    # distinctly visible and clearly annotated.
    cfg = LinkConfig(
        wavelength_nm=1550.0,
        fiber_length_km=240.0,
        tx_power_dbm=2.0,
        rx_sensitivity_dbm=-28.0,
        system_margin_db=4.0,
        num_connectors=2,
        loss_per_connector_db=1.0,
        splice_mode="fixed",
        num_splices=3,
        loss_per_splice_db=0.4,
        splitter_mode="ratio",
        split_ratio=4,
        splitter_excess_loss_db=0.5,
        splitter_position_frac=0.80,   # z = 192 km
        num_amplifiers=2,
        amp_gain_db=20.0,
        amp_sat_enabled=True,
        amp_sat_out_dbm=17.0,
        fiber_params=copy.deepcopy(FIBER_PRESETS["smf28_conventional"]),
    )
    res = evaluate_link_budget(cfg)

    z_pts = [pt.distance_km for pt in res.power_profile]
    p_pts = [pt.power_dbm for pt in res.power_profile]

    fig, ax = plt.subplots(figsize=(9.6, 5.4))
    _style_axes(ax)

    # Shaded margin/failure zones
    y_min = min(min(p_pts) - 6.0, cfg.rx_sensitivity_dbm - 5.5)
    y_max = max(max(p_pts) + 9.5, cfg.tx_power_dbm + 10.0)
    ax.axhspan(y_min, cfg.rx_sensitivity_dbm, color="#FEE2E2", alpha=0.55, zorder=0)
    ax.axhspan(cfg.rx_sensitivity_dbm, res.design_threshold_dbm, color="#FEF3C7", alpha=0.50, zorder=0)

    # Reference threshold lines
    ax.axhline(
        cfg.rx_sensitivity_dbm,
        color=COLORS["fail"],
        linestyle="--",
        linewidth=1.5,
        label=f"Receiver Sensitivity ($\\bar{{P}}_{{\\mathrm{{rec}}}} = {cfg.rx_sensitivity_dbm:.1f}$ dBm)",
        zorder=2,
    )
    ax.axhline(
        res.design_threshold_dbm,
        color="#B45309",
        linestyle="-.",
        linewidth=1.4,
        label=f"Design Threshold ($\\bar{{P}}_{{\\mathrm{{rec}}}} + M_s = {res.design_threshold_dbm:.1f}$ dBm)",
        zorder=2,
    )

    # Main optical power trace P(z)
    ax.plot(
        z_pts,
        p_pts,
        color=COLORS["wl_1550"],
        linewidth=2.3,
        label=f"Optical Signal Power $P(z)$ at 1550 nm ($\\alpha_f = {res.attenuation.total_db_per_km:.3f}$ dB/km)",
        zorder=4,
    )

    # Highlight discrete component events along the trace
    amp_idx = 0
    splice_labeled = False
    for i, pt in enumerate(res.power_profile):
        if pt.event_type == "amplifier_out":
            amp_idx += 1
            p_in = res.power_profile[i - 1].power_dbm
            ax.plot([pt.distance_km, pt.distance_km], [p_in, pt.power_dbm],
                    color=COLORS["amp"], linewidth=2.8, zorder=5)
            ax.scatter([pt.distance_km], [pt.power_dbm], color=COLORS["amp"], s=52,
                       marker="^", edgecolor="#FFFFFF", linewidth=0.8, zorder=6)
            xy_text = (pt.distance_km + 18, pt.power_dbm + 4.8) if amp_idx == 1 else (pt.distance_km - 30, pt.power_dbm + 4.2)
            ax.annotate(
                f"EDFA #{amp_idx}\n+{pt.delta_db:.1f} dB\n({pt.distance_km:.0f} km)",
                xy=(pt.distance_km, pt.power_dbm),
                xytext=xy_text,
                ha="center",
                fontsize=8.3,
                color=COLORS["amp"],
                weight="bold",
                bbox=dict(boxstyle="round,pad=0.25", fc="#F0FDF4", ec=COLORS["amp"], lw=0.85),
                arrowprops=dict(arrowstyle="->", color=COLORS["amp"], lw=1.0),
                zorder=7,
            )
        elif pt.event_type == "splitter":
            p_in = res.power_profile[i - 1].power_dbm
            ax.plot([pt.distance_km, pt.distance_km], [p_in, pt.power_dbm],
                    color=COLORS["splitter"], linewidth=2.8, zorder=5)
            ax.scatter([pt.distance_km], [pt.power_dbm], color=COLORS["splitter"], s=52,
                       marker="v", edgecolor="#FFFFFF", linewidth=0.8, zorder=6)
            ax.annotate(
                f"1:4 Splitter\n{pt.delta_db:.2f} dB\n({pt.distance_km:.0f} km)",
                xy=(pt.distance_km, 0.5 * (p_in + pt.power_dbm)),
                xytext=(pt.distance_km + 30, pt.power_dbm + 9.2),
                ha="center",
                fontsize=8.3,
                color=COLORS["splitter"],
                weight="bold",
                bbox=dict(boxstyle="round,pad=0.25", fc="#F5F3FF", ec=COLORS["splitter"], lw=0.85),
                arrowprops=dict(arrowstyle="->", color=COLORS["splitter"], lw=1.0),
                zorder=7,
            )
        elif pt.event_type == "splice":
            ax.scatter([pt.distance_km], [pt.power_dbm], color=COLORS["splice"], s=34,
                       marker="o", edgecolor="#FFFFFF", linewidth=0.7, zorder=6)
            if not splice_labeled:
                splice_labeled = True
                ax.annotate(
                    f"Fusion Splices (×{cfg.num_splices})\n−{cfg.loss_per_splice_db:.1f} dB each",
                    xy=(pt.distance_km, pt.power_dbm),
                    xytext=(pt.distance_km - 19, pt.power_dbm - 7.8),
                    ha="center",
                    fontsize=8.2,
                    color="#B45309",
                    bbox=dict(boxstyle="round,pad=0.25", fc="#FFFBEB", ec=COLORS["splice"], lw=0.8),
                    arrowprops=dict(arrowstyle="->", color=COLORS["splice"], lw=0.95),
                    zorder=7,
                )

    # Annotate TX Launch / Connector and RX Received Power + Net Margin
    ax.scatter([0.0], [cfg.tx_power_dbm], color=COLORS["ink"], s=50, zorder=6)
    ax.annotate(
        f"TX Launch: {cfg.tx_power_dbm:+.1f} dBm\nTX Conn: −{cfg.loss_per_connector_db:.1f} dB",
        xy=(0.0, cfg.tx_power_dbm - cfg.loss_per_connector_db),
        xytext=(34.0, cfg.tx_power_dbm + 4.8),
        ha="center",
        fontsize=8.3,
        color=COLORS["ink"],
        bbox=dict(boxstyle="round,pad=0.28", fc="#FFFFFF", ec=COLORS["connector"], lw=0.85),
        arrowprops=dict(arrowstyle="->", color=COLORS["connector"], lw=1.0),
        zorder=7,
    )

    ax.scatter([cfg.fiber_length_km], [res.received_power_dbm], color=COLORS["pass"], s=65,
               edgecolor="#FFFFFF", linewidth=1.0, zorder=7)
    ax.annotate(
        f"RX Input: {res.received_power_dbm:+.2f} dBm\n"
        f"(RX Conn: −{cfg.loss_per_connector_db:.1f} dB)\n"
        f"Net Margin: +{res.net_margin_db:.2f} dB [{res.status_label}]",
        xy=(cfg.fiber_length_km, res.received_power_dbm),
        xytext=(cfg.fiber_length_km - 54, res.received_power_dbm - 2.4),
        ha="center",
        fontsize=8.3,
        color=COLORS["pass"],
        weight="bold",
        bbox=dict(boxstyle="round,pad=0.3", fc="#F0FDF4", ec=COLORS["pass"], lw=0.9),
        arrowprops=dict(arrowstyle="->", color=COLORS["pass"], lw=1.05),
        zorder=8,
    )

    ax.set_xlim(-6, cfg.fiber_length_km + 12)
    ax.set_ylim(y_min, y_max)
    ax.set_xlabel("Transmission Distance, $z$ (km)")
    ax.set_ylabel("Optical Signal Power, $P(z)$ (dBm)")
    ax.set_title("Optical Link Power-Level Diagram (240 km, 1550 nm SMF-28 with 2 In-Line EDFAs & 1:4 Splitter)")
    ax.legend(loc="lower left", fontsize=8.4)

    out_path = OUT_DIR / "fig1_power_level_diagram.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=DPI, bbox_inches="tight", pad_inches=0.14)
    plt.close(fig)
    return out_path


# ==============================================================================
# FIGURE 2: Loss Breakdown (Component Budget + Fiber Mechanism Share)
# ==============================================================================
def make_fig2_loss_breakdown() -> Path:
    # Left panel: FTTH GPON 1:32 access link (15 km, 1550 nm) — shows ALL passive
    # components (Splitter, Fiber, Connectors, Splices, System Margin, Net Margin)
    cfg_gpon = get_preset_config("ftth_gpon_1x32")
    res_gpon = evaluate_link_budget(cfg_gpon)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.8, 4.8), gridspec_kw={"width_ratios": [1.25, 1.0]})
    _style_axes(ax1)
    _style_axes(ax2)

    # --- Panel A: Itemized Budget Allocation (Horizontal Bar) ---
    categories = [
        "Optical Splitter (1:32)",
        "Fiber Attenuation (15 km)",
        "System Margin ($M_s$)",
        "Connectors (4 × 0.4 dB)",
        "Fusion Splices (4 × 0.1 dB)",
        "Excess Net Margin ($M_{\\mathrm{net}}$)",
    ]
    values = [
        res_gpon.splitter_loss_db,
        res_gpon.fiber_loss_db,
        res_gpon.system_margin_db,
        res_gpon.connector_loss_db,
        res_gpon.splice_loss_db,
        max(0.0, res_gpon.net_margin_db),
    ]
    total_budget = cfg_gpon.tx_power_dbm - cfg_gpon.rx_sensitivity_dbm  # 30.0 dB
    bar_colors = [
        COLORS["splitter"],
        COLORS["wl_1550"],
        COLORS["margin"],
        COLORS["connector"],
        COLORS["splice"],
        COLORS["pass"],
    ]

    y_pos = np.arange(len(categories))
    bars = ax1.barh(y_pos, values, height=0.60, color=bar_colors, edgecolor="#FFFFFF", linewidth=0.8, zorder=3)
    ax1.set_yticks(y_pos)
    ax1.set_yticklabels(categories, fontsize=9.2)
    ax1.invert_yaxis()
    ax1.set_xlim(0, max(values) * 1.36)
    ax1.set_xlabel("Power Budget Allocation (dB)")
    ax1.set_title(
        f"(a) FTTH GPON Link Loss Breakdown\n"
        f"(Total Budget = {total_budget:.1f} dB, $P_{{\\mathrm{{tx}}}} = +3$ dBm, $\\bar{{P}}_{{\\mathrm{{rec}}}} = -27$ dBm)",
        fontsize=10.5,
    )

    for bar, val in zip(bars, values):
        pct = 100.0 * val / total_budget
        ax1.text(
            val + 0.35,
            bar.get_y() + bar.get_height() / 2.0,
            f"{val:.2f} dB ({pct:.1f}%)",
            va="center",
            ha="left",
            fontsize=8.6,
            weight="bold",
            color=COLORS["ink"],
        )

    # --- Panel B: Fiber Attenuation Mechanism Share at 850, 1310, 1550 nm (100% Stacked Bar) ---
    # Include a moderate tight bend (R = 4.5 mm) or standard cable (R = 30 mm)?
    # Let's show standard SMF-28 at R = 4.2 mm? No, better: show standard SMF-28 (R = 30 mm)
    # plus a 4th bar "1550 nm (Tight Bend R=3.5 mm)" so bending loss contribution is clearly visible!
    fp_std = copy.deepcopy(FIBER_PRESETS["smf28_conventional"])
    fp_bend = copy.deepcopy(FIBER_PRESETS["smf28_conventional"])
    fp_bend.bend_radius_mm = 3.5

    cases = [
        ("850 nm\n(Standard)", compute_fiber_attenuation(850.0, fp_std)),
        ("1310 nm\n(Standard)", compute_fiber_attenuation(1310.0, fp_std)),
        ("1550 nm\n(Standard)", compute_fiber_attenuation(1550.0, fp_std)),
        ("1550 nm\n(R = 3.5 mm)", compute_fiber_attenuation(1550.0, fp_bend)),
    ]
    labels_b = [c[0] for c in cases]
    ray_pct = np.array([100.0 * c[1].rayleigh_db_per_km / c[1].total_db_per_km for c in cases])
    abs_pct = np.array([100.0 * c[1].total_absorption_db_per_km / c[1].total_db_per_km for c in cases])
    wg_pct = np.array([100.0 * c[1].waveguide_db_per_km / c[1].total_db_per_km for c in cases])
    bend_pct = np.array([100.0 * c[1].total_bending_db_per_km / c[1].total_db_per_km for c in cases])

    x_b = np.arange(len(cases))
    w_b = 0.56
    ax2.bar(x_b, ray_pct, w_b, label="Rayleigh Scattering", color=COLORS["rayleigh"], zorder=3)
    ax2.bar(x_b, abs_pct, w_b, bottom=ray_pct, label="Absorption (UV + IR + OH⁻)", color=COLORS["uv"], zorder=3)
    ax2.bar(x_b, wg_pct, w_b, bottom=ray_pct + abs_pct, label="Waveguide / Mie", color=COLORS["wg"], zorder=3)
    ax2.bar(x_b, bend_pct, w_b, bottom=ray_pct + abs_pct + wg_pct, label="Bending Loss", color=COLORS["bend"], zorder=3)

    # Annotate total dB/km above each bar
    for idx, (_, bd) in enumerate(cases):
        ax2.text(
            idx,
            102.5,
            f"{bd.total_db_per_km:.2f}\ndB/km",
            ha="center",
            va="bottom",
            fontsize=8.3,
            weight="bold",
            color=COLORS["ink"],
        )

    ax2.set_xticks(x_b)
    ax2.set_xticklabels(labels_b, fontsize=8.8)
    ax2.set_ylim(0, 118)
    ax2.set_ylabel("Contribution to Fiber Attenuation (%)")
    ax2.set_title("(b) Fiber Attenuation Mechanism Share\n(SMF-28 across Telecom Windows)", fontsize=10.5)
    ax2.legend(loc="lower center", bbox_to_anchor=(0.5, -0.32), ncol=2, fontsize=8.2)

    out_path = OUT_DIR / "fig2_loss_breakdown.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=DPI, bbox_inches="tight", pad_inches=0.14)
    plt.close(fig)
    return out_path


# ==============================================================================
# FIGURE 3: Net Link Margin vs. Fiber Length for Multiple Wavelengths
# ==============================================================================
def make_fig3_margin_vs_length() -> Path:
    cfg = LinkConfig(
        wavelength_nm=1550.0,
        fiber_length_km=50.0,
        tx_power_dbm=0.0,
        rx_sensitivity_dbm=-28.0,
        system_margin_db=4.0,
        num_connectors=2,
        loss_per_connector_db=0.5,
        splice_mode="fixed",
        num_splices=4,
        loss_per_splice_db=0.1,
        splitter_mode="ratio",
        split_ratio=1,
        num_amplifiers=0,
        fiber_params=copy.deepcopy(FIBER_PRESETS["smf28_conventional"]),
    )
    sweep = compute_margin_vs_length(
        cfg,
        wavelengths_nm=(850.0, 1310.0, 1550.0),
        max_length_km=130.0,
        num_points=261,
    )
    lengths = np.array(sweep["lengths_km"])

    fig, ax = plt.subplots(figsize=(9.2, 5.2))
    _style_axes(ax)

    # Pass / Fail background regions
    ax.axhspan(0, 28, color="#F0FDF4", alpha=0.55, zorder=0)
    ax.axhspan(-35, 0, color="#FEF2F2", alpha=0.55, zorder=0)
    ax.axhline(0.0, color=COLORS["fail"], linestyle="--", linewidth=1.6,
               label="Pass / Fail Threshold ($M_{\\mathrm{net}} = 0$ dB, $M_s = 4$ dB reserved)", zorder=3)

    wl_styles = {
        850.0: (COLORS["wl_850"], "-", (29.0, -7.0)),
        1310.0: (COLORS["wl_1310"], "-", (66.2, 16.5)),
        1550.0: (COLORS["wl_1550"], "-", (110.5, 13.5)),
    }

    for curve in sweep["curves"]:
        wl = curve["wavelength_nm"]
        alpha = curve["alpha_db_per_km"]
        l_max = curve["max_reach_km"]
        margins = np.array(curve["net_margin_db"])
        col, ls, text_xy = wl_styles[wl]

        ax.plot(
            lengths,
            margins,
            color=col,
            linestyle=ls,
            linewidth=2.3,
            label=f"{int(wl)} nm ($\\alpha_f = {alpha:.3f}$ dB/km, $L_{{\\max}} = {l_max:.1f}$ km)",
            zorder=4,
        )
        # Mark exact L_max crossing at M_net = 0
        ax.scatter([l_max], [0.0], s=60, color=col, edgecolor="#FFFFFF", linewidth=1.1, zorder=6)
        ax.vlines(l_max, -35, 0, color=col, linestyle=":", linewidth=1.0, alpha=0.7, zorder=2)
        ax.annotate(
            f"{int(wl)} nm\n$L_{{\\max}} = {l_max:.1f}$ km",
            xy=(l_max, 0.0),
            xytext=text_xy,
            ha="center",
            fontsize=8.5,
            color=col,
            weight="bold",
            bbox=dict(boxstyle="round,pad=0.28", fc="#FFFFFF", ec=col, lw=0.9),
            arrowprops=dict(arrowstyle="->", color=col, lw=1.0),
            zorder=7,
        )

    ax.text(127.5, 22.8, "PASS REGION ($M_{\\mathrm{net}} \\geq 0$ dB)", ha="right", va="top",
            fontsize=8.5, color=COLORS["pass"], weight="bold")
    ax.text(127.5, -27.8, "FAIL REGION ($M_{\\mathrm{net}} < 0$ dB)", ha="right", va="bottom",
            fontsize=8.5, color=COLORS["fail"], weight="bold")

    ax.set_xlim(0, 130)
    ax.set_ylim(-30, 26)
    ax.set_xlabel("Fiber Link Length, $L$ (km)")
    ax.set_ylabel("Net Link Margin, $M_{\\mathrm{net}}$ (dB)")
    ax.set_title(
        "Net Link Margin vs. Fiber Length Across Standard Optical Windows\n"
        "($P_{\\mathrm{tx}} = 0$ dBm, $\\bar{P}_{{\\mathrm{rec}}} = -28$ dBm, $M_s = 4$ dB, 2 Conn., 4 Splices, SMF-28)"
    )
    ax.legend(loc="lower left", fontsize=8.6)

    out_path = OUT_DIR / "fig3_margin_vs_length.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=DPI, bbox_inches="tight", pad_inches=0.14)
    plt.close(fig)
    return out_path


# ==============================================================================
# FIGURE 4: Agrawal 5e Table 5.1 Worked Example Validation
# ==============================================================================
def make_fig4_agrawal_validation() -> Path:
    lengths = np.linspace(0.0, 10.5, 211)

    cfg_laser = get_preset_config("agrawal_table5_1_laser")
    cfg_led = get_preset_config("agrawal_table5_1_led")
    cfg_apd = get_preset_config("agrawal_table5_1_led_apd")

    def sweep_rx(cfg: LinkConfig) -> np.ndarray:
        vals = []
        tmp = copy.deepcopy(cfg)
        for L in lengths:
            tmp.fiber_length_km = float(L)
            vals.append(evaluate_link_budget(tmp).received_power_dbm)
        return np.array(vals)

    p_laser = sweep_rx(cfg_laser)
    p_led = sweep_rx(cfg_led)
    # LED+APD has identical transmitted power & fiber loss as LED+PIN (only threshold shifts -7 dB)

    l_max_laser = solve_max_reach(cfg_laser).solved_max_reach_km or 0.0
    l_max_led = solve_max_reach(cfg_led).solved_max_reach_km or 0.0
    l_max_apd = solve_max_reach(cfg_apd).solved_max_reach_km or 0.0

    fig, ax = plt.subplots(figsize=(9.2, 5.2))
    _style_axes(ax)

    # Vertical 8-km system specification line
    ax.axvline(8.0, color=COLORS["ink"], linestyle="--", linewidth=1.4,
               label="Target Link Specification ($L = 8.0$ km)", zorder=2)

    # Thresholds (P_rec + M_s, where M_s = 6 dB)
    ax.axhline(-36.0, color=COLORS["wl_850"], linestyle="-.", linewidth=1.35,
               label="p-i-n Design Threshold ($\\bar{P}_{{\\mathrm{rec}}} + M_s = -42 + 6 = -36$ dBm)", zorder=2)
    ax.axhline(-43.0, color=COLORS["wl_1550"], linestyle=":", linewidth=1.55,
               label="APD Design Threshold ($\\bar{P}_{{\\mathrm{rec}}} + M_s = -49 + 6 = -43$ dBm)", zorder=2)

    # Power decay lines
    ax.plot(lengths, p_laser, color=COLORS["wl_1310"], linewidth=2.4,
            label="Laser Transmitter ($P_{\\mathrm{tr}} = 0$ dBm, 1 mW)", zorder=4)
    ax.plot(lengths, p_led, color=COLORS["wl_850"], linewidth=2.4,
            label="LED Transmitter ($P_{\\mathrm{tr}} = -13$ dBm, 50 $\\mu$W)", zorder=4)

    # Intersections matching Agrawal 5e Table 5.1 & Sec. 5.2.3
    pts = [
        (l_max_laser, -36.0, COLORS["wl_1310"], f"Laser + p-i-n\n$L_{{\\max}} = {l_max_laser:.2f}$ km\n(Table 5.1: 9.7 km)\nPASS @ 8 km", (9.2, -16.5)),
        (l_max_led, -36.0, COLORS["fail"], f"LED + p-i-n\n$L_{{\\max}} = {l_max_led:.2f}$ km\n(Table 5.1: 6.0 km)\nFAIL @ 8 km", (5.95, -52.5)),
        (l_max_apd, -43.0, COLORS["wl_1550"], f"LED + APD\n$L_{{\\max}} = {l_max_apd:.2f}$ km\n(Text p. 159: 8.0 km)\nPASS @ 8 km", (8.25, -57.0)),
    ]
    for lx, py_val, col, txt, txy in pts:
        ax.scatter([lx], [py_val], s=68, color=col, edgecolor="#FFFFFF", linewidth=1.1, zorder=6)
        ax.annotate(
            txt,
            xy=(lx, py_val),
            xytext=txy,
            ha="center",
            fontsize=8.2,
            color=col,
            weight="bold",
            bbox=dict(boxstyle="round,pad=0.28", fc="#FFFFFF", ec=col, lw=0.9),
            arrowprops=dict(arrowstyle="->", color=col, lw=1.0),
            zorder=7,
        )

    ax.set_xlim(0, 10.5)
    ax.set_ylim(-64, 3)
    ax.set_xlabel("Fiber Link Length, $L$ (km)")
    ax.set_ylabel("Received Optical Power, $P_{\\mathrm{rx}}(L)$ (dBm)")
    ax.set_title(
        "Textbook Benchmark Validation — Agrawal 5th Ed., Sec. 5.2.3, Table 5.1\n"
        "(0.85 $\\mu$m, 100 Mb/s, $\\alpha_f = 3.5$ dB/km, $\\alpha_{\\mathrm{con}} = 2$ dB, $M_s = 6$ dB)"
    )
    ax.legend(loc="lower left", fontsize=8.1)

    out_path = OUT_DIR / "fig4_agrawal_validation.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=DPI, bbox_inches="tight", pad_inches=0.14)
    plt.close(fig)
    return out_path


# ==============================================================================
# FIGURE M: Programmatic Methodology & System Architecture Block Diagram
# ==============================================================================
def make_fig_methodology_block_diagram() -> Path:
    """
    Generate a clean 300 DPI architectural block diagram illustrating the
    modular pipeline from user inputs and presets through the local HTTP API,
    core optical physics engine, and downstream validation / visualization outputs.
    """
    fig, ax = plt.subplots(figsize=(11.8, 5.4))
    ax.set_xlim(0, 114)
    ax.set_ylim(0, 54)
    ax.axis("off")

    def draw_box(x, y, w, h, title, body, fc, ec, title_color=None, lw=1.35, body_fs=7.6, title_fs=8.8):
        box = mpatches.FancyBboxPatch(
            (x, y), w, h,
            boxstyle="round,pad=0.25,rounding_size=1.0",
            facecolor=fc, edgecolor=ec, linewidth=lw, zorder=3,
        )
        ax.add_patch(box)
        tc = title_color if title_color else ec
        ax.text(
            x + w / 2.0, y + h - 1.6, title,
            ha="center", va="top", fontsize=title_fs, weight="bold", color=tc, zorder=4,
        )
        if body:
            ax.text(
                x + w / 2.0, y + (h - 3.6) / 2.0, body,
                ha="center", va="center", fontsize=body_fs, color=COLORS["ink"],
                linespacing=1.36, zorder=4,
            )

    def draw_arrow(x1, y1, x2, y2, color=COLORS["ink"], label=None, label_offset=(0, 1.5)):
        ax.annotate(
            "", xy=(x2, y2), xytext=(x1, y1),
            arrowprops=dict(arrowstyle="-|>,head_length=0.55,head_width=0.35", color=color, lw=1.4),
            zorder=5,
        )
        if label:
            ax.text(
                0.5 * (x1 + x2) + label_offset[0],
                0.5 * (y1 + y2) + label_offset[1],
                label, ha="center", va="center", fontsize=7.2, color=COLORS["muted"],
                style="italic", zorder=6,
            )

    # Title banner
    ax.text(
        57, 52.2,
        "Programmatic System Architecture — Option 2: Optical Attenuation & Link Power Budget Tool",
        ha="center", va="top", fontsize=11.8, weight="bold", color=COLORS["ink"],
    )

    # Stage 1: User Inputs & Presets (web/ GUI)
    draw_box(
        1.2, 9.5, 22.0, 35.5,
        "1. Web Workstation (web/)",
        "HTML5 / CSS / Offline SVG\n\n"
        "• Wavelength: 850, 1310, 1550 nm\n"
        "• Fiber Model & Direct α Override\n"
        "• TX Power, RX Sens., Margin M_s\n"
        "• Connectors, Splices & Splitter\n"
        "• In-Line EDFAs & P_sat Clamp\n"
        "• Analysis / Design Mode Toggle\n"
        "• Built-in Agrawal & Telecom Presets",
        fc="#F8FAFC", ec="#334155", title_color="#0F172A", lw=1.4, body_fs=7.5,
    )

    # Stage 2: Local HTTP JSON API (app.py)
    draw_box(
        28.6, 17.0, 15.8, 20.5,
        "2. Local API (app.py)",
        "Python stdlib\nThreadingHTTPServer\n\n"
        "GET  /api/presets\n"
        "POST /api/analyze\n"
        "POST /api/design\n"
        "GET  /api/validate",
        fc="#EFF6FF", ec=COLORS["wl_1310"], title_color=COLORS["wl_1310"], lw=1.4, body_fs=7.5,
    )

    # Stage 3: Physics Engine Container (physics_engine.py)
    outer = mpatches.FancyBboxPatch(
        (49.8, 7.2), 34.4, 40.5,
        boxstyle="round,pad=0.3,rounding_size=1.2",
        facecolor="#F0FDFA", edgecolor=COLORS["wl_1550"], linewidth=1.6, zorder=2,
    )
    ax.add_patch(outer)
    ax.text(
        49.8 + 34.4 / 2.0, 46.5,
        "3. Core Physics Engine (physics_engine.py)",
        ha="center", va="top", fontsize=9.1, weight="bold", color=COLORS["wl_1550"], zorder=4,
    )
    ax.text(
        49.8 + 34.4 / 2.0, 43.9,
        "Pure Python 3 + NumPy   |   Agrawal 5th Ed. Equations",
        ha="center", va="top", fontsize=7.4, color=COLORS["muted"], zorder=4,
    )

    # 4 sub-modules inside Physics Engine
    draw_box(
        51.6, 34.2, 30.8, 7.8,
        "Attenuation Model α(λ) [Ch. 2]",
        "Rayleigh (C_R/λ⁴) + UV/IR/OH⁻ Absorption\nWaveguide Floor + Macro/Microbending",
        fc="#FFFFFF", ec=COLORS["wl_1550"], title_color=COLORS["wl_1550"], lw=1.1, body_fs=7.3, title_fs=8.4,
    )
    draw_box(
        51.6, 25.4, 30.8, 7.8,
        "Component & Budget Solver [Ch. 5]",
        "C_L = α_f·L + α_con + α_splice + α_split\nP_rx, M_gross, M_net, PASS/FAIL & Overload",
        fc="#FFFFFF", ec=COLORS["wl_1550"], title_color=COLORS["wl_1550"], lw=1.1, body_fs=7.3, title_fs=8.4,
    )
    draw_box(
        51.6, 16.6, 30.8, 7.8,
        "Spatial Power Tracer P(z) [Ch. 7]",
        "Ordered drops (TX/RX conn, splices, splitter)\n& in-line EDFA jumps (+G_eff with P_sat)",
        fc="#FFFFFF", ec=COLORS["wl_1550"], title_color=COLORS["wl_1550"], lw=1.1, body_fs=7.3, title_fs=8.4,
    )
    draw_box(
        51.6, 8.4, 30.8, 7.2,
        "Design Mode Solvers",
        "Solve Max Reach (L_max, fixed/reel splices)\n& Minimum Uniform Amplifiers (N_amp)",
        fc="#FFFFFF", ec=COLORS["wl_1550"], title_color=COLORS["wl_1550"], lw=1.1, body_fs=7.3, title_fs=8.4,
    )

    # Stage 4: Outputs (3 stacked cards on right)
    draw_box(
        89.2, 35.4, 23.4, 12.2,
        "4a. Agrawal 5e Validator",
        "validate_agrawal.py\n27 automated benchmarks\nTable 5.1, Prob. 5.4, Eq. 2.5.4\n0.0000% error (< 0.1% tol.)",
        fc="#F0FDF4", ec=COLORS["pass"], title_color=COLORS["pass"], lw=1.35, body_fs=7.4, title_fs=8.6,
    )
    draw_box(
        89.2, 21.3, 23.4, 12.4,
        "4b. Live SVG & Exports",
        "Interactive P(z), Loss, Margin\n& Spectrum SVG plots\nCSV / JSON / SVG / HiDPI PNG\nFAIL Quick-Fix & Design Apply",
        fc="#FFF7ED", ec=COLORS["wl_850"], title_color=COLORS["wl_850"], lw=1.35, body_fs=7.4, title_fs=8.6,
    )
    draw_box(
        89.2, 7.2, 23.4, 12.2,
        "4c. Report Figures (300 DPI)",
        "generate_report_figures.py\nPublication Matplotlib PNGs\nSpectrum, P(z), Loss, Margin\n& Agrawal Validation Plots",
        fc="#F8FAFC", ec="#475569", title_color="#0F172A", lw=1.35, body_fs=7.4, title_fs=8.6,
    )

    # Flow Arrows with clean clearance
    draw_arrow(23.6, 29.6, 28.2, 29.6, COLORS["wl_1310"], "JSON req", (0, 1.7))
    draw_arrow(28.2, 24.8, 23.6, 24.8, COLORS["wl_850"], "JSON res", (0, -1.8))
    draw_arrow(44.8, 27.2, 49.4, 27.2, COLORS["wl_1550"], "Python\ncalls", (0, 2.3))

    draw_arrow(84.6, 41.4, 88.8, 41.4, COLORS["pass"])
    draw_arrow(84.6, 27.5, 88.8, 27.5, COLORS["wl_850"])
    draw_arrow(84.6, 13.3, 88.8, 13.3, "#475569")

    # Bottom footer caption
    ax.text(
        57, 2.6,
        "Zero commercial libraries  |  Pure Python 3.13 + NumPy physics kernel  |  100% offline local web interface",
        ha="center", va="center", fontsize=8.3, color=COLORS["muted"], style="italic",
    )

    out_path = OUT_DIR / "fig_methodology_block_diagram.png"
    fig.tight_layout(pad=0.2)
    fig.savefig(out_path, dpi=DPI, bbox_inches="tight", pad_inches=0.12)
    plt.close(fig)
    return out_path


def generate_all_figures() -> List[Path]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    _configure_matplotlib()
    paths = [
        make_fig0_attenuation_spectrum(),
        make_fig1_power_level_diagram(),
        make_fig2_loss_breakdown(),
        make_fig3_margin_vs_length(),
        make_fig4_agrawal_validation(),
        make_fig_methodology_block_diagram(),
    ]
    return paths


def main() -> None:
    paths = generate_all_figures()
    print(f"Generated {len(paths)} publication-grade figures at {DPI} DPI:")
    for p in paths:
        size_kb = p.stat().st_size / 1024.0
        print(f"  - {p.relative_to(Path(__file__).resolve().parent)} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
