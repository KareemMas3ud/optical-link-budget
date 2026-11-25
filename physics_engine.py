"""
================================================================================
physics_engine.py — Optical Fiber Attenuation & Link Power Budget Physics Engine
================================================================================
Course:        26ECE31H — Fiber Optic Communications (BUE)
Project:       Option 2 — Attenuation and Link Power Budget Tool (Group 9)
Primary Ref:   Govind P. Agrawal, "Fiber-Optic Communication Systems,"
               5th Edition, John Wiley & Sons (2021).

Dependencies:  Python 3 Standard Library + NumPy ONLY (zero GUI/web/commercial
               dependencies so this engine can be imported cleanly by CLI
               validators, Matplotlib figure generators, and the local web API).

Governing Physics Equations Implemented
---------------------------------------
1. Decibel & Absolute Power Conversions (Agrawal 5e, Appendix A, Eqs. A.1–A.3):
       R_dB   = 10 * log10(R)
       P_dBm  = 10 * log10(P_W / 1 mW) = 10 * log10(P_mW)
       P_mW   = 10^(P_dBm / 10)

2. Beer–Lambert Law & Attenuation Coefficient (Agrawal 5e, Sec. 2.5.1, Eqs. 2.5.1–2.5.3):
       dP/dz  = -alpha * P   =>   P_out = P_in * exp(-alpha * L)
       alpha_dB [dB/km] = -(10 / L) * log10(P_out / P_in) = (10 / ln 10) * alpha ≈ 4.34294 * alpha

3. Multi-Mechanism Silica Fiber Attenuation (Agrawal 5e, Sec. 2.5.2–2.5.4, Fig. 2.14–2.15):
       alpha_total(lam) = alpha_R(lam) + alpha_UV(lam) + alpha_IR(lam) + alpha_OH(lam)
                        + alpha_wg + alpha_macro(lam, R) + alpha_micro
   where (with wavelength lam in micrometers, lam_um = wavelength_nm / 1000):
     - Rayleigh Scattering (Eq. 2.5.4):
           alpha_R(lam) = C_R / lam^4       (C_R in 0.7–0.9 (dB/km)*um^4 for SMF)
     - Intrinsic UV Electronic Tail (Sec. 2.5.2, Fig. 2.14, Miya et al. [6]):
           alpha_UV(lam) = A_UV * exp(lam_UV / lam)
     - Intrinsic IR Vibrational Multiphoton Tail (Sec. 2.5.2, Fig. 2.14, Miya et al. [6]):
           alpha_IR(lam) = A_IR * exp(-lam_IR / lam)
     - Extrinsic OH- Water-Vapor Absorption Peaks (Sec. 2.5.2, Fig. 2.15):
           alpha_OH(lam) = C_OH * sum_k S_k * exp(-0.5 * ((lam - lam_k) / sigma_k)^2)
           with peaks near 1.385 um (50 dB/km per ppm = 0.050 dB/km per ppb),
           1.240 um, and 0.950 um.
     - Waveguide Imperfections / Mie Scattering (Sec. 2.5.4):
           alpha_wg <= 0.03 dB/km (core-cladding interface fluctuations)
     - Bending Loss (Sec. 2.5.4, Marcatili [43] & Marcuse [45]):
           alpha_macro(lam, R) = A_bend * exp(-R / R_c_eff(lam)),
           R_c_eff(lam) = R_c0 * (lam / 1.31)^3
           alpha_bend = alpha_macro + alpha_micro

4. Discrete Link Components & Lumped Amplification:
     - Connectors (Sec. 2.7.3 & 5.2.3):  alpha_con    = N_con * L_con
     - Splices    (Sec. 2.7.3 & 5.2.3):  alpha_splice = N_splice * L_splice
       (supports both fixed splice count and cable-reel spacing every L_reel km)
     - Passive Optical Splitter (Sec. 5.1.3 Eq. 5.1.2 & Sec. 6.2.4):
           alpha_split = 0 if N_split <= 1 else 10 * log10(N_split) + L_excess
     - Lumped Optical Amplifiers (Sec. 7.1.1–7.1.2):
           G_total = sum_{k=1}^{N_amp} G_eff,k
           where G_eff,k = min(G_amp, max(0, P_sat_out - P_in,k)) when saturation
           clamping is enabled, or G_eff,k = G_amp in the linear regime.

5. Generalized Link Power Budget (Agrawal 5e, Sec. 5.2.3, Eqs. 5.2.2–5.2.3):
       C_L       = alpha_f(lam) * L + alpha_con + alpha_splice + alpha_split
       P_rx      = P_tx - C_L + G_total
       M_gross   = P_rx - P_rec
       M_net     = P_rx - P_rec - M_s = (P_tx + G_total - P_rec - M_s) - C_L
       PASS  <=>  M_net >= 0 dB  (and P_rx <= P_overload if overload check enabled,
                  and all amplifier inputs >= P_amp_min if min-input check enabled)

6. Design Mode Solvers:
     - Maximum Reach L_max (fixed splices):
           L_max = max(0, (P_tx + G_total - P_rec - M_s - alpha_con - alpha_splice - alpha_split) / alpha_f)
       plus exact discrete-reel and distributed-reel solvers when splice_mode == "reel".
     - Required Amplifiers N_amp for target reach L_target:
           N_amp = max(0, ceil((C_L(L_target) + M_s - (P_tx - P_rec)) / G_amp))
       verified along the full spatial power profile P(z) with uniform span spacing
       L_span = L_target / (N_amp + 1) (Agrawal 5e, Sec. 7.1.2).
================================================================================
"""

from __future__ import annotations

import copy
import math
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

# ------------------------------------------------------------------------------
# Physical Constants (SI)
# ------------------------------------------------------------------------------
PLANCK_H: float = 6.62607015e-34        # Planck's constant [J*s]
SPEED_OF_LIGHT: float = 2.99792458e8    # Vacuum speed of light [m/s]
DB_PER_NEPER: float = 10.0 / math.log(10.0)  # ≈ 4.342944819032518 [dB/Np]
NEPER_PER_DB: float = math.log(10.0) / 10.0  # ≈ 0.2302585092994046 [Np/dB]

# OH- vibrational overtone/combination absorption peaks in fused silica
# (Agrawal 5e, Sec. 2.5.2, p. 47: 1 ppm => ~50 dB/km at 1.39 um -> 0.050 dB/km per ppb)
# Tuple format: (center_wavelength_um, strength_db_per_km_per_ppb, sigma_um)
OH_ABSORPTION_PEAKS: Tuple[Tuple[float, float, float], ...] = (
    (1.385, 0.0500, 0.016),  # Primary 1st overtone of 2.73 um OH- stretch (1383–1390 nm)
    (1.240, 0.0030, 0.015),  # Combination band with SiO2 tetrahedron vibration
    (0.950, 0.0015, 0.015),  # 2nd overtone of 2.73 um OH- stretch
)


# ==============================================================================
# 1. UNIT CONVERSION UTILITIES (Agrawal 5e, Appendix A, Eqs. A.1–A.3)
# ==============================================================================

def dbm_to_mw(power_dbm: float) -> float:
    """
    Convert optical power from dBm to milliwatts (mW).

    Equation (Agrawal 5e, Appendix A, Eq. A.3 inverted):
        P_mW = 10^(P_dBm / 10)
    """
    return float(10.0 ** (power_dbm / 10.0))


def mw_to_dbm(power_mw: float) -> float:
    """
    Convert optical power from milliwatts (mW) to dBm.

    Equation (Agrawal 5e, Appendix A, Eq. A.3):
        P_dBm = 10 * log10(P_mW / 1 mW)
    """
    if power_mw <= 0.0:
        raise ValueError(f"Optical power in mW must be strictly positive; got {power_mw}.")
    return float(10.0 * math.log10(power_mw))


def linear_to_db(ratio: float) -> float:
    """
    Convert a dimensionless positive power ratio R to decibels (dB).

    Equation (Agrawal 5e, Appendix A, Eq. A.1):
        R_dB = 10 * log10(R)
    """
    if ratio <= 0.0:
        raise ValueError(f"Linear ratio must be strictly positive; got {ratio}.")
    return float(10.0 * math.log10(ratio))


def db_to_linear(value_db: float) -> float:
    """
    Convert a decibel (dB) gain or attenuation factor to a dimensionless linear ratio.

    Equation (Agrawal 5e, Appendix A, Eq. A.1 inverted):
        R = 10^(R_dB / 10)
    """
    return float(10.0 ** (value_db / 10.0))


def alpha_db_to_linear(alpha_db_per_km: float) -> float:
    """
    Convert fiber-loss parameter alpha_dB [dB/km] to Beer–Lambert linear
    attenuation coefficient alpha [km^-1].

    Equation (Agrawal 5e, Sec. 2.5.1, Eq. 2.5.3):
        alpha [km^-1] = (ln(10) / 10) * alpha_dB ≈ alpha_dB / 4.34294
    """
    return float(alpha_db_per_km * NEPER_PER_DB)


def alpha_linear_to_db(alpha_per_km: float) -> float:
    """
    Convert Beer–Lambert linear attenuation coefficient alpha [km^-1] to
    fiber-loss parameter alpha_dB [dB/km].

    Equation (Agrawal 5e, Sec. 2.5.1, Eq. 2.5.3):
        alpha_dB [dB/km] = (10 / ln(10)) * alpha ≈ 4.34294 * alpha
    """
    return float(alpha_per_km * DB_PER_NEPER)


def receiver_sensitivity_from_photons(
    photons_per_bit: float,
    bit_rate_bps: float,
    wavelength_nm: float,
) -> float:
    """
    Compute average receiver sensitivity P_rec [dBm] from required average
    photons per bit N_p, bit rate B [bit/s], and operating wavelength [nm].

    Equation (Agrawal 5e, Sec. 5.2.1 & Sec. 5.2.3, pp. 155 & 158):
        P_rec [W]   = N_p * (h * c / lambda) * B
        P_rec [dBm] = 10 * log10(P_rec [W] / 1e-3)
    """
    if photons_per_bit <= 0 or bit_rate_bps <= 0 or wavelength_nm <= 0:
        raise ValueError("photons_per_bit, bit_rate_bps, and wavelength_nm must be positive.")
    lam_m = wavelength_nm * 1e-9
    p_watts = photons_per_bit * (PLANCK_H * SPEED_OF_LIGHT / lam_m) * bit_rate_bps
    return mw_to_dbm(p_watts * 1e3)


# ==============================================================================
# 2. TYPED DATACLASSES (JSON-Serializable for Phase 3 Local Web API)
# ==============================================================================

@dataclass
class FiberParams:
    """
    Physical parameters governing silica fiber attenuation mechanisms across
    wavelength (Agrawal 5e, Chapter 2, Section 2.5, pp. 45–48).

    If `alpha_override_db_per_km` is set to a non-None float, `compute_fiber_attenuation`
    uses that exact value as the total cable attenuation coefficient (essential for
    reproducing textbook examples such as Agrawal Table 5.1 where alpha_f = 3.5 dB/km
    is specified directly as a combined cable loss).
    """
    name: str = "Standard SMF-28 (ITU-T G.652.B)"
    rayleigh_coeff_cr: float = 0.85          # C_R [(dB/km)*um^4]; Agrawal Eq. (2.5.4): 0.7–0.9
    uv_a: float = 1.10e-3                    # A_UV [dB/km]; GeO2-doped silica Urbach tail
    uv_lambda_um: float = 4.63               # lambda_UV [um]
    ir_a: float = 7.81e11                    # A_IR [dB/km]; Miya et al. (1979) multiphoton tail
    ir_lambda_um: float = 48.48              # lambda_IR [um]
    oh_concentration_ppb: float = 15.0       # Residual OH- [ppb]; ~15 ppb conv., ~0.5 ppb dry
    waveguide_loss_db_per_km: float = 0.015  # alpha_wg [dB/km]; Agrawal Sec. 2.5.4 <= 0.03
    bend_radius_mm: float = 30.0             # Macrobend radius R [mm]; negligible for R > 5 mm
    bend_rc0_mm: float = 0.35                # Effective critical bend radius at 1.31 um [mm]
    bend_prefactor_db_per_km: float = 100.0  # Macrobending prefactor A_bend [dB/km]
    microbending_db_per_km: float = 0.0      # Cabling microbending loss [dB/km]
    alpha_override_db_per_km: Optional[float] = None  # Direct alpha_f override [dB/km]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FiberParams":
        valid = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in valid}
        return cls(**filtered)


@dataclass
class LinkConfig:
    """
    Complete end-to-end optical fiber link specification for power-budget
    analysis and Design Mode optimization.
    """
    wavelength_nm: float = 1550.0             # Operating wavelength [nm] (e.g., 850, 1310, 1550)
    fiber_length_km: float = 40.0             # Total fiber span length L [km]
    tx_power_dbm: float = 0.0                 # Average transmitter launch power P_tx [dBm]
    rx_sensitivity_dbm: float = -28.0         # Receiver sensitivity P_rec [dBm]
    rx_overload_enabled: bool = False         # Enable receiver saturation / overload check
    rx_overload_dbm: float = -3.0             # Maximum tolerable receiver input power [dBm]
    system_margin_db: float = 4.0             # Required aging/penalty system margin M_s [dB]

    # Connectors (Agrawal Sec. 2.7.3 & 5.2.3)
    num_connectors: int = 2                   # Total connectors (typically >= 2: TX + RX ends)
    loss_per_connector_db: float = 0.5        # Insertion loss per connector [dB]

    # Splices (fixed count OR periodic cable-reel spacing)
    splice_mode: str = "fixed"                # "fixed" or "reel"
    num_splices: int = 4                      # Number of splices (when splice_mode == "fixed")
    reel_length_km: float = 2.0               # Cable reel length L_reel [km] (when "reel")
    loss_per_splice_db: float = 0.1           # Insertion loss per fusion splice [dB]

    # Passive Optical Splitter (Agrawal Sec. 5.1.3 Eq. 5.1.2 & Sec. 6.2.4)
    splitter_mode: str = "ratio"              # "ratio" (1:N + excess) or "manual" (direct dB)
    split_ratio: int = 1                      # 1 = no splitter; 2, 4, 8, 16, 32, 64 for 1:N PON
    splitter_excess_loss_db: float = 0.5      # Excess loss above ideal 10*log10(N) [dB]
    manual_splitter_loss_db: float = 0.0      # Direct splitter loss [dB] (when "manual")
    splitter_position_frac: float = 0.80      # Fractional location z_split / L in (0, 1)

    # Lumped Optical Amplifiers — EDFA / In-line (Agrawal Sec. 7.1.1–7.1.2)
    num_amplifiers: int = 0                   # Number of lumped in-line amplifiers N_amp
    amp_gain_db: float = 20.0                 # Nominal small-signal gain per amplifier [dB]
    amp_sat_enabled: bool = False             # Enable physical output power saturation clamp
    amp_sat_out_dbm: float = 17.0             # Maximum amplifier output power P_sat,out [dBm]
    amp_min_in_enabled: bool = False          # Enforce minimum input power before each amp
    amp_min_in_dbm: float = -35.0             # Minimum amplifier input power threshold [dBm]

    # Fiber physical attenuation parameters
    fiber_params: FiberParams = field(default_factory=FiberParams)

    def validate(self) -> None:
        """Validate physical domain bounds on all link parameters."""
        if self.wavelength_nm <= 0:
            raise ValueError("wavelength_nm must be strictly positive.")
        if self.fiber_length_km < 0:
            raise ValueError("fiber_length_km cannot be negative.")
        if self.system_margin_db < 0:
            raise ValueError("system_margin_db cannot be negative.")
        if self.num_connectors < 0 or self.loss_per_connector_db < 0:
            raise ValueError("Connector count and per-connector loss must be non-negative.")
        if self.splice_mode not in ("fixed", "reel"):
            raise ValueError("splice_mode must be 'fixed' or 'reel'.")
        if self.num_splices < 0 or self.loss_per_splice_db < 0:
            raise ValueError("Splice count and per-splice loss must be non-negative.")
        if self.splice_mode == "reel" and self.reel_length_km <= 0:
            raise ValueError("reel_length_km must be strictly positive in 'reel' splice mode.")
        if self.splitter_mode not in ("ratio", "manual"):
            raise ValueError("splitter_mode must be 'ratio' or 'manual'.")
        if self.split_ratio < 1:
            raise ValueError("split_ratio must be >= 1.")
        if self.splitter_excess_loss_db < 0 or self.manual_splitter_loss_db < 0:
            raise ValueError("Splitter loss values must be non-negative.")
        if not (0.0 < self.splitter_position_frac < 1.0):
            raise ValueError("splitter_position_frac must lie strictly between 0 and 1.")
        if self.num_amplifiers < 0 or self.amp_gain_db < 0:
            raise ValueError("num_amplifiers and amp_gain_db must be non-negative.")
        if (
            self.fiber_params.alpha_override_db_per_km is not None
            and self.fiber_params.alpha_override_db_per_km <= 0
        ):
            raise ValueError("alpha_override_db_per_km must be strictly positive when set.")

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LinkConfig":
        payload = copy.deepcopy(data)
        fp_data = payload.pop("fiber_params", None)
        valid = {f.name for f in cls.__dataclass_fields__.values() if f.name != "fiber_params"}
        filtered = {k: v for k, v in payload.items() if k in valid}
        if isinstance(fp_data, FiberParams):
            filtered["fiber_params"] = fp_data
        elif isinstance(fp_data, dict):
            filtered["fiber_params"] = FiberParams.from_dict(fp_data)
        return cls(**filtered)


@dataclass
class AttenuationBreakdown:
    """Decomposed fiber attenuation coefficient alpha(lambda) in dB/km."""
    wavelength_nm: float
    wavelength_um: float
    rayleigh_db_per_km: float
    uv_absorption_db_per_km: float
    ir_absorption_db_per_km: float
    oh_absorption_db_per_km: float
    total_absorption_db_per_km: float
    waveguide_db_per_km: float
    macrobending_db_per_km: float
    microbending_db_per_km: float
    total_bending_db_per_km: float
    total_db_per_km: float
    linear_alpha_per_km: float
    is_override: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PowerProfilePoint:
    """Single spatial vertex along the optical Power-Level Diagram P(z)."""
    distance_km: float
    power_dbm: float
    event: str
    event_type: str
    delta_db: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PowerBudgetResult:
    """Complete output of an end-to-end link power budget evaluation."""
    wavelength_nm: float
    fiber_length_km: float
    tx_power_dbm: float
    tx_power_mw: float
    rx_sensitivity_dbm: float
    rx_sensitivity_mw: float
    attenuation: AttenuationBreakdown
    effective_num_splices: int
    fiber_loss_db: float
    fiber_loss_subcomponents_db: Dict[str, float]
    connector_loss_db: float
    splice_loss_db: float
    splitter_loss_db: float
    total_passive_loss_db: float
    nominal_amp_gain_db: float
    effective_amp_gain_db: float
    net_loss_db: float
    available_channel_loss_db: float
    received_power_dbm: float
    received_power_mw: float
    system_margin_db: float
    gross_margin_db: float
    net_margin_db: float
    design_threshold_dbm: float
    max_reach_km: float
    max_reach_distributed_km: Optional[float]
    passed: bool
    status_label: str
    diagnostic_message: str
    warnings: List[str]
    loss_breakdown_db: Dict[str, float]
    power_profile: List[PowerProfilePoint]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class DesignSolution:
    """Result returned by Design Mode solvers (Max Reach or Required Amplifiers)."""
    mode: str
    target_length_km: Optional[float]
    solved_max_reach_km: Optional[float]
    solved_max_reach_distributed_km: Optional[float]
    solved_num_amplifiers: Optional[int]
    span_length_km: Optional[float]
    span_loss_db: Optional[float]
    amplifier_positions_km: List[float]
    feasible: bool
    summary: str
    verified_result: PowerBudgetResult

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ==============================================================================
# 3. FIBER ATTENUATION PHYSICS MODEL (Agrawal 5e, Chapter 2, Sec. 2.5)
# ==============================================================================

def compute_fiber_attenuation(
    wavelength_nm: float,
    fiber_params: Optional[FiberParams] = None,
) -> AttenuationBreakdown:
    """
    Compute the fiber attenuation coefficient alpha(lambda) [dB/km] and its
    physical mechanism decomposition at wavelength_nm [nm].

    Equations (Agrawal 5e, Chapter 2, Sec. 2.5.1–2.5.4, pp. 46–48):
        alpha_R(lam)     = C_R / lam^4                                  [Eq. 2.5.4]
        alpha_UV(lam)    = A_UV * exp(lam_UV / lam)                     [Fig. 2.14]
        alpha_IR(lam)    = A_IR * exp(-lam_IR / lam)                    [Fig. 2.14]
        alpha_OH(lam)    = C_OH * sum_k S_k * exp(-0.5*((lam-lam_k)/sig_k)^2)
        alpha_macro(lam) = A_bend * exp(-R / (R_c0 * (lam / 1.31)^3))   [Sec. 2.5.4]
        alpha_total(lam) = alpha_R + alpha_UV + alpha_IR + alpha_OH
                         + alpha_wg + alpha_macro + alpha_micro
    """
    if wavelength_nm <= 0.0:
        raise ValueError(f"wavelength_nm must be strictly positive; got {wavelength_nm}.")
    fp = fiber_params if fiber_params is not None else FiberParams()
    lam_um = wavelength_nm / 1000.0

    # 1. Rayleigh scattering: Eq. (2.5.4)
    a_rayleigh = fp.rayleigh_coeff_cr / (lam_um ** 4)

    # 2. Intrinsic material absorption: UV electronic & IR vibrational tails
    a_uv = fp.uv_a * math.exp(fp.uv_lambda_um / lam_um)
    a_ir = fp.ir_a * math.exp(-fp.ir_lambda_um / lam_um)

    # 3. Extrinsic OH- water-vapor overtone/combination absorption peaks
    a_oh = 0.0
    if fp.oh_concentration_ppb > 0.0:
        for center_um, strength_per_ppb, sigma_um in OH_ABSORPTION_PEAKS:
            a_oh += fp.oh_concentration_ppb * strength_per_ppb * math.exp(
                -0.5 * ((lam_um - center_um) / sigma_um) ** 2
            )
    a_abs_total = a_uv + a_ir + a_oh

    # 4. Waveguide imperfections / Mie scattering floor (Sec. 2.5.4)
    a_wg = max(0.0, fp.waveguide_loss_db_per_km)

    # 5. Macrobending & microbending losses (Sec. 2.5.4)
    rc_eff_mm = fp.bend_rc0_mm * ((lam_um / 1.31) ** 3)
    if fp.bend_radius_mm <= 0.0:
        a_macro = fp.bend_prefactor_db_per_km
    else:
        exponent = -fp.bend_radius_mm / max(rc_eff_mm, 1e-12)
        a_macro = fp.bend_prefactor_db_per_km * math.exp(max(exponent, -700.0))
    a_micro = max(0.0, fp.microbending_db_per_km)
    a_bend_total = a_macro + a_micro

    modeled_total = a_rayleigh + a_abs_total + a_wg + a_bend_total

    # Direct cable-loss override (used for exact textbook benchmarks like Agrawal Table 5.1)
    if fp.alpha_override_db_per_km is not None:
        total_db_km = float(fp.alpha_override_db_per_km)
        is_override = True
    else:
        total_db_km = float(modeled_total)
        is_override = False

    return AttenuationBreakdown(
        wavelength_nm=float(wavelength_nm),
        wavelength_um=float(lam_um),
        rayleigh_db_per_km=float(a_rayleigh),
        uv_absorption_db_per_km=float(a_uv),
        ir_absorption_db_per_km=float(a_ir),
        oh_absorption_db_per_km=float(a_oh),
        total_absorption_db_per_km=float(a_abs_total),
        waveguide_db_per_km=float(a_wg),
        macrobending_db_per_km=float(a_macro),
        microbending_db_per_km=float(a_micro),
        total_bending_db_per_km=float(a_bend_total),
        total_db_per_km=float(total_db_km),
        linear_alpha_per_km=alpha_db_to_linear(total_db_km),
        is_override=is_override,
    )


def compute_attenuation_spectrum(
    wavelengths_nm: Optional[Sequence[float]] = None,
    fiber_params: Optional[FiberParams] = None,
) -> Dict[str, Any]:
    """
    Evaluate the decomposed fiber attenuation spectrum alpha(lambda) over an
    array of wavelengths (default: 800–1700 nm, 361 points at 2.5 nm steps)
    using vectorized NumPy operations.

    Always evaluates the physical silica mechanism curves (even if an override
    is active on `fiber_params`) and additionally includes `override_db_per_km`
    when an override is set.
    """
    fp = fiber_params if fiber_params is not None else FiberParams()
    if wavelengths_nm is None:
        lam_nm = np.linspace(800.0, 1700.0, 361)
    else:
        lam_nm = np.asarray(wavelengths_nm, dtype=float)
    lam_um = lam_nm / 1000.0

    a_rayleigh = fp.rayleigh_coeff_cr / np.power(lam_um, 4)
    a_uv = fp.uv_a * np.exp(fp.uv_lambda_um / lam_um)
    a_ir = fp.ir_a * np.exp(-fp.ir_lambda_um / lam_um)

    a_oh = np.zeros_like(lam_um)
    if fp.oh_concentration_ppb > 0.0:
        for center_um, strength_per_ppb, sigma_um in OH_ABSORPTION_PEAKS:
            a_oh += fp.oh_concentration_ppb * strength_per_ppb * np.exp(
                -0.5 * ((lam_um - center_um) / sigma_um) ** 2
            )
    a_abs = a_uv + a_ir + a_oh
    a_wg = np.full_like(lam_um, max(0.0, fp.waveguide_loss_db_per_km))

    rc_eff_mm = fp.bend_rc0_mm * np.power(lam_um / 1.31, 3)
    if fp.bend_radius_mm <= 0.0:
        a_macro = np.full_like(lam_um, fp.bend_prefactor_db_per_km)
    else:
        exponent = np.maximum(-fp.bend_radius_mm / np.maximum(rc_eff_mm, 1e-12), -700.0)
        a_macro = fp.bend_prefactor_db_per_km * np.exp(exponent)
    a_micro = np.full_like(lam_um, max(0.0, fp.microbending_db_per_km))
    a_bend = a_macro + a_micro

    a_total = a_rayleigh + a_abs + a_wg + a_bend

    # Standard telecom reference window callouts (850, 1310, 1550 nm)
    windows = {
        str(int(w)): compute_fiber_attenuation(w, fp).to_dict()
        for w in (850.0, 1310.0, 1550.0)
    }

    return {
        "wavelengths_nm": lam_nm.tolist(),
        "wavelengths_um": lam_um.tolist(),
        "rayleigh": a_rayleigh.tolist(),
        "uv_absorption": a_uv.tolist(),
        "ir_absorption": a_ir.tolist(),
        "oh_absorption": a_oh.tolist(),
        "total_absorption": a_abs.tolist(),
        "waveguide": a_wg.tolist(),
        "macrobending": a_macro.tolist(),
        "microbending": a_micro.tolist(),
        "total_bending": a_bend.tolist(),
        "total": a_total.tolist(),
        "override_db_per_km": fp.alpha_override_db_per_km,
        "windows": windows,
    }


# ==============================================================================
# 4. DISCRETE COMPONENT LOSSES & SPATIAL POWER-LEVEL PROFILE TRACER
# ==============================================================================

def compute_splitter_loss(config: LinkConfig) -> float:
    """
    Compute passive optical splitter insertion loss alpha_split [dB].

    Equations (Agrawal 5e, Sec. 5.1.3 Eq. 5.1.2 & Sec. 6.2.4, pp. 155 & 202):
        - Ratio mode ('ratio'):
              alpha_split = 0                                   if N_split == 1
              alpha_split = 10 * log10(N_split) + L_excess      if N_split > 1
        - Manual mode ('manual'):
              alpha_split = manual_splitter_loss_db
    """
    if config.splitter_mode == "manual":
        return float(max(0.0, config.manual_splitter_loss_db))
    if config.split_ratio <= 1:
        return 0.0
    return float(10.0 * math.log10(config.split_ratio) + config.splitter_excess_loss_db)


def compute_splice_positions(config: LinkConfig, length_km: Optional[float] = None) -> List[float]:
    """
    Compute the ordered physical locations z [km] of all discrete fiber splices
    along a link of length L [km].

    - 'fixed' mode: `num_splices` evenly spaced interior locations at
          z_m = m * L / (N_splice + 1),  m = 1 .. N_splice
    - 'reel' mode: interior cable-reel joints every `reel_length_km`, i.e.,
          z_m = m * L_reel  for m = 1 .. max(0, ceil(L / L_reel) - 1)
      (Agrawal 5e, Problems 2.16 & 5.4).
    """
    L = config.fiber_length_km if length_km is None else float(length_km)
    if L <= 0.0:
        if config.splice_mode == "fixed" and config.num_splices > 0:
            return [0.0] * config.num_splices
        return []

    if config.splice_mode == "fixed":
        n = int(config.num_splices)
        if n <= 0:
            return []
        return [L * (m / (n + 1)) for m in range(1, n + 1)]

    # Reel-spacing mode: interior joints at multiples of L_reel strictly less than L
    reel = float(config.reel_length_km)
    n_interior = max(0, int(math.ceil((L - 1e-12) / reel)) - 1)
    return [reel * m for m in range(1, n_interior + 1)]


def _trace_spatial_power_profile(
    config: LinkConfig,
    alpha_db_per_km: float,
    splitter_loss_db: float,
    splice_positions_km: List[float],
) -> Tuple[List[PowerProfilePoint], float, List[str], bool]:
    """
    Trace the optical signal power P(z) [dBm] sequentially from z = 0 (TX) to
    z = L (RX), applying continuous fiber attenuation slopes (-alpha_f dB/km)
    and discrete vertical drops/jumps at every physical element.

    Returns
    -------
    profile : List[PowerProfilePoint]
        Ordered spatial vertices for plotting the Power-Level Diagram.
    effective_amp_gain_db : float
        Actual cumulative gain delivered by all in-line amplifiers [dB],
        incorporating optional output saturation clamping P_sat,out.
    warnings : List[str]
        Engineering warnings (e.g., EDFA saturation clamping, low amplifier input).
    amp_floor_violated : bool
        True if `amp_min_in_enabled` is True and any amplifier input dropped
        below `amp_min_in_dbm`.
    """
    L = float(config.fiber_length_km)
    warnings: List[str] = []
    amp_floor_violated = False
    effective_amp_gain_db = 0.0

    # Assemble discrete interior events: (z_km, priority, event_type, label, magnitude_db)
    # Priority ordering at identical z ensures passive losses occur before amplification.
    interior_events: List[Tuple[float, int, str, str, float]] = []

    # Connectors: reserve 1 at TX (z=0) if N_con >= 1, 1 at RX (z=L) if N_con >= 2;
    # place any extra connectors (N_con - 2) evenly across the interior.
    has_tx_conn = config.num_connectors >= 1
    has_rx_conn = config.num_connectors >= 2
    n_mid_conns = max(0, config.num_connectors - 2)
    for j in range(1, n_mid_conns + 1):
        z_conn = L * (j / (n_mid_conns + 1)) if L > 0 else 0.0
        interior_events.append(
            (z_conn, 1, "connector", f"Patch Connector #{j + 1}", config.loss_per_connector_db)
        )

    # Splices
    for idx, z_sp in enumerate(splice_positions_km, start=1):
        interior_events.append(
            (z_sp, 2, "splice", f"Splice #{idx}", config.loss_per_splice_db)
        )

    # Optical Splitter
    if splitter_loss_db > 0.0:
        z_split = L * config.splitter_position_frac if L > 0 else 0.0
        split_tag = (
            f"Splitter (1:{config.split_ratio})"
            if config.splitter_mode == "ratio" and config.split_ratio > 1
            else "Optical Splitter"
        )
        interior_events.append((z_split, 3, "splitter", split_tag, splitter_loss_db))

    # Lumped In-Line Optical Amplifiers — uniformly spaced across N_amp + 1 spans
    # (Agrawal 5e, Sec. 7.1.2, p. 237: periodic spacing L_A = L / (N_amp + 1))
    n_amp = int(config.num_amplifiers)
    for k in range(1, n_amp + 1):
        z_amp = L * (k / (n_amp + 1)) if L > 0 else 0.0
        interior_events.append((z_amp, 4, "amplifier", f"In-Line Amp #{k}", config.amp_gain_db))

    interior_events.sort(key=lambda item: (item[0], item[1]))

    profile: List[PowerProfilePoint] = []
    z_curr = 0.0
    p_curr = float(config.tx_power_dbm)

    # 1. TX Launch
    profile.append(PowerProfilePoint(0.0, p_curr, "TX Launch", "tx", 0.0))

    # 2. TX Connector at z = 0
    if has_tx_conn and config.loss_per_connector_db > 0.0:
        p_curr -= config.loss_per_connector_db
        profile.append(
            PowerProfilePoint(
                0.0, p_curr, "TX Connector", "connector", -float(config.loss_per_connector_db)
            )
        )

    # 3. Propagate through each interior fiber segment and discrete event
    for z_ev, _prio, ev_type, label, mag_db in interior_events:
        dz = max(0.0, z_ev - z_curr)
        if dz > 0.0:
            p_curr -= alpha_db_per_km * dz
            z_curr = z_ev

        if ev_type == "amplifier":
            # Record input power immediately before amplifier jump
            profile.append(PowerProfilePoint(z_curr, p_curr, f"{label} (In)", "amplifier_in", 0.0))

            if config.amp_min_in_enabled and p_curr < config.amp_min_in_dbm - 1e-9:
                amp_floor_violated = True
                warnings.append(
                    f"{label} input ({p_curr:.2f} dBm) is below minimum amplifier "
                    f"input floor ({config.amp_min_in_dbm:.2f} dBm) at z = {z_curr:.2f} km."
                )

            if config.amp_sat_enabled:
                p_out_target = min(p_curr + mag_db, config.amp_sat_out_dbm)
                g_eff = max(0.0, p_out_target - p_curr)
                if g_eff < mag_db - 1e-6:
                    warnings.append(
                        f"{label} at z = {z_curr:.2f} km is output-saturated at "
                        f"{config.amp_sat_out_dbm:+.2f} dBm (effective gain {g_eff:.2f} dB "
                        f"vs. nominal {mag_db:.2f} dB)."
                    )
            else:
                g_eff = mag_db

            p_curr += g_eff
            effective_amp_gain_db += g_eff
            profile.append(
                PowerProfilePoint(z_curr, p_curr, f"{label} (Out)", "amplifier_out", float(g_eff))
            )
        else:
            if mag_db > 0.0:
                # Vertex immediately before discrete passive drop
                profile.append(PowerProfilePoint(z_curr, p_curr, f"{label} (In)", "fiber", 0.0))
                p_curr -= mag_db
                profile.append(
                    PowerProfilePoint(z_curr, p_curr, label, ev_type, -float(mag_db))
                )

    # 4. Final fiber span from last interior event to RX end z = L
    dz_final = max(0.0, L - z_curr)
    if dz_final > 0.0 or len(profile) == 1:
        p_curr -= alpha_db_per_km * dz_final
        z_curr = L
        profile.append(PowerProfilePoint(z_curr, p_curr, "End of Fiber", "fiber", 0.0))

    # 5. RX Connector at z = L
    if has_rx_conn and config.loss_per_connector_db > 0.0:
        p_curr -= config.loss_per_connector_db
        profile.append(
            PowerProfilePoint(
                z_curr, p_curr, "RX Connector", "connector", -float(config.loss_per_connector_db)
            )
        )

    # Mark final point explicitly as RX Input (or update label if already at z = L)
    profile.append(PowerProfilePoint(z_curr, p_curr, "RX Input", "rx", 0.0))

    return profile, float(effective_amp_gain_db), warnings, amp_floor_violated


# ==============================================================================
# 5. LINK POWER BUDGET EVALUATOR (Agrawal 5e, Sec. 5.2.3, Eqs. 5.2.2–5.2.3)
# ==============================================================================

def _compute_reach_given_gain(
    config: LinkConfig,
    alpha_db_per_km: float,
    connector_loss_db: float,
    splitter_loss_db: float,
    total_gain_db: float,
) -> Tuple[float, Optional[float]]:
    """
    Internal helper returning (exact_max_reach_km, distributed_reel_reach_km)
    for a given cumulative amplifier gain.

    - Fixed splice mode (Agrawal 5e, Eqs. 5.2.2–5.2.3):
          L_max = max(0, (P_tx + G_total - P_rec - M_s - alpha_con - alpha_splice - alpha_split) / alpha_f)
    - Reel splice mode (splice loss L_splice every L_reel km, e.g., Agrawal Problem 5.4):
        * Distributed cable-loss approximation:
              L_max_dist = max(0, B_fs / (alpha_f + L_splice / L_reel))
        * Exact discrete interior-splice reach (k reels => k - 1 splices):
              largest L >= 0 satisfying alpha_f * L + max(0, ceil(L/L_reel) - 1) * L_splice <= B_fs
    """
    avail_channel_loss = config.tx_power_dbm + total_gain_db - config.rx_sensitivity_dbm - config.system_margin_db

    if config.splice_mode == "fixed":
        fixed_splice_loss = config.num_splices * config.loss_per_splice_db
        budget_for_fiber = avail_channel_loss - connector_loss_db - fixed_splice_loss - splitter_loss_db
        l_max = max(0.0, budget_for_fiber / alpha_db_per_km)
        return float(l_max), None

    # Reel-spacing splice mode
    budget_fs = avail_channel_loss - connector_loss_db - splitter_loss_db
    if budget_fs <= 0.0:
        return 0.0, 0.0

    reel = float(config.reel_length_km)
    l_sp = float(config.loss_per_splice_db)

    # Distributed splice loss approximation
    alpha_eff_dist = alpha_db_per_km + (l_sp / reel)
    l_max_dist = max(0.0, budget_fs / alpha_eff_dist)

    # Exact discrete interior-splice reach:
    # For L in ((k-1)*reel, k*reel], there are (k-1) interior splices.
    # Total loss at the start of interval k is (k-1)*(alpha_f*reel + l_sp).
    span_cost = alpha_db_per_km * reel + l_sp
    k_est = int(math.floor(budget_fs / span_cost)) + 1

    best_l = 0.0
    for k in range(max(1, k_est - 1), k_est + 2):
        lower_edge = (k - 1) * reel
        upper_edge = k * reel
        l_candidate = (budget_fs - (k - 1) * l_sp) / alpha_db_per_km
        if l_candidate >= lower_edge - 1e-12:
            feasible_l = min(upper_edge, max(lower_edge, l_candidate))
            if feasible_l > best_l:
                best_l = feasible_l

    return float(best_l), float(l_max_dist)


def evaluate_link_budget(config: LinkConfig) -> PowerBudgetResult:
    """
    Evaluate the complete optical link power budget for `config`.

    Equations (Agrawal 5e, Chapter 5, Sec. 5.2.3, Eqs. 5.2.2–5.2.3):
        C_L        = alpha_f(lambda) * L + alpha_con + alpha_splice + alpha_split
        P_rx       = P_tx - C_L + G_total
        M_gross    = P_rx - P_rec
        M_net      = P_rx - P_rec - M_s = C_L_avail - C_L
        PASS      <=> M_net >= 0 dB (and no overload / amplifier-floor violation)
    """
    config.validate()

    # 1. Fiber attenuation coefficient at operating wavelength
    atten = compute_fiber_attenuation(config.wavelength_nm, config.fiber_params)
    alpha_f = atten.total_db_per_km
    L = float(config.fiber_length_km)

    # 2. Passive losses
    fiber_loss_db = alpha_f * L
    connector_loss_db = float(config.num_connectors) * float(config.loss_per_connector_db)
    splice_positions = compute_splice_positions(config, L)
    effective_num_splices = len(splice_positions)
    splice_loss_db = float(effective_num_splices) * float(config.loss_per_splice_db)
    splitter_loss_db = compute_splitter_loss(config)
    total_passive_loss_db = fiber_loss_db + connector_loss_db + splice_loss_db + splitter_loss_db

    # Fiber loss physical subcomponents (dB)
    if atten.is_override:
        fiber_sub = {
            "rayleigh": 0.0,
            "absorption": 0.0,
            "waveguide": 0.0,
            "bending": 0.0,
            "specified_cable": float(fiber_loss_db),
        }
    else:
        fiber_sub = {
            "rayleigh": float(atten.rayleigh_db_per_km * L),
            "absorption": float(atten.total_absorption_db_per_km * L),
            "waveguide": float(atten.waveguide_db_per_km * L),
            "bending": float(atten.total_bending_db_per_km * L),
            "specified_cable": 0.0,
        }

    # 3. Trace spatial power profile P(z) and obtain actual effective amplifier gain
    profile, effective_amp_gain_db, warnings, amp_floor_violated = _trace_spatial_power_profile(
        config=config,
        alpha_db_per_km=alpha_f,
        splitter_loss_db=splitter_loss_db,
        splice_positions_km=splice_positions,
    )
    nominal_amp_gain_db = float(config.num_amplifiers) * float(config.amp_gain_db)

    # 4. End-to-end power budget quantities
    net_loss_db = total_passive_loss_db - effective_amp_gain_db
    available_channel_loss_db = (
        config.tx_power_dbm + effective_amp_gain_db - config.rx_sensitivity_dbm - config.system_margin_db
    )
    received_power_dbm = config.tx_power_dbm - total_passive_loss_db + effective_amp_gain_db
    received_power_mw = dbm_to_mw(received_power_dbm)

    design_threshold_dbm = config.rx_sensitivity_dbm + config.system_margin_db
    gross_margin_db = received_power_dbm - config.rx_sensitivity_dbm
    net_margin_db = received_power_dbm - design_threshold_dbm

    # 5. Maximum reach for the active configuration
    max_reach_km, max_reach_dist_km = _compute_reach_given_gain(
        config=config,
        alpha_db_per_km=alpha_f,
        connector_loss_db=connector_loss_db,
        splitter_loss_db=splitter_loss_db,
        total_gain_db=effective_amp_gain_db,
    )

    # 6. Pass / Fail decision & engineering diagnostics
    overload_violated = (
        config.rx_overload_enabled and received_power_dbm > config.rx_overload_dbm + 1e-9
    )
    if overload_violated:
        warnings.append(
            f"Receiver overload: received power ({received_power_dbm:+.2f} dBm) exceeds "
            f"receiver saturation limit ({config.rx_overload_dbm:+.2f} dBm)."
        )

    margin_ok = net_margin_db >= -1e-9
    passed = margin_ok and (not overload_violated) and (not amp_floor_violated)

    if passed:
        status_label = "PASS"
        diagnostic_message = (
            f"Link meets power & margin requirements: P_rx = {received_power_dbm:+.2f} dBm "
            f"(+{max(0.0, net_margin_db):.2f} dB excess margin above {design_threshold_dbm:+.2f} dBm threshold)."
        )
    else:
        status_label = "FAIL"
        reasons: List[str] = []
        if not margin_ok:
            reasons.append(
                f"power deficit of {abs(net_margin_db):.2f} dB "
                f"(P_rx = {received_power_dbm:+.2f} dBm < threshold {design_threshold_dbm:+.2f} dBm)"
            )
        if overload_violated:
            reasons.append(
                f"receiver overload (+{received_power_dbm - config.rx_overload_dbm:.2f} dB above {config.rx_overload_dbm:+.2f} dBm)"
            )
        if amp_floor_violated:
            reasons.append("in-line amplifier input dropped below minimum floor")
        diagnostic_message = "Link FAILS: " + "; ".join(reasons) + "."

    loss_breakdown_db = {
        "fiber": float(fiber_loss_db),
        "connectors": float(connector_loss_db),
        "splices": float(splice_loss_db),
        "splitter": float(splitter_loss_db),
        "system_margin": float(config.system_margin_db),
    }

    return PowerBudgetResult(
        wavelength_nm=float(config.wavelength_nm),
        fiber_length_km=L,
        tx_power_dbm=float(config.tx_power_dbm),
        tx_power_mw=dbm_to_mw(config.tx_power_dbm),
        rx_sensitivity_dbm=float(config.rx_sensitivity_dbm),
        rx_sensitivity_mw=dbm_to_mw(config.rx_sensitivity_dbm),
        attenuation=atten,
        effective_num_splices=effective_num_splices,
        fiber_loss_db=float(fiber_loss_db),
        fiber_loss_subcomponents_db=fiber_sub,
        connector_loss_db=float(connector_loss_db),
        splice_loss_db=float(splice_loss_db),
        splitter_loss_db=float(splitter_loss_db),
        total_passive_loss_db=float(total_passive_loss_db),
        nominal_amp_gain_db=float(nominal_amp_gain_db),
        effective_amp_gain_db=float(effective_amp_gain_db),
        net_loss_db=float(net_loss_db),
        available_channel_loss_db=float(available_channel_loss_db),
        received_power_dbm=float(received_power_dbm),
        received_power_mw=float(received_power_mw),
        system_margin_db=float(config.system_margin_db),
        gross_margin_db=float(gross_margin_db),
        net_margin_db=float(net_margin_db),
        design_threshold_dbm=float(design_threshold_dbm),
        max_reach_km=float(max_reach_km),
        max_reach_distributed_km=max_reach_dist_km,
        passed=passed,
        status_label=status_label,
        diagnostic_message=diagnostic_message,
        warnings=warnings,
        loss_breakdown_db=loss_breakdown_db,
        power_profile=profile,
    )


# ==============================================================================
# 6. DESIGN MODE SOLVERS (Max Reach & Required Amplifiers)
# ==============================================================================

def solve_max_reach(config: LinkConfig) -> DesignSolution:
    """
    Design Mode A: Solve for the maximum feasible fiber length L_max [km]
    such that Net Link Margin M_net >= 0 dB (i.e., P_rx >= P_rec + M_s).

    Handles both fixed-count and reel-spaced splices, and verifies the solved
    length through `evaluate_link_budget` (including optional amplifier
    output-power saturation clamping via bisection if saturation is active).
    """
    config.validate()
    atten = compute_fiber_attenuation(config.wavelength_nm, config.fiber_params)
    alpha_f = atten.total_db_per_km
    connector_loss = float(config.num_connectors) * float(config.loss_per_connector_db)
    splitter_loss = compute_splitter_loss(config)
    nominal_gain = float(config.num_amplifiers) * float(config.amp_gain_db)

    # Closed-form linear upper bound
    l_max_linear, l_max_dist = _compute_reach_given_gain(
        config=config,
        alpha_db_per_km=alpha_f,
        connector_loss_db=connector_loss,
        splitter_loss_db=splitter_loss,
        total_gain_db=nominal_gain,
    )

    if config.num_amplifiers > 0 and (config.amp_sat_enabled or config.amp_min_in_enabled):
        # Verify whether saturation or min-input floor reduces max reach below linear bound
        test_cfg = copy.deepcopy(config)
        test_cfg.fiber_length_km = l_max_linear
        test_res = evaluate_link_budget(test_cfg)
        if test_res.passed:
            l_solved = l_max_linear
        else:
            # Binary search on [0, l_max_linear] for largest feasible reach
            lo, hi = 0.0, l_max_linear
            for _ in range(50):
                mid = 0.5 * (lo + hi)
                test_cfg.fiber_length_km = mid
                res_mid = evaluate_link_budget(test_cfg)
                if res_mid.passed:
                    lo = mid
                else:
                    hi = mid
            l_solved = lo
    else:
        l_solved = l_max_linear

    solved_cfg = copy.deepcopy(config)
    solved_cfg.fiber_length_km = l_solved
    verified = evaluate_link_budget(solved_cfg)

    n_amp = int(config.num_amplifiers)
    span_len = l_solved / (n_amp + 1) if l_solved > 0 else 0.0
    amp_pos = [span_len * k for k in range(1, n_amp + 1)]
    feasible = l_solved > 0.0 and verified.passed

    if config.splice_mode == "reel" and l_max_dist is not None:
        summary = (
            f"Maximum feasible reach L_max = {l_solved:.3f} km "
            f"(distributed-splice estimate: {l_max_dist:.3f} km) at "
            f"{config.wavelength_nm:.0f} nm (alpha = {alpha_f:.4f} dB/km, "
            f"M_s = {config.system_margin_db:.1f} dB)."
        )
    else:
        summary = (
            f"Maximum feasible reach L_max = {l_solved:.3f} km at "
            f"{config.wavelength_nm:.0f} nm (alpha = {alpha_f:.4f} dB/km, "
            f"N_amp = {n_amp}, M_s = {config.system_margin_db:.1f} dB)."
        )

    return DesignSolution(
        mode="max_reach",
        target_length_km=None,
        solved_max_reach_km=float(l_solved),
        solved_max_reach_distributed_km=l_max_dist,
        solved_num_amplifiers=n_amp,
        span_length_km=float(span_len),
        span_loss_db=float(alpha_f * span_len),
        amplifier_positions_km=amp_pos,
        feasible=feasible,
        summary=summary,
        verified_result=verified,
    )


def solve_required_amplifiers(
    config: LinkConfig,
    target_length_km: Optional[float] = None,
    max_amplifiers: int = 500,
) -> DesignSolution:
    """
    Design Mode B: Solve for the minimum number of uniformly spaced in-line
    optical amplifiers N_amp required to achieve `target_length_km` with
    Net Link Margin M_net >= 0 dB (Agrawal 5e, Sec. 7.1.1–7.1.2).

    Closed-form linear lower bound:
        Delta_deficit = C_L(L_target) + M_s - (P_tx - P_rec)
        N_amp = 0                               if Delta_deficit <= 0
        N_amp = ceil(Delta_deficit / G_amp)     if Delta_deficit > 0

    Followed by full spatial power-profile verification under optional output
    saturation clamping (`amp_sat_enabled`) and minimum amplifier input floor
    (`amp_min_in_enabled`), incrementing N_amp if nonlinear clamping requires
    shorter spans.
    """
    base_cfg = copy.deepcopy(config)
    L_target = float(config.fiber_length_km if target_length_km is None else target_length_km)
    base_cfg.fiber_length_km = L_target
    base_cfg.validate()

    # Check unamplified case (N_amp = 0) first
    zero_cfg = copy.deepcopy(base_cfg)
    zero_cfg.num_amplifiers = 0
    res_zero = evaluate_link_budget(zero_cfg)
    alpha_f = res_zero.attenuation.total_db_per_km

    if res_zero.passed:
        return DesignSolution(
            mode="required_amplifiers",
            target_length_km=L_target,
            solved_max_reach_km=res_zero.max_reach_km,
            solved_max_reach_distributed_km=res_zero.max_reach_distributed_km,
            solved_num_amplifiers=0,
            span_length_km=L_target,
            span_loss_db=float(alpha_f * L_target),
            amplifier_positions_km=[],
            feasible=True,
            summary=(
                f"No optical amplification required for L = {L_target:.2f} km "
                f"(unamplified net margin = +{res_zero.net_margin_db:.2f} dB)."
            ),
            verified_result=res_zero,
        )

    # Needs amplification
    if base_cfg.amp_gain_db <= 0.0:
        return DesignSolution(
            mode="required_amplifiers",
            target_length_km=L_target,
            solved_max_reach_km=res_zero.max_reach_km,
            solved_max_reach_distributed_km=res_zero.max_reach_distributed_km,
            solved_num_amplifiers=None,
            span_length_km=L_target,
            span_loss_db=float(alpha_f * L_target),
            amplifier_positions_km=[],
            feasible=False,
            summary="Infeasible: link requires amplification but amp_gain_db <= 0 dB.",
            verified_result=res_zero,
        )

    deficit_db = max(0.0, -res_zero.net_margin_db)
    n_start = max(1, int(math.ceil((deficit_db - 1e-12) / base_cfg.amp_gain_db)))

    verified: Optional[PowerBudgetResult] = None
    solved_n: Optional[int] = None

    for n_try in range(n_start, max_amplifiers + 1):
        try_cfg = copy.deepcopy(base_cfg)
        try_cfg.num_amplifiers = n_try
        res_try = evaluate_link_budget(try_cfg)
        verified = res_try
        # Note: if overload is triggered solely because discrete gain overshoots
        # by < G_amp, we still check passed; if passed is True, we're done.
        if res_try.passed:
            solved_n = n_try
            break

    if solved_n is None or verified is None:
        return DesignSolution(
            mode="required_amplifiers",
            target_length_km=L_target,
            solved_max_reach_km=res_zero.max_reach_km,
            solved_max_reach_distributed_km=res_zero.max_reach_distributed_km,
            solved_num_amplifiers=None,
            span_length_km=None,
            span_loss_db=None,
            amplifier_positions_km=[],
            feasible=False,
            summary=(
                f"Infeasible within {max_amplifiers} amplifiers (G_amp = {base_cfg.amp_gain_db:.1f} dB) "
                f"for target length {L_target:.2f} km."
            ),
            verified_result=verified if verified is not None else res_zero,
        )

    span_len = L_target / (solved_n + 1)
    span_loss = alpha_f * span_len
    amp_positions = [span_len * k for k in range(1, solved_n + 1)]

    return DesignSolution(
        mode="required_amplifiers",
        target_length_km=L_target,
        solved_max_reach_km=verified.max_reach_km,
        solved_max_reach_distributed_km=verified.max_reach_distributed_km,
        solved_num_amplifiers=solved_n,
        span_length_km=float(span_len),
        span_loss_db=float(span_loss),
        amplifier_positions_km=amp_positions,
        feasible=True,
        summary=(
            f"Requires {solved_n} in-line amplifier(s) (G_amp = {base_cfg.amp_gain_db:.1f} dB each) "
            f"for L = {L_target:.2f} km -> {solved_n + 1} uniform spans of {span_len:.2f} km "
            f"({span_loss:.2f} dB/span); verified net margin = +{verified.net_margin_db:.2f} dB."
        ),
        verified_result=verified,
    )


# ==============================================================================
# 7. MULTI-WAVELENGTH MARGIN VS. LENGTH SWEEP (Visualization V3)
# ==============================================================================

def compute_margin_vs_length(
    config: LinkConfig,
    wavelengths_nm: Sequence[float] = (850.0, 1310.0, 1550.0),
    max_length_km: Optional[float] = None,
    num_points: int = 250,
    ignore_alpha_override: bool = True,
) -> Dict[str, Any]:
    """
    Compute Net Link Margin M_net(L) [dB] vs. fiber length L [km] across
    multiple operating wavelengths (default: 850, 1310, 1550 nm) for plotting
    Visualization V3.

    When `ignore_alpha_override` is True (default), each wavelength uses the
    physical silica attenuation model alpha(lambda) even if the active config
    has a single-wavelength textbook override set — ensuring a physically
    meaningful multi-wavelength comparison.
    """
    config.validate()
    base_fp = copy.deepcopy(config.fiber_params)
    if ignore_alpha_override:
        base_fp.alpha_override_db_per_km = None

    # Determine each wavelength's attenuation and exact L_max crossing
    per_wl_info: List[Tuple[float, AttenuationBreakdown, float]] = []
    max_reach_seen = 0.0
    for wl in wavelengths_nm:
        wl_cfg = copy.deepcopy(config)
        wl_cfg.wavelength_nm = float(wl)
        wl_cfg.fiber_params = copy.deepcopy(base_fp)
        sol = solve_max_reach(wl_cfg)
        atten = compute_fiber_attenuation(float(wl), base_fp)
        l_reach = sol.solved_max_reach_km or 0.0
        max_reach_seen = max(max_reach_seen, l_reach)
        per_wl_info.append((float(wl), atten, l_reach))

    if max_length_km is None:
        # Choose a clean span slightly past the longest wavelength reach (or active length)
        auto_max = max(config.fiber_length_km * 1.25, max_reach_seen * 1.15, 10.0)
        max_length_km = float(auto_max)

    lengths = np.linspace(0.0, float(max_length_km), int(num_points))
    curves: List[Dict[str, Any]] = []

    for wl, atten, l_reach in per_wl_info:
        wl_cfg = copy.deepcopy(config)
        wl_cfg.wavelength_nm = wl
        wl_cfg.fiber_params = copy.deepcopy(base_fp)

        margins: List[float] = []
        rx_powers: List[float] = []
        for L_val in lengths:
            wl_cfg.fiber_length_km = float(L_val)
            res = evaluate_link_budget(wl_cfg)
            margins.append(res.net_margin_db)
            rx_powers.append(res.received_power_dbm)

        curves.append({
            "wavelength_nm": wl,
            "alpha_db_per_km": atten.total_db_per_km,
            "max_reach_km": l_reach,
            "net_margin_db": margins,
            "received_power_dbm": rx_powers,
        })

    return {
        "lengths_km": lengths.tolist(),
        "max_length_km": float(max_length_km),
        "system_margin_db": float(config.system_margin_db),
        "curves": curves,
    }


# ==============================================================================
# 8. BUILT-IN FIBER & LINK PRESETS (Agrawal Benchmarks + Telecom Scenarios)
# ==============================================================================

FIBER_PRESETS: Dict[str, FiberParams] = {
    "smf28_conventional": FiberParams(
        name="Standard SMF-28 (ITU-T G.652.B)",
        rayleigh_coeff_cr=0.85,
        oh_concentration_ppb=15.0,
        waveguide_loss_db_per_km=0.015,
        bend_radius_mm=30.0,
        microbending_db_per_km=0.0,
    ),
    "smf28_dry": FiberParams(
        name="Dry Low-Water-Peak SMF (ITU-T G.652.D / AllWave)",
        rayleigh_coeff_cr=0.82,
        oh_concentration_ppb=0.5,
        waveguide_loss_db_per_km=0.015,
        bend_radius_mm=30.0,
        microbending_db_per_km=0.0,
    ),
    "mmf_grin_50": FiberParams(
        name="Graded-Index MMF 50/125 um (850 nm LAN)",
        rayleigh_coeff_cr=1.15,
        oh_concentration_ppb=20.0,
        waveguide_loss_db_per_km=0.030,
        bend_radius_mm=30.0,
        microbending_db_per_km=0.02,
    ),
}


def _agrawal_table5_1_fiber() -> FiberParams:
    """Cable parameters from Agrawal 5e, Sec. 5.2.3, Table 5.1 (alpha_f = 3.5 dB/km)."""
    return FiberParams(
        name="Agrawal Table 5.1 Graded-Index Cable (3.5 dB/km)",
        rayleigh_coeff_cr=1.15,
        oh_concentration_ppb=20.0,
        waveguide_loss_db_per_km=0.030,
        bend_radius_mm=30.0,
        alpha_override_db_per_km=3.5,
    )


PRESETS: Dict[str, Dict[str, Any]] = {
    "agrawal_table5_1_laser": {
        "label": "Agrawal 5e Table 5.1 — 850 nm Laser + p-i-n",
        "description": (
            "Worked textbook example (Agrawal 5e, Sec. 5.2.3, Table 5.1, pp. 158–159): "
            "100 Mb/s, 8 km target, 0 dBm GaAs laser, -42 dBm p-i-n, 3.5 dB/km cable, "
            "2 dB connectors, 6 dB margin -> C_L = 36 dB, L_max = 9.71 km (PASS)."
        ),
        "config": LinkConfig(
            wavelength_nm=850.0,
            fiber_length_km=8.0,
            tx_power_dbm=0.0,
            rx_sensitivity_dbm=-42.0,
            system_margin_db=6.0,
            num_connectors=2,
            loss_per_connector_db=1.0,
            splice_mode="fixed",
            num_splices=0,
            loss_per_splice_db=0.0,
            splitter_mode="ratio",
            split_ratio=1,
            num_amplifiers=0,
            amp_gain_db=20.0,
            fiber_params=_agrawal_table5_1_fiber(),
        ),
    },
    "agrawal_table5_1_led": {
        "label": "Agrawal 5e Table 5.1 — 850 nm LED + p-i-n",
        "description": (
            "Worked textbook example (Agrawal 5e, Sec. 5.2.3, Table 5.1, pp. 158–159): "
            "100 Mb/s, 8 km target, -13 dBm LED (50 uW), -42 dBm p-i-n, 3.5 dB/km cable, "
            "2 dB connectors, 6 dB margin -> C_L = 23 dB, L_max = 6.00 km (FAIL at 8 km)."
        ),
        "config": LinkConfig(
            wavelength_nm=850.0,
            fiber_length_km=8.0,
            tx_power_dbm=-13.0,
            rx_sensitivity_dbm=-42.0,
            system_margin_db=6.0,
            num_connectors=2,
            loss_per_connector_db=1.0,
            splice_mode="fixed",
            num_splices=0,
            loss_per_splice_db=0.0,
            splitter_mode="ratio",
            split_ratio=1,
            num_amplifiers=0,
            amp_gain_db=20.0,
            fiber_params=_agrawal_table5_1_fiber(),
        ),
    },
    "agrawal_table5_1_led_apd": {
        "label": "Agrawal 5e Sec. 5.2.3 — 850 nm LED + APD",
        "description": (
            "Worked textbook upgrade (Agrawal 5e, Sec. 5.2.3, pp. 158–159): replacing p-i-n "
            "with an APD (+7 dB sensitivity -> -49 dBm) extends the LED link to L_max = 8.00 km (PASS)."
        ),
        "config": LinkConfig(
            wavelength_nm=850.0,
            fiber_length_km=8.0,
            tx_power_dbm=-13.0,
            rx_sensitivity_dbm=-49.0,
            system_margin_db=6.0,
            num_connectors=2,
            loss_per_connector_db=1.0,
            splice_mode="fixed",
            num_splices=0,
            loss_per_splice_db=0.0,
            splitter_mode="ratio",
            split_ratio=1,
            num_amplifiers=0,
            amp_gain_db=20.0,
            fiber_params=_agrawal_table5_1_fiber(),
        ),
    },
    "metro_1310_smf": {
        "label": "Metro 1310 nm SMF-28 Link (40 km)",
        "description": (
            "Metropolitan 1310 nm single-mode link over 40 km of standard G.652.B SMF-28 "
            "(alpha ≈ 0.34 dB/km), +2 dBm DFB laser, -24 dBm p-i-n receiver, 2 connectors, "
            "8 fusion splices, 4 dB system margin."
        ),
        "config": LinkConfig(
            wavelength_nm=1310.0,
            fiber_length_km=40.0,
            tx_power_dbm=2.0,
            rx_sensitivity_dbm=-24.0,
            system_margin_db=4.0,
            num_connectors=2,
            loss_per_connector_db=0.5,
            splice_mode="fixed",
            num_splices=8,
            loss_per_splice_db=0.1,
            splitter_mode="ratio",
            split_ratio=1,
            num_amplifiers=0,
            amp_gain_db=20.0,
            fiber_params=copy.deepcopy(FIBER_PRESETS["smf28_conventional"]),
        ),
    },
    "longhaul_1550_amplified": {
        "label": "Long-Haul 1550 nm Amplified Link (400 km, 3 EDFAs)",
        "description": (
            "Periodically amplified 1550 nm SMF-28 trunk (Agrawal 5e, Sec. 7.1.2): "
            "400 km total length, +2 dBm launch, -28 dBm receiver, 3 in-line EDFAs "
            "(20 dB gain each, 100 km uniform spans), 2 connectors, 20 splices, 4 dB margin."
        ),
        "config": LinkConfig(
            wavelength_nm=1550.0,
            fiber_length_km=400.0,
            tx_power_dbm=2.0,
            rx_sensitivity_dbm=-28.0,
            system_margin_db=4.0,
            num_connectors=2,
            loss_per_connector_db=0.5,
            splice_mode="fixed",
            num_splices=20,
            loss_per_splice_db=0.08,
            splitter_mode="ratio",
            split_ratio=1,
            num_amplifiers=3,
            amp_gain_db=20.0,
            amp_sat_enabled=True,
            amp_sat_out_dbm=17.0,
            fiber_params=copy.deepcopy(FIBER_PRESETS["smf28_conventional"]),
        ),
    },
    "ftth_gpon_1x32": {
        "label": "FTTH GPON Access Link (1550 nm, 15 km, 1:32 Splitter)",
        "description": (
            "Passive Optical Network downstream link at 1550 nm over 15 km of SMF-28 "
            "with a 1:32 optical splitter (15.05 dB split + 0.8 dB excess loss), "
            "+3 dBm OLT transmitter, -27 dBm ONT receiver, 4 connectors, 4 splices, 3 dB margin."
        ),
        "config": LinkConfig(
            wavelength_nm=1550.0,
            fiber_length_km=15.0,
            tx_power_dbm=3.0,
            rx_sensitivity_dbm=-27.0,
            system_margin_db=3.0,
            num_connectors=4,
            loss_per_connector_db=0.4,
            splice_mode="fixed",
            num_splices=4,
            loss_per_splice_db=0.1,
            splitter_mode="ratio",
            split_ratio=32,
            splitter_excess_loss_db=0.8,
            splitter_position_frac=0.80,
            num_amplifiers=0,
            amp_gain_db=20.0,
            fiber_params=copy.deepcopy(FIBER_PRESETS["smf28_dry"]),
        ),
    },
}


def get_preset_config(preset_key: str) -> LinkConfig:
    """Return a deep copy of a named built-in LinkConfig preset."""
    if preset_key not in PRESETS:
        raise KeyError(f"Unknown preset '{preset_key}'. Available: {list(PRESETS.keys())}")
    return copy.deepcopy(PRESETS[preset_key]["config"])


def list_presets_serialized() -> List[Dict[str, Any]]:
    """Return all built-in presets in JSON-serializable format for the Phase 3 web API."""
    items: List[Dict[str, Any]] = []
    for key, meta in PRESETS.items():
        items.append({
            "id": key,
            "label": meta["label"],
            "description": meta["description"],
            "config": meta["config"].to_dict(),
        })
    return items
