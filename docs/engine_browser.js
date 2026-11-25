/* ============================================================================
   engine_browser.js — Pure-JavaScript Port of physics_engine.py & validate_agrawal.py
   ============================================================================
   Course:        26ECE31H — Fiber Optic Communications (BUE)
   Project:       Option 2 — Attenuation and Link Power Budget Tool (Group 9)
   Primary Ref:   Govind P. Agrawal, "Fiber-Optic Communication Systems,"
                  5th Edition, John Wiley & Sons (2021).

   Provides a 100% client-side, zero-backend execution engine for static GitHub
   Pages hosting (optical.kareemmas3ud.me), matching Python `physics_engine.py`
   and `validate_agrawal.py` to floating-point precision across all 27 benchmarks.
   ============================================================================ */

(function (globalScope) {
  "use strict";

  // Physical Constants (SI)
  const PLANCK_H = 6.62607015e-34;            // [J*s]
  const SPEED_OF_LIGHT = 2.99792458e8;        // [m/s]
  const DB_PER_NEPER = 10.0 / Math.log(10.0); // ~4.342944819032518 [dB/Np]
  const NEPER_PER_DB = Math.log(10.0) / 10.0; // ~0.2302585092994046 [Np/dB]

  // OH- vibrational overtone/combination peaks: [center_um, strength_db_per_km_per_ppb, sigma_um]
  const OH_ABSORPTION_PEAKS = [
    [1.385, 0.0500, 0.016],
    [1.240, 0.0030, 0.015],
    [0.950, 0.0015, 0.015],
  ];

  // ==========================================================================
  // 1. Unit Conversion Utilities (Agrawal 5e, Appendix A, Eqs. A.1–A.3)
  // ==========================================================================
  function dbmToMw(powerDbm) {
    return Math.pow(10.0, powerDbm / 10.0);
  }

  function mwToDbm(powerMw) {
    if (powerMw <= 0.0) {
      throw new Error(`Optical power in mW must be strictly positive; got ${powerMw}.`);
    }
    return 10.0 * Math.log10(powerMw);
  }

  function linearToDb(ratio) {
    if (ratio <= 0.0) {
      throw new Error(`Linear ratio must be strictly positive; got ${ratio}.`);
    }
    return 10.0 * Math.log10(ratio);
  }

  function dbToLinear(valueDb) {
    return Math.pow(10.0, valueDb / 10.0);
  }

  function alphaDbToLinear(alphaDbPerKm) {
    return alphaDbPerKm * NEPER_PER_DB;
  }

  function alphaLinearToDb(alphaPerKm) {
    return alphaPerKm * DB_PER_NEPER;
  }

  function receiverSensitivityFromPhotons(photonsPerBit, bitRateBps, wavelengthNm) {
    if (photonsPerBit <= 0 || bitRateBps <= 0 || wavelengthNm <= 0) {
      throw new Error("photons_per_bit, bit_rate_bps, and wavelength_nm must be positive.");
    }
    const lamM = wavelengthNm * 1e-9;
    const pWatts = photonsPerBit * ((PLANCK_H * SPEED_OF_LIGHT) / lamM) * bitRateBps;
    return mwToDbm(pWatts * 1e3);
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // ==========================================================================
  // 2. Default Constructors & Validation (Matching Python Dataclasses)
  // ==========================================================================
  function createFiberParams(overrides = {}) {
    return {
      name: "Standard SMF-28 (ITU-T G.652.B)",
      rayleigh_coeff_cr: 0.85,
      uv_a: 1.10e-3,
      uv_lambda_um: 4.63,
      ir_a: 7.81e11,
      ir_lambda_um: 48.48,
      oh_concentration_ppb: 15.0,
      waveguide_loss_db_per_km: 0.015,
      bend_radius_mm: 30.0,
      bend_rc0_mm: 0.35,
      bend_prefactor_db_per_km: 100.0,
      microbending_db_per_km: 0.0,
      alpha_override_db_per_km: null,
      ...overrides,
    };
  }

  function createLinkConfig(overrides = {}) {
    const fp = createFiberParams(overrides.fiber_params || {});
    const cfg = {
      wavelength_nm: 1550.0,
      fiber_length_km: 40.0,
      tx_power_dbm: 0.0,
      rx_sensitivity_dbm: -28.0,
      rx_overload_enabled: false,
      rx_overload_dbm: -3.0,
      system_margin_db: 4.0,
      num_connectors: 2,
      loss_per_connector_db: 0.5,
      splice_mode: "fixed",
      num_splices: 4,
      reel_length_km: 2.0,
      loss_per_splice_db: 0.1,
      splitter_mode: "ratio",
      split_ratio: 1,
      splitter_excess_loss_db: 0.5,
      manual_splitter_loss_db: 0.0,
      splitter_position_frac: 0.80,
      num_amplifiers: 0,
      amp_gain_db: 20.0,
      amp_sat_enabled: false,
      amp_sat_out_dbm: 17.0,
      amp_min_in_enabled: false,
      amp_min_in_dbm: -35.0,
      ...overrides,
      fiber_params: fp,
    };
    return cfg;
  }

  function validateConfig(cfg) {
    if (!Number.isFinite(cfg.wavelength_nm) || cfg.wavelength_nm <= 0) {
      throw new Error("wavelength_nm must be strictly positive.");
    }
    if (!Number.isFinite(cfg.fiber_length_km) || cfg.fiber_length_km < 0) {
      throw new Error("fiber_length_km cannot be negative.");
    }
    if (!Number.isFinite(cfg.system_margin_db) || cfg.system_margin_db < 0) {
      throw new Error("system_margin_db cannot be negative.");
    }
    if (cfg.num_connectors < 0 || cfg.loss_per_connector_db < 0) {
      throw new Error("Connector count and per-connector loss must be non-negative.");
    }
    if (cfg.splice_mode !== "fixed" && cfg.splice_mode !== "reel") {
      throw new Error("splice_mode must be 'fixed' or 'reel'.");
    }
    if (cfg.num_splices < 0 || cfg.loss_per_splice_db < 0) {
      throw new Error("Splice count and per-splice loss must be non-negative.");
    }
    if (cfg.splice_mode === "reel" && (!Number.isFinite(cfg.reel_length_km) || cfg.reel_length_km <= 0)) {
      throw new Error("reel_length_km must be strictly positive in 'reel' splice mode.");
    }
    if (cfg.splitter_mode !== "ratio" && cfg.splitter_mode !== "manual") {
      throw new Error("splitter_mode must be 'ratio' or 'manual'.");
    }
    if (cfg.split_ratio < 1) {
      throw new Error("split_ratio must be >= 1.");
    }
    if (cfg.splitter_excess_loss_db < 0 || cfg.manual_splitter_loss_db < 0) {
      throw new Error("Splitter loss values must be non-negative.");
    }
    if (!(cfg.splitter_position_frac > 0.0 && cfg.splitter_position_frac < 1.0)) {
      throw new Error("splitter_position_frac must lie strictly between 0 and 1.");
    }
    if (cfg.num_amplifiers < 0 || cfg.amp_gain_db < 0) {
      throw new Error("num_amplifiers and amp_gain_db must be non-negative.");
    }
    const ov = cfg.fiber_params.alpha_override_db_per_km;
    if (ov !== null && ov !== undefined && (!Number.isFinite(ov) || ov <= 0)) {
      throw new Error("alpha_override_db_per_km must be strictly positive when set.");
    }
  }

  // ==========================================================================
  // 3. Fiber Attenuation Physics Model (Agrawal 5e, Ch. 2, Sec. 2.5)
  // ==========================================================================
  function computeFiberAttenuation(wavelengthNm, fiberParams) {
    if (wavelengthNm <= 0.0) {
      throw new Error(`wavelength_nm must be strictly positive; got ${wavelengthNm}.`);
    }
    const fp = fiberParams ? createFiberParams(fiberParams) : createFiberParams();
    const lamUm = wavelengthNm / 1000.0;

    // 1. Rayleigh scattering: Eq. (2.5.4)
    const aRayleigh = fp.rayleigh_coeff_cr / Math.pow(lamUm, 4);

    // 2. Intrinsic UV & IR exponential absorption tails
    const aUv = fp.uv_a * Math.exp(fp.uv_lambda_um / lamUm);
    const aIr = fp.ir_a * Math.exp(-fp.ir_lambda_um / lamUm);

    // 3. Extrinsic OH- water-vapor peaks
    let aOh = 0.0;
    if (fp.oh_concentration_ppb > 0.0) {
      for (const [centerUm, strengthPerPpb, sigmaUm] of OH_ABSORPTION_PEAKS) {
        const z = (lamUm - centerUm) / sigmaUm;
        aOh += fp.oh_concentration_ppb * strengthPerPpb * Math.exp(-0.5 * z * z);
      }
    }
    const aAbsTotal = aUv + aIr + aOh;

    // 4. Waveguide imperfections floor
    const aWg = Math.max(0.0, fp.waveguide_loss_db_per_km);

    // 5. Macrobending & microbending losses
    const rcEffMm = fp.bend_rc0_mm * Math.pow(lamUm / 1.31, 3);
    let aMacro;
    if (fp.bend_radius_mm <= 0.0) {
      aMacro = fp.bend_prefactor_db_per_km;
    } else {
      const exponent = -fp.bend_radius_mm / Math.max(rcEffMm, 1e-12);
      aMacro = fp.bend_prefactor_db_per_km * Math.exp(Math.max(exponent, -700.0));
    }
    const aMicro = Math.max(0.0, fp.microbending_db_per_km);
    const aBendTotal = aMacro + aMicro;

    const modeledTotal = aRayleigh + aAbsTotal + aWg + aBendTotal;
    const isOverride = fp.alpha_override_db_per_km !== null && fp.alpha_override_db_per_km !== undefined;
    const totalDbKm = isOverride ? Number(fp.alpha_override_db_per_km) : modeledTotal;

    return {
      wavelength_nm: Number(wavelengthNm),
      wavelength_um: lamUm,
      rayleigh_db_per_km: aRayleigh,
      uv_absorption_db_per_km: aUv,
      ir_absorption_db_per_km: aIr,
      oh_absorption_db_per_km: aOh,
      total_absorption_db_per_km: aAbsTotal,
      waveguide_db_per_km: aWg,
      macrobending_db_per_km: aMacro,
      microbending_db_per_km: aMicro,
      total_bending_db_per_km: aBendTotal,
      total_db_per_km: totalDbKm,
      linear_alpha_per_km: alphaDbToLinear(totalDbKm),
      is_override: isOverride,
    };
  }

  function linspace(start, stop, num) {
    if (num <= 1) return [start];
    const out = new Array(num);
    const step = (stop - start) / (num - 1);
    for (let i = 0; i < num; i++) {
      out[i] = start + i * step;
    }
    return out;
  }

  function computeAttenuationSpectrum(wavelengthsNm, fiberParams) {
    const fp = fiberParams ? createFiberParams(fiberParams) : createFiberParams();
    const wls = wavelengthsNm ? Array.from(wavelengthsNm) : linspace(800.0, 1700.0, 361);
    const fpNoOverride = { ...fp, alpha_override_db_per_km: null };

    const wavelengths_um = [];
    const rayleigh = [];
    const uv_absorption = [];
    const ir_absorption = [];
    const oh_absorption = [];
    const total_absorption = [];
    const waveguide = [];
    const macrobending = [];
    const microbending = [];
    const total_bending = [];
    const total = [];

    for (const w of wls) {
      const bd = computeFiberAttenuation(w, fpNoOverride);
      wavelengths_um.push(bd.wavelength_um);
      rayleigh.push(bd.rayleigh_db_per_km);
      uv_absorption.push(bd.uv_absorption_db_per_km);
      ir_absorption.push(bd.ir_absorption_db_per_km);
      oh_absorption.push(bd.oh_absorption_db_per_km);
      total_absorption.push(bd.total_absorption_db_per_km);
      waveguide.push(bd.waveguide_db_per_km);
      macrobending.push(bd.macrobending_db_per_km);
      microbending.push(bd.microbending_db_per_km);
      total_bending.push(bd.total_bending_db_per_km);
      total.push(bd.total_db_per_km);
    }

    const windows = {};
    for (const w of [850.0, 1310.0, 1550.0]) {
      windows[String(Math.round(w))] = computeFiberAttenuation(w, fp);
    }

    return {
      wavelengths_nm: wls,
      wavelengths_um,
      rayleigh,
      uv_absorption,
      ir_absorption,
      oh_absorption,
      total_absorption,
      waveguide,
      macrobending,
      microbending,
      total_bending,
      total,
      override_db_per_km: fp.alpha_override_db_per_km,
      windows,
    };
  }

  // ==========================================================================
  // 4. Discrete Components & Spatial Power-Level Profile Tracer P(z)
  // ==========================================================================
  function computeSplitterLoss(cfg) {
    if (cfg.splitter_mode === "manual") {
      return Math.max(0.0, Number(cfg.manual_splitter_loss_db));
    }
    if (cfg.split_ratio <= 1) return 0.0;
    return 10.0 * Math.log10(cfg.split_ratio) + Number(cfg.splitter_excess_loss_db);
  }

  function computeSplicePositions(cfg, lengthKm = null) {
    const L = lengthKm === null ? Number(cfg.fiber_length_km) : Number(lengthKm);
    if (L <= 0.0) {
      if (cfg.splice_mode === "fixed" && cfg.num_splices > 0) {
        return new Array(Math.trunc(cfg.num_splices)).fill(0.0);
      }
      return [];
    }
    if (cfg.splice_mode === "fixed") {
      const n = Math.trunc(cfg.num_splices);
      if (n <= 0) return [];
      const pos = [];
      for (let m = 1; m <= n; m++) {
        pos.push(L * (m / (n + 1)));
      }
      return pos;
    }
    const reel = Number(cfg.reel_length_km);
    const nInterior = Math.max(0, Math.ceil((L - 1e-12) / reel) - 1);
    const pos = [];
    for (let m = 1; m <= nInterior; m++) {
      pos.push(reel * m);
    }
    return pos;
  }

  function traceSpatialPowerProfile(cfg, alphaDbPerKm, splitterLossDb, splicePositionsKm) {
    const L = Number(cfg.fiber_length_km);
    const warnings = [];
    let ampFloorViolated = false;
    let effectiveAmpGainDb = 0.0;

    // [zKm, priority, eventType, label, magDb]
    const interiorEvents = [];
    const hasTxConn = cfg.num_connectors >= 1;
    const hasRxConn = cfg.num_connectors >= 2;
    const nMidConns = Math.max(0, Math.trunc(cfg.num_connectors) - 2);
    for (let j = 1; j <= nMidConns; j++) {
      const zConn = L > 0 ? L * (j / (nMidConns + 1)) : 0.0;
      interiorEvents.push([zConn, 1, "connector", `Patch Connector #${j + 1}`, cfg.loss_per_connector_db]);
    }

    splicePositionsKm.forEach((zSp, idx) => {
      interiorEvents.push([zSp, 2, "splice", `Splice #${idx + 1}`, cfg.loss_per_splice_db]);
    });

    if (splitterLossDb > 0.0) {
      const zSplit = L > 0 ? L * cfg.splitter_position_frac : 0.0;
      const splitTag =
        cfg.splitter_mode === "ratio" && cfg.split_ratio > 1
          ? `Splitter (1:${cfg.split_ratio})`
          : "Optical Splitter";
      interiorEvents.push([zSplit, 3, "splitter", splitTag, splitterLossDb]);
    }

    const nAmp = Math.trunc(cfg.num_amplifiers);
    for (let k = 1; k <= nAmp; k++) {
      const zAmp = L > 0 ? L * (k / (nAmp + 1)) : 0.0;
      interiorEvents.push([zAmp, 4, "amplifier", `In-Line Amp #${k}`, cfg.amp_gain_db]);
    }

    interiorEvents.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));

    const profile = [];
    let zCurr = 0.0;
    let pCurr = Number(cfg.tx_power_dbm);

    profile.push({ distance_km: 0.0, power_dbm: pCurr, event: "TX Launch", event_type: "tx", delta_db: 0.0 });

    if (hasTxConn && cfg.loss_per_connector_db > 0.0) {
      pCurr -= cfg.loss_per_connector_db;
      profile.push({
        distance_km: 0.0,
        power_dbm: pCurr,
        event: "TX Connector",
        event_type: "connector",
        delta_db: -Number(cfg.loss_per_connector_db),
      });
    }

    for (const [zEv, _prio, evType, label, magDb] of interiorEvents) {
      const dz = Math.max(0.0, zEv - zCurr);
      if (dz > 0.0) {
        pCurr -= alphaDbPerKm * dz;
        zCurr = zEv;
      }

      if (evType === "amplifier") {
        profile.push({ distance_km: zCurr, power_dbm: pCurr, event: `${label} (In)`, event_type: "amplifier_in", delta_db: 0.0 });

        if (cfg.amp_min_in_enabled && pCurr < cfg.amp_min_in_dbm - 1e-9) {
          ampFloorViolated = true;
          warnings.push(
            `${label} input (${pCurr.toFixed(2)} dBm) is below minimum amplifier input floor (${cfg.amp_min_in_dbm.toFixed(2)} dBm) at z = ${zCurr.toFixed(2)} km.`
          );
        }

        let gEff;
        if (cfg.amp_sat_enabled) {
          const pOutTarget = Math.min(pCurr + magDb, cfg.amp_sat_out_dbm);
          gEff = Math.max(0.0, pOutTarget - pCurr);
          if (gEff < magDb - 1e-6) {
            const signSat = cfg.amp_sat_out_dbm >= 0 ? "+" : "";
            warnings.push(
              `${label} at z = ${zCurr.toFixed(2)} km is output-saturated at ${signSat}${cfg.amp_sat_out_dbm.toFixed(2)} dBm (effective gain ${gEff.toFixed(2)} dB vs. nominal ${magDb.toFixed(2)} dB).`
            );
          }
        } else {
          gEff = magDb;
        }

        pCurr += gEff;
        effectiveAmpGainDb += gEff;
        profile.push({ distance_km: zCurr, power_dbm: pCurr, event: `${label} (Out)`, event_type: "amplifier_out", delta_db: gEff });
      } else if (magDb > 0.0) {
        profile.push({ distance_km: zCurr, power_dbm: pCurr, event: `${label} (In)`, event_type: "fiber", delta_db: 0.0 });
        pCurr -= magDb;
        profile.push({ distance_km: zCurr, power_dbm: pCurr, event: label, event_type: evType, delta_db: -Number(magDb) });
      }
    }

    const dzFinal = Math.max(0.0, L - zCurr);
    if (dzFinal > 0.0 || profile.length === 1) {
      pCurr -= alphaDbPerKm * dzFinal;
      zCurr = L;
      profile.push({ distance_km: zCurr, power_dbm: pCurr, event: "End of Fiber", event_type: "fiber", delta_db: 0.0 });
    }

    if (hasRxConn && cfg.loss_per_connector_db > 0.0) {
      pCurr -= cfg.loss_per_connector_db;
      profile.push({
        distance_km: zCurr,
        power_dbm: pCurr,
        event: "RX Connector",
        event_type: "connector",
        delta_db: -Number(cfg.loss_per_connector_db),
      });
    }

    profile.push({ distance_km: zCurr, power_dbm: pCurr, event: "RX Input", event_type: "rx", delta_db: 0.0 });

    return { profile, effectiveAmpGainDb, warnings, ampFloorViolated };
  }

  // ==========================================================================
  // 5. Link Power Budget Evaluator (Agrawal 5e, Sec. 5.2.3, Eqs. 5.2.2–5.2.3)
  // ==========================================================================
  function computeReachGivenGain(cfg, alphaDbPerKm, connectorLossDb, splitterLossDb, totalGainDb) {
    const availChannelLoss = cfg.tx_power_dbm + totalGainDb - cfg.rx_sensitivity_dbm - cfg.system_margin_db;

    if (cfg.splice_mode === "fixed") {
      const fixedSpliceLoss = cfg.num_splices * cfg.loss_per_splice_db;
      const budgetForFiber = availChannelLoss - connectorLossDb - fixedSpliceLoss - splitterLossDb;
      return [Math.max(0.0, budgetForFiber / alphaDbPerKm), null];
    }

    const budgetFs = availChannelLoss - connectorLossDb - splitterLossDb;
    if (budgetFs <= 0.0) return [0.0, 0.0];

    const reel = Number(cfg.reel_length_km);
    const lSp = Number(cfg.loss_per_splice_db);
    const alphaEffDist = alphaDbPerKm + lSp / reel;
    const lMaxDist = Math.max(0.0, budgetFs / alphaEffDist);

    const spanCost = alphaDbPerKm * reel + lSp;
    const kEst = Math.floor(budgetFs / spanCost) + 1;

    let bestL = 0.0;
    for (let k = Math.max(1, kEst - 1); k <= kEst + 1; k++) {
      const lowerEdge = (k - 1) * reel;
      const upperEdge = k * reel;
      const lCandidate = (budgetFs - (k - 1) * lSp) / alphaDbPerKm;
      if (lCandidate >= lowerEdge - 1e-12) {
        const feasibleL = Math.min(upperEdge, Math.max(lowerEdge, lCandidate));
        if (feasibleL > bestL) bestL = feasibleL;
      }
    }
    return [bestL, lMaxDist];
  }

  function fmtSigned(val, digits = 2) {
    return `${val >= 0 ? "+" : ""}${val.toFixed(digits)}`;
  }

  function evaluateLinkBudget(rawCfg) {
    const cfg = createLinkConfig(rawCfg);
    validateConfig(cfg);

    const atten = computeFiberAttenuation(cfg.wavelength_nm, cfg.fiber_params);
    const alphaF = atten.total_db_per_km;
    const L = Number(cfg.fiber_length_km);

    const fiberLossDb = alphaF * L;
    const connectorLossDb = Number(cfg.num_connectors) * Number(cfg.loss_per_connector_db);
    const splicePositions = computeSplicePositions(cfg, L);
    const effectiveNumSplices = splicePositions.length;
    const spliceLossDb = effectiveNumSplices * Number(cfg.loss_per_splice_db);
    const splitterLossDb = computeSplitterLoss(cfg);
    const totalPassiveLossDb = fiberLossDb + connectorLossDb + spliceLossDb + splitterLossDb;

    const fiberSub = atten.is_override
      ? { rayleigh: 0.0, absorption: 0.0, waveguide: 0.0, bending: 0.0, specified_cable: fiberLossDb }
      : {
          rayleigh: atten.rayleigh_db_per_km * L,
          absorption: atten.total_absorption_db_per_km * L,
          waveguide: atten.waveguide_db_per_km * L,
          bending: atten.total_bending_db_per_km * L,
          specified_cable: 0.0,
        };

    const { profile, effectiveAmpGainDb, warnings, ampFloorViolated } = traceSpatialPowerProfile(
      cfg, alphaF, splitterLossDb, splicePositions
    );
    const nominalAmpGainDb = Number(cfg.num_amplifiers) * Number(cfg.amp_gain_db);

    const netLossDb = totalPassiveLossDb - effectiveAmpGainDb;
    const availableChannelLossDb = cfg.tx_power_dbm + effectiveAmpGainDb - cfg.rx_sensitivity_dbm - cfg.system_margin_db;
    const receivedPowerDbm = cfg.tx_power_dbm - totalPassiveLossDb + effectiveAmpGainDb;
    const receivedPowerMw = dbmToMw(receivedPowerDbm);

    const designThresholdDbm = cfg.rx_sensitivity_dbm + cfg.system_margin_db;
    const grossMarginDb = receivedPowerDbm - cfg.rx_sensitivity_dbm;
    const netMarginDb = receivedPowerDbm - designThresholdDbm;

    const [maxReachKm, maxReachDistKm] = computeReachGivenGain(
      cfg, alphaF, connectorLossDb, splitterLossDb, effectiveAmpGainDb
    );

    const overloadViolated = cfg.rx_overload_enabled && receivedPowerDbm > cfg.rx_overload_dbm + 1e-9;
    if (overloadViolated) {
      warnings.push(
        `Receiver overload: received power (${fmtSigned(receivedPowerDbm, 2)} dBm) exceeds receiver saturation limit (${fmtSigned(cfg.rx_overload_dbm, 2)} dBm).`
      );
    }

    const marginOk = netMarginDb >= -1e-9;
    const passed = marginOk && !overloadViolated && !ampFloorViolated;
    const statusLabel = passed ? "PASS" : "FAIL";

    let diagnosticMessage;
    if (passed) {
      diagnosticMessage = `Link meets power & margin requirements: P_rx = ${fmtSigned(receivedPowerDbm, 2)} dBm (+${Math.max(0.0, netMarginDb).toFixed(2)} dB excess margin above ${fmtSigned(designThresholdDbm, 2)} dBm threshold).`;
    } else {
      const reasons = [];
      if (!marginOk) {
        reasons.push(`power deficit of ${Math.abs(netMarginDb).toFixed(2)} dB (P_rx = ${fmtSigned(receivedPowerDbm, 2)} dBm < threshold ${fmtSigned(designThresholdDbm, 2)} dBm)`);
      }
      if (overloadViolated) {
        reasons.push(`receiver overload (+${(receivedPowerDbm - cfg.rx_overload_dbm).toFixed(2)} dB above ${fmtSigned(cfg.rx_overload_dbm, 2)} dBm)`);
      }
      if (ampFloorViolated) {
        reasons.push("in-line amplifier input dropped below minimum floor");
      }
      diagnosticMessage = "Link FAILS: " + reasons.join("; ") + ".";
    }

    return {
      wavelength_nm: Number(cfg.wavelength_nm),
      fiber_length_km: L,
      tx_power_dbm: Number(cfg.tx_power_dbm),
      tx_power_mw: dbmToMw(cfg.tx_power_dbm),
      rx_sensitivity_dbm: Number(cfg.rx_sensitivity_dbm),
      rx_sensitivity_mw: dbmToMw(cfg.rx_sensitivity_dbm),
      attenuation: atten,
      effective_num_splices: effectiveNumSplices,
      fiber_loss_db: fiberLossDb,
      fiber_loss_subcomponents_db: fiberSub,
      connector_loss_db: connectorLossDb,
      splice_loss_db: spliceLossDb,
      splitter_loss_db: splitterLossDb,
      total_passive_loss_db: totalPassiveLossDb,
      nominal_amp_gain_db: nominalAmpGainDb,
      effective_amp_gain_db: effectiveAmpGainDb,
      net_loss_db: netLossDb,
      available_channel_loss_db: availableChannelLossDb,
      received_power_dbm: receivedPowerDbm,
      received_power_mw: receivedPowerMw,
      system_margin_db: Number(cfg.system_margin_db),
      gross_margin_db: grossMarginDb,
      net_margin_db: netMarginDb,
      design_threshold_dbm: designThresholdDbm,
      max_reach_km: maxReachKm,
      max_reach_distributed_km: maxReachDistKm,
      passed,
      status_label: statusLabel,
      diagnostic_message: diagnosticMessage,
      warnings,
      loss_breakdown_db: {
        fiber: fiberLossDb,
        connectors: connectorLossDb,
        splices: spliceLossDb,
        splitter: splitterLossDb,
        system_margin: Number(cfg.system_margin_db),
      },
      power_profile: profile,
    };
  }

  // ==========================================================================
  // 6. Design Mode Solvers (Max Reach & Required Amplifiers)
  // ==========================================================================
  function solveMaxReach(rawCfg) {
    const cfg = createLinkConfig(rawCfg);
    validateConfig(cfg);

    const atten = computeFiberAttenuation(cfg.wavelength_nm, cfg.fiber_params);
    const alphaF = atten.total_db_per_km;
    const connectorLoss = Number(cfg.num_connectors) * Number(cfg.loss_per_connector_db);
    const splitterLoss = computeSplitterLoss(cfg);
    const nominalGain = Number(cfg.num_amplifiers) * Number(cfg.amp_gain_db);

    const [lMaxLinear, lMaxDist] = computeReachGivenGain(
      cfg, alphaF, connectorLoss, splitterLoss, nominalGain
    );

    let lSolved = lMaxLinear;
    if (cfg.num_amplifiers > 0 && (cfg.amp_sat_enabled || cfg.amp_min_in_enabled)) {
      const testCfg = deepClone(cfg);
      testCfg.fiber_length_km = lMaxLinear;
      if (!evaluateLinkBudget(testCfg).passed) {
        let lo = 0.0, hi = lMaxLinear;
        for (let i = 0; i < 50; i++) {
          const mid = 0.5 * (lo + hi);
          testCfg.fiber_length_km = mid;
          if (evaluateLinkBudget(testCfg).passed) lo = mid;
          else hi = mid;
        }
        lSolved = lo;
      }
    }

    const solvedCfg = deepClone(cfg);
    solvedCfg.fiber_length_km = lSolved;
    const verified = evaluateLinkBudget(solvedCfg);

    const nAmp = Math.trunc(cfg.num_amplifiers);
    const spanLen = lSolved > 0 ? lSolved / (nAmp + 1) : 0.0;
    const ampPos = [];
    for (let k = 1; k <= nAmp; k++) ampPos.push(spanLen * k);
    const feasible = lSolved > 0.0 && verified.passed;

    const summary =
      cfg.splice_mode === "reel" && lMaxDist !== null
        ? `Maximum feasible reach L_max = ${lSolved.toFixed(3)} km (distributed-splice estimate: ${lMaxDist.toFixed(3)} km) at ${cfg.wavelength_nm.toFixed(0)} nm (alpha = ${alphaF.toFixed(4)} dB/km, M_s = ${cfg.system_margin_db.toFixed(1)} dB).`
        : `Maximum feasible reach L_max = ${lSolved.toFixed(3)} km at ${cfg.wavelength_nm.toFixed(0)} nm (alpha = ${alphaF.toFixed(4)} dB/km, N_amp = ${nAmp}, M_s = ${cfg.system_margin_db.toFixed(1)} dB).`;

    return {
      mode: "max_reach",
      target_length_km: null,
      solved_max_reach_km: lSolved,
      solved_max_reach_distributed_km: lMaxDist,
      solved_num_amplifiers: nAmp,
      span_length_km: spanLen,
      span_loss_db: alphaF * spanLen,
      amplifier_positions_km: ampPos,
      feasible,
      summary,
      verified_result: verified,
    };
  }

  function solveRequiredAmplifiers(rawCfg, targetLengthKm = null, maxAmplifiers = 500) {
    const baseCfg = createLinkConfig(rawCfg);
    const LTarget = targetLengthKm === null ? Number(baseCfg.fiber_length_km) : Number(targetLengthKm);
    baseCfg.fiber_length_km = LTarget;
    validateConfig(baseCfg);

    const zeroCfg = deepClone(baseCfg);
    zeroCfg.num_amplifiers = 0;
    const resZero = evaluateLinkBudget(zeroCfg);
    const alphaF = resZero.attenuation.total_db_per_km;

    if (resZero.passed) {
      return {
        mode: "required_amplifiers",
        target_length_km: LTarget,
        solved_max_reach_km: resZero.max_reach_km,
        solved_max_reach_distributed_km: resZero.max_reach_distributed_km,
        solved_num_amplifiers: 0,
        span_length_km: LTarget,
        span_loss_db: alphaF * LTarget,
        amplifier_positions_km: [],
        feasible: true,
        summary: `No optical amplification required for L = ${LTarget.toFixed(2)} km (unamplified net margin = +${resZero.net_margin_db.toFixed(2)} dB).`,
        verified_result: resZero,
      };
    }

    if (baseCfg.amp_gain_db <= 0.0) {
      return {
        mode: "required_amplifiers",
        target_length_km: LTarget,
        solved_max_reach_km: resZero.max_reach_km,
        solved_max_reach_distributed_km: resZero.max_reach_distributed_km,
        solved_num_amplifiers: null,
        span_length_km: LTarget,
        span_loss_db: alphaF * LTarget,
        amplifier_positions_km: [],
        feasible: false,
        summary: "Infeasible: link requires amplification but amp_gain_db <= 0 dB.",
        verified_result: resZero,
      };
    }

    const deficitDb = Math.max(0.0, -resZero.net_margin_db);
    const nStart = Math.max(1, Math.ceil((deficitDb - 1e-12) / baseCfg.amp_gain_db));

    let verified = null;
    let solvedN = null;
    for (let nTry = nStart; nTry <= maxAmplifiers; nTry++) {
      const tryCfg = deepClone(baseCfg);
      tryCfg.num_amplifiers = nTry;
      const resTry = evaluateLinkBudget(tryCfg);
      verified = resTry;
      if (resTry.passed) {
        solvedN = nTry;
        break;
      }
    }

    if (solvedN === null || verified === null) {
      return {
        mode: "required_amplifiers",
        target_length_km: LTarget,
        solved_max_reach_km: resZero.max_reach_km,
        solved_max_reach_distributed_km: resZero.max_reach_distributed_km,
        solved_num_amplifiers: null,
        span_length_km: null,
        span_loss_db: null,
        amplifier_positions_km: [],
        feasible: false,
        summary: `Infeasible within ${maxAmplifiers} amplifiers (G_amp = ${baseCfg.amp_gain_db.toFixed(1)} dB) for target length ${LTarget.toFixed(2)} km.`,
        verified_result: verified || resZero,
      };
    }

    const spanLen = LTarget / (solvedN + 1);
    const spanLoss = alphaF * spanLen;
    const ampPositions = [];
    for (let k = 1; k <= solvedN; k++) ampPositions.push(spanLen * k);

    return {
      mode: "required_amplifiers",
      target_length_km: LTarget,
      solved_max_reach_km: verified.max_reach_km,
      solved_max_reach_distributed_km: verified.max_reach_distributed_km,
      solved_num_amplifiers: solvedN,
      span_length_km: spanLen,
      span_loss_db: spanLoss,
      amplifier_positions_km: ampPositions,
      feasible: true,
      summary: `Requires ${solvedN} in-line amplifier(s) (G_amp = ${baseCfg.amp_gain_db.toFixed(1)} dB each) for L = ${LTarget.toFixed(2)} km -> ${solvedN + 1} uniform spans of ${spanLen.toFixed(2)} km (${spanLoss.toFixed(2)} dB/span); verified net margin = +${verified.net_margin_db.toFixed(2)} dB.`,
      verified_result: verified,
    };
  }

  // ==========================================================================
  // 7. Multi-Wavelength Margin vs. Length Sweep
  // ==========================================================================
  function computeMarginVsLength(rawCfg, wavelengthsNm = [850.0, 1310.0, 1550.0], maxLengthKm = null, numPoints = 181, ignoreAlphaOverride = true) {
    const cfg = createLinkConfig(rawCfg);
    validateConfig(cfg);

    const baseFp = deepClone(cfg.fiber_params);
    if (ignoreAlphaOverride) baseFp.alpha_override_db_per_km = null;

    const perWlInfo = [];
    let maxReachSeen = 0.0;
    for (const wl of wavelengthsNm) {
      const wlCfg = deepClone(cfg);
      wlCfg.wavelength_nm = Number(wl);
      wlCfg.fiber_params = deepClone(baseFp);
      const sol = solveMaxReach(wlCfg);
      const atten = computeFiberAttenuation(Number(wl), baseFp);
      const lReach = sol.solved_max_reach_km || 0.0;
      if (lReach > maxReachSeen) maxReachSeen = lReach;
      perWlInfo.push([Number(wl), atten, lReach]);
    }

    const maxL = maxLengthKm === null
      ? Math.max(cfg.fiber_length_km * 1.25, maxReachSeen * 1.15, 10.0)
      : Number(maxLengthKm);

    const lengths = linspace(0.0, maxL, numPoints);
    const curves = [];

    for (const [wl, atten, lReach] of perWlInfo) {
      const wlCfg = deepClone(cfg);
      wlCfg.wavelength_nm = wl;
      wlCfg.fiber_params = deepClone(baseFp);

      const margins = [];
      const rxPowers = [];
      for (const LVal of lengths) {
        wlCfg.fiber_length_km = LVal;
        const res = evaluateLinkBudget(wlCfg);
        margins.push(res.net_margin_db);
        rxPowers.push(res.received_power_dbm);
      }

      curves.push({
        wavelength_nm: wl,
        alpha_db_per_km: atten.total_db_per_km,
        max_reach_km: lReach,
        net_margin_db: margins,
        received_power_dbm: rxPowers,
      });
    }

    return {
      lengths_km: lengths,
      max_length_km: maxL,
      system_margin_db: Number(cfg.system_margin_db),
      curves,
    };
  }

  // ==========================================================================
  // 8. Built-in Fiber & Link Presets (Identical to physics_engine.py)
  // ==========================================================================
  const FIBER_PRESETS = {
    smf28_conventional: createFiberParams({
      name: "Standard SMF-28 (ITU-T G.652.B)",
      rayleigh_coeff_cr: 0.85,
      oh_concentration_ppb: 15.0,
      waveguide_loss_db_per_km: 0.015,
      bend_radius_mm: 30.0,
      microbending_db_per_km: 0.0,
    }),
    smf28_dry: createFiberParams({
      name: "Dry Low-Water-Peak SMF (ITU-T G.652.D / AllWave)",
      rayleigh_coeff_cr: 0.82,
      oh_concentration_ppb: 0.5,
      waveguide_loss_db_per_km: 0.015,
      bend_radius_mm: 30.0,
      microbending_db_per_km: 0.0,
    }),
    mmf_grin_50: createFiberParams({
      name: "Graded-Index MMF 50/125 um (850 nm LAN)",
      rayleigh_coeff_cr: 1.15,
      oh_concentration_ppb: 20.0,
      waveguide_loss_db_per_km: 0.030,
      bend_radius_mm: 30.0,
      microbending_db_per_km: 0.02,
    }),
  };

  function agrawalTable51Fiber() {
    return createFiberParams({
      name: "Agrawal Table 5.1 Graded-Index Cable (3.5 dB/km)",
      rayleigh_coeff_cr: 1.15,
      oh_concentration_ppb: 20.0,
      waveguide_loss_db_per_km: 0.030,
      bend_radius_mm: 30.0,
      alpha_override_db_per_km: 3.5,
    });
  }

  const PRESETS = {
    agrawal_table5_1_laser: {
      label: "Agrawal 5e Table 5.1 \u2014 850 nm Laser + p-i-n",
      description:
        "Worked textbook example (Agrawal 5e, Sec. 5.2.3, Table 5.1, pp. 158\u2013159): 100 Mb/s, 8 km target, 0 dBm GaAs laser, -42 dBm p-i-n, 3.5 dB/km cable, 2 dB connectors, 6 dB margin -> C_L = 36 dB, L_max = 9.71 km (PASS).",
      config: createLinkConfig({
        wavelength_nm: 850.0,
        fiber_length_km: 8.0,
        tx_power_dbm: 0.0,
        rx_sensitivity_dbm: -42.0,
        system_margin_db: 6.0,
        num_connectors: 2,
        loss_per_connector_db: 1.0,
        splice_mode: "fixed",
        num_splices: 0,
        loss_per_splice_db: 0.0,
        splitter_mode: "ratio",
        split_ratio: 1,
        num_amplifiers: 0,
        amp_gain_db: 20.0,
        fiber_params: agrawalTable51Fiber(),
      }),
    },
    agrawal_table5_1_led: {
      label: "Agrawal 5e Table 5.1 \u2014 850 nm LED + p-i-n",
      description:
        "Worked textbook example (Agrawal 5e, Sec. 5.2.3, Table 5.1, pp. 158\u2013159): 100 Mb/s, 8 km target, -13 dBm LED (50 uW), -42 dBm p-i-n, 3.5 dB/km cable, 2 dB connectors, 6 dB margin -> C_L = 23 dB, L_max = 6.00 km (FAIL at 8 km).",
      config: createLinkConfig({
        wavelength_nm: 850.0,
        fiber_length_km: 8.0,
        tx_power_dbm: -13.0,
        rx_sensitivity_dbm: -42.0,
        system_margin_db: 6.0,
        num_connectors: 2,
        loss_per_connector_db: 1.0,
        splice_mode: "fixed",
        num_splices: 0,
        loss_per_splice_db: 0.0,
        splitter_mode: "ratio",
        split_ratio: 1,
        num_amplifiers: 0,
        amp_gain_db: 20.0,
        fiber_params: agrawalTable51Fiber(),
      }),
    },
    agrawal_table5_1_led_apd: {
      label: "Agrawal 5e Sec. 5.2.3 \u2014 850 nm LED + APD",
      description:
        "Worked textbook upgrade (Agrawal 5e, Sec. 5.2.3, pp. 158\u2013159): replacing p-i-n with an APD (+7 dB sensitivity -> -49 dBm) extends the LED link to L_max = 8.00 km (PASS).",
      config: createLinkConfig({
        wavelength_nm: 850.0,
        fiber_length_km: 8.0,
        tx_power_dbm: -13.0,
        rx_sensitivity_dbm: -49.0,
        system_margin_db: 6.0,
        num_connectors: 2,
        loss_per_connector_db: 1.0,
        splice_mode: "fixed",
        num_splices: 0,
        loss_per_splice_db: 0.0,
        splitter_mode: "ratio",
        split_ratio: 1,
        num_amplifiers: 0,
        amp_gain_db: 20.0,
        fiber_params: agrawalTable51Fiber(),
      }),
    },
    metro_1310_smf: {
      label: "Metro 1310 nm SMF-28 Link (40 km)",
      description:
        "Metropolitan 1310 nm single-mode link over 40 km of standard G.652.B SMF-28 (alpha ~ 0.34 dB/km), +2 dBm DFB laser, -24 dBm p-i-n receiver, 2 connectors, 8 fusion splices, 4 dB system margin.",
      config: createLinkConfig({
        wavelength_nm: 1310.0,
        fiber_length_km: 40.0,
        tx_power_dbm: 2.0,
        rx_sensitivity_dbm: -24.0,
        system_margin_db: 4.0,
        num_connectors: 2,
        loss_per_connector_db: 0.5,
        splice_mode: "fixed",
        num_splices: 8,
        loss_per_splice_db: 0.1,
        splitter_mode: "ratio",
        split_ratio: 1,
        num_amplifiers: 0,
        amp_gain_db: 20.0,
        fiber_params: deepClone(FIBER_PRESETS.smf28_conventional),
      }),
    },
    longhaul_1550_amplified: {
      label: "Long-Haul 1550 nm Amplified Link (400 km, 3 EDFAs)",
      description:
        "Periodically amplified 1550 nm SMF-28 trunk (Agrawal 5e, Sec. 7.1.2): 400 km total length, +2 dBm launch, -28 dBm receiver, 3 in-line EDFAs (20 dB gain each, 100 km uniform spans), 2 connectors, 20 splices, 4 dB margin.",
      config: createLinkConfig({
        wavelength_nm: 1550.0,
        fiber_length_km: 400.0,
        tx_power_dbm: 2.0,
        rx_sensitivity_dbm: -28.0,
        system_margin_db: 4.0,
        num_connectors: 2,
        loss_per_connector_db: 0.5,
        splice_mode: "fixed",
        num_splices: 20,
        loss_per_splice_db: 0.08,
        splitter_mode: "ratio",
        split_ratio: 1,
        num_amplifiers: 3,
        amp_gain_db: 20.0,
        amp_sat_enabled: true,
        amp_sat_out_dbm: 17.0,
        fiber_params: deepClone(FIBER_PRESETS.smf28_conventional),
      }),
    },
    ftth_gpon_1x32: {
      label: "FTTH GPON Access Link (1550 nm, 15 km, 1:32 Splitter)",
      description:
        "Passive Optical Network downstream link at 1550 nm over 15 km of SMF-28 with a 1:32 optical splitter (15.05 dB split + 0.8 dB excess loss), +3 dBm OLT transmitter, -27 dBm ONT receiver, 4 connectors, 4 splices, 3 dB margin.",
      config: createLinkConfig({
        wavelength_nm: 1550.0,
        fiber_length_km: 15.0,
        tx_power_dbm: 3.0,
        rx_sensitivity_dbm: -27.0,
        system_margin_db: 3.0,
        num_connectors: 4,
        loss_per_connector_db: 0.4,
        splice_mode: "fixed",
        num_splices: 4,
        loss_per_splice_db: 0.1,
        splitter_mode: "ratio",
        split_ratio: 32,
        splitter_excess_loss_db: 0.8,
        splitter_position_frac: 0.80,
        num_amplifiers: 0,
        amp_gain_db: 20.0,
        fiber_params: deepClone(FIBER_PRESETS.smf28_dry),
      }),
    },
  };

  function getPresetConfig(presetKey) {
    if (!(presetKey in PRESETS)) {
      throw new Error(`Unknown preset '${presetKey}'.`);
    }
    return deepClone(PRESETS[presetKey].config);
  }

  function listPresetsSerialized() {
    return Object.entries(PRESETS).map(([id, meta]) => ({
      id,
      label: meta.label,
      description: meta.description,
      config: deepClone(meta.config),
    }));
  }

  // ==========================================================================
  // 9. Automated Agrawal 5th Ed. Validation Suite (All 27 Checks)
  // ==========================================================================
  function relErrorPct(expected, computed) {
    if (Math.abs(expected) < 1e-12) {
      return Math.abs(computed - expected) * 100.0;
    }
    return (Math.abs(computed - expected) / Math.abs(expected)) * 100.0;
  }

  function runAllValidations(tolerancePct = 0.1) {
    const checks = [];

    function addNumeric(group, name, expected, computed, unit, note = "", tolPct = tolerancePct) {
      const errPct = relErrorPct(expected, computed);
      checks.push({
        group, name, expected, computed, unit,
        error_pct: errPct, tolerance_pct: tolPct,
        passed: errPct < tolPct, note,
      });
    }

    function addExact(group, name, expected, computed, note = "") {
      const passed = expected === computed;
      checks.push({
        group, name, expected, computed, unit: "exact",
        error_pct: passed ? 0.0 : 100.0, tolerance_pct: 0.0,
        passed, note,
      });
    }

    // Benchmark 1: Agrawal 5e Table 5.1 (pp. 158-159)
    const g1 = "Agrawal 5e Table 5.1 (pp. 158-159)";

    const cfgLaser = getPresetConfig("agrawal_table5_1_laser");
    const resLaser = evaluateLinkBudget(cfgLaser);
    const solLaser = solveMaxReach(cfgLaser);
    addNumeric(g1, "Laser+PIN: Available C_L", 36.0, resLaser.available_channel_loss_db, "dB");
    addNumeric(g1, "Laser+PIN: Max Reach L_max (exact 34/3.5)", 34.0 / 3.5, solLaser.solved_max_reach_km || 0.0, "km");
    addNumeric(g1, "Laser+PIN: P_rx at L=8 km", -30.0, resLaser.received_power_dbm, "dBm");
    addNumeric(g1, "Laser+PIN: Net Margin at L=8 km", 6.0, resLaser.net_margin_db, "dB");
    addExact(g1, "Laser+PIN: Pass/Fail at L=8 km", "PASS", resLaser.status_label);

    const cfgLed = getPresetConfig("agrawal_table5_1_led");
    const resLed = evaluateLinkBudget(cfgLed);
    const solLed = solveMaxReach(cfgLed);
    addNumeric(g1, "LED+PIN: Available C_L", 23.0, resLed.available_channel_loss_db, "dB");
    addNumeric(g1, "LED+PIN: Max Reach L_max", 6.0, solLed.solved_max_reach_km || 0.0, "km");
    addNumeric(g1, "LED+PIN: P_rx at L=8 km", -43.0, resLed.received_power_dbm, "dBm");
    addNumeric(g1, "LED+PIN: Net Margin at L=8 km", -7.0, resLed.net_margin_db, "dB");
    addExact(g1, "LED+PIN: Pass/Fail at L=8 km", "FAIL", resLed.status_label);

    const cfgApd = getPresetConfig("agrawal_table5_1_led_apd");
    const resApd = evaluateLinkBudget(cfgApd);
    const solApd = solveMaxReach(cfgApd);
    addNumeric(g1, "LED+APD: Available C_L", 30.0, resApd.available_channel_loss_db, "dB");
    addNumeric(g1, "LED+APD: Max Reach L_max", 8.0, solApd.solved_max_reach_km || 0.0, "km");
    addNumeric(g1, "LED+APD: P_rx at L=8 km", -43.0, resApd.received_power_dbm, "dBm");
    addNumeric(g1, "LED+APD: Net Margin at L=8 km", 0.0, resApd.net_margin_db, "dB");
    addExact(g1, "LED+APD: Pass/Fail at L=8 km", "PASS", resApd.status_label);

    const pRecPhoton = receiverSensitivityFromPhotons(2500.0, 100e6, 850.0);
    const expPRecPhoton = 10.0 * Math.log10((2500.0 * PLANCK_H * SPEED_OF_LIGHT / 0.85e-6) * 100e6 / 1e-3);
    addNumeric(g1, "Photon Sensitivity (2500 ph/bit, 100 Mb/s)", expPRecPhoton, pRecPhoton, "dBm");

    // Benchmark 2: Problem 5.4 (pp. 179-180)
    const g2 = "Agrawal 5e Problem 5.4 (pp. 179-180)";
    const cfgP54 = createLinkConfig({
      wavelength_nm: 1300.0,
      fiber_length_km: 20.0,
      tx_power_dbm: mwToDbm(0.1),
      rx_sensitivity_dbm: mwToDbm(100e-6),
      system_margin_db: 6.0,
      num_connectors: 2,
      loss_per_connector_db: 1.0,
      splice_mode: "reel",
      reel_length_km: 2.0,
      loss_per_splice_db: 0.2,
      splitter_mode: "ratio",
      split_ratio: 1,
      num_amplifiers: 0,
      fiber_params: createFiberParams({ name: "Problem 5.4 Cable", alpha_override_db_per_km: 1.0 }),
    });
    const resP54 = evaluateLinkBudget(cfgP54);
    const solP54 = solveMaxReach(cfgP54);
    addNumeric(g2, "Available C_L", 24.0, resP54.available_channel_loss_db, "dB");
    addNumeric(g2, "Max Reach L_max (distributed 1.1 dB/km)", 20.0, solP54.solved_max_reach_distributed_km || 0.0, "km");
    addNumeric(g2, "Max Reach L_max (discrete 2-km reels)", 20.0, solP54.solved_max_reach_km || 0.0, "km");

    // Benchmark 3: Eq. (2.5.4) & Sec. 2.5.4 (p. 48)
    const g3 = "Agrawal 5e Eq. (2.5.4) & Sec. 2.5.4 (p. 48)";
    const attCr07 = computeFiberAttenuation(1550.0, createFiberParams({ rayleigh_coeff_cr: 0.7 }));
    const attCr09 = computeFiberAttenuation(1550.0, createFiberParams({ rayleigh_coeff_cr: 0.9 }));
    addNumeric(g3, "Rayleigh alpha_R at 1550 nm (C_R=0.7)", 0.7 / Math.pow(1.55, 4), attCr07.rayleigh_db_per_km, "dB/km");
    addNumeric(g3, "Rayleigh alpha_R at 1550 nm (C_R=0.9)", 0.9 / Math.pow(1.55, 4), attCr09.rayleigh_db_per_km, "dB/km");
    addExact(g3, "Macrobending negligible (<0.01 dB/km) at R=30 mm", true, attCr07.macrobending_db_per_km < 0.01);

    // Benchmark 4: Sec. 7.1.2 (p. 237)
    const g4 = "Agrawal 5e Sec. 7.1.2 (p. 237)";
    const cfgAmp = createLinkConfig({
      wavelength_nm: 1550.0,
      fiber_length_km: 400.0,
      tx_power_dbm: 0.0,
      rx_sensitivity_dbm: -28.0,
      system_margin_db: 4.0,
      num_connectors: 2,
      loss_per_connector_db: 1.0,
      splice_mode: "fixed",
      num_splices: 0,
      loss_per_splice_db: 0.0,
      splitter_mode: "ratio",
      split_ratio: 1,
      num_amplifiers: 0,
      amp_gain_db: 20.0,
      amp_sat_enabled: false,
      fiber_params: createFiberParams({ name: "Sec. 7.1.2 1550 nm Fiber", alpha_override_db_per_km: 0.2 }),
    });
    const solAmp = solveRequiredAmplifiers(cfgAmp, 400.0);
    addExact(g4, "Design Mode: Required Amplifiers N_amp", 3, solAmp.solved_num_amplifiers);
    addNumeric(g4, "Uniform Span Length L_span", 100.0, solAmp.span_length_km || 0.0, "km");
    addNumeric(g4, "Per-Span Loss G_A = alpha_f * L_span", 20.0, solAmp.span_loss_db || 0.0, "dB");
    addNumeric(g4, "Verified Received Power P_rx (with 3 amps)", -22.0, solAmp.verified_result.received_power_dbm, "dBm");
    const lastPt = solAmp.verified_result.power_profile[solAmp.verified_result.power_profile.length - 1];
    addNumeric(g4, "Spatial Trace Endpoint vs. Budget P_rx", solAmp.verified_result.received_power_dbm, lastPt.power_dbm, "dBm");

    const passedCount = checks.filter((c) => c.passed).length;
    return {
      all_passed: passedCount === checks.length,
      passed_count: passedCount,
      total_count: checks.length,
      tolerance_pct: tolerancePct,
      checks,
    };
  }

  // ==========================================================================
  // 10. Local API Router (Drop-In Replacement for app.py /api/* Endpoints)
  // ==========================================================================
  function handleApi(url, options = {}) {
    const path = String(url).split("?")[0];
    const body = options && options.body ? JSON.parse(options.body) : {};

    if (path === "/api/presets") {
      return {
        presets: listPresetsSerialized(),
        fiber_presets: deepClone(FIBER_PRESETS),
      };
    }

    if (path === "/api/validate") {
      return runAllValidations(0.1);
    }

    if (path === "/api/analyze") {
      const cfg = createLinkConfig(body.config || body);
      validateConfig(cfg);
      const budget = evaluateLinkBudget(cfg);
      const spectrum = computeAttenuationSpectrum(null, cfg.fiber_params);
      const margin_sweep = computeMarginVsLength(cfg, [850.0, 1310.0, 1550.0], null, 181, true);
      return { config: cfg, budget, spectrum, margin_sweep };
    }

    if (path === "/api/design") {
      const mode = String(body.mode || "max_reach").trim().toLowerCase();
      if (!body.config || typeof body.config !== "object") {
        throw new Error("Design request must include a 'config' object.");
      }
      const cfg = createLinkConfig(body.config);
      validateConfig(cfg);

      let solution;
      const solvedCfg = deepClone(cfg);
      if (mode === "max_reach") {
        solution = solveMaxReach(cfg);
        solvedCfg.fiber_length_km = solution.solved_max_reach_km || 0.0;
      } else if (mode === "required_amplifiers") {
        const targetLen = Number(body.target_length_km !== undefined ? body.target_length_km : cfg.fiber_length_km);
        if (!Number.isFinite(targetLen) || targetLen < 0.0) {
          throw new Error("target_length_km cannot be negative.");
        }
        solution = solveRequiredAmplifiers(cfg, targetLen);
        solvedCfg.fiber_length_km = targetLen;
        if (solution.solved_num_amplifiers !== null) {
          solvedCfg.num_amplifiers = solution.solved_num_amplifiers;
        }
      } else {
        throw new Error("Design mode must be 'max_reach' or 'required_amplifiers'.");
      }

      const spectrum = computeAttenuationSpectrum(null, solvedCfg.fiber_params);
      const margin_sweep = computeMarginVsLength(solvedCfg, [850.0, 1310.0, 1550.0], null, 181, true);
      return { mode, solution, solved_config: solvedCfg, spectrum, margin_sweep };
    }

    throw new Error(`Unknown API endpoint: ${path}`);
  }

  const OpticalEngine = {
    dbmToMw,
    mwToDbm,
    linearToDb,
    dbToLinear,
    alphaDbToLinear,
    alphaLinearToDb,
    receiverSensitivityFromPhotons,
    createFiberParams,
    createLinkConfig,
    computeFiberAttenuation,
    computeAttenuationSpectrum,
    computeSplitterLoss,
    computeSplicePositions,
    evaluateLinkBudget,
    solveMaxReach,
    solveRequiredAmplifiers,
    computeMarginVsLength,
    FIBER_PRESETS,
    PRESETS,
    getPresetConfig,
    listPresetsSerialized,
    runAllValidations,
    handleApi,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = OpticalEngine;
  }
  if (globalScope) {
    globalScope.OpticalEngine = OpticalEngine;
  }
})(typeof window !== "undefined" ? window : globalThis);
