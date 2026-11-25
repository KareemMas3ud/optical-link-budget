/* ============================================================================
   app.js — Optical Link Power Budget Analyzer Frontend
   Zero external JS/chart CDN dependencies. Communicates with app.py /api/* JSON
   endpoints and renders crisp native SVG optical engineering plots.
   ============================================================================ */

(() => {
  "use strict";

  // Calibrated optical-window palette (taste-skill compliant: zero violet/lavender)
  const COLORS = {
    ink: "#0F172A",
    secondary: "#475569",
    muted: "#64748B",
    grid: "#E2E8F0",
    wl850: "#C2410C",
    wl1310: "#1D4ED8",
    wl1550: "#0F766E",
    pass: "#15803D",
    fail: "#B91C1C",
    warn: "#B45309",
    amp: "#15803D",
    splitter: "#2563EB",     // Deep optical blue (replaces violet per taste-skill)
    overload: "#BE123C",     // Rose crimson (replaces violet per taste-skill)
    connector: "#0284C7",
    splice: "#D97706",
    rayleigh: "#1D4ED8",
    absorption: "#0891B2",
    ir: "#D97706",
    wg: "#64748B",
    bend: "#EA580C",
    margin: "#475569",
  };

  const state = {
    uiMode: "analysis",          // "analysis" | "design"
    designMode: "max_reach",     // "max_reach" | "required_amplifiers"
    spliceMode: "fixed",         // "fixed" | "reel"
    splitterMode: "ratio",       // "ratio" | "manual"
    activeViewTab: "loss",       // "loss" | "margin" | "spectrum" | "ledger"
    presets: [],
    fiberPresets: {},
    lastResponse: null,
    lastDesign: null,
    debounceTimer: null,
    toastTimer: null,
    toastHovered: false,
  };

  const $ = (id) => document.getElementById(id);

  function wlAccent(wlNm) {
    if (wlNm < 1050) return COLORS.wl850;
    if (wlNm < 1430) return COLORS.wl1310;
    return COLORS.wl1550;
  }

  /**
   * Floor a reach value cleanly to 2 decimal places so the input never overflows
   * with floating-point tails (e.g., 388.3672936 -> 388.36) while strictly
   * guaranteeing M_net >= 0 dB (PASS). Adds 1e-9 guard so exact values like
   * 6.000000 stay 6.00 rather than 5.99.
   */
  function floorTo2Decimals(val) {
    if (!Number.isFinite(val) || val <= 0) return 0;
    return Math.floor((val + 1e-9) * 100) / 100;
  }

  function fmtPowerLinear(mw) {
    if (mw >= 1.0) return `${mw.toFixed(3)} mW`;
    if (mw >= 1e-3) return `${(mw * 1e3).toFixed(2)} \u00b5W`;
    if (mw >= 1e-6) return `${(mw * 1e6).toFixed(2)} nW`;
    return `${mw.toExponential(2)} mW`;
  }

  function fmtSigned(val, digits = 2) {
    return `${val >= 0 ? "+" : ""}${val.toFixed(digits)}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showNotification(title, detail = "", durationMs = 5200, accentColor = COLORS.pass) {
    const el = $("toast");
    $("toast-title").textContent = title;
    const detailEl = $("toast-detail");
    detailEl.textContent = detail;
    detailEl.hidden = !detail;
    $("toast-accent").style.background = accentColor;
    el.hidden = false;

    clearTimeout(state.toastTimer);
    if (durationMs > 0) {
      state.toastTimer = setTimeout(() => {
        if (!state.toastHovered) el.hidden = true;
      }, durationMs);
    }
  }

  function pulseInputWrapper(wrapperId) {
    const wrap = $(wrapperId);
    if (!wrap) return;
    wrap.classList.remove("input-updated");
    void wrap.offsetWidth;
    wrap.classList.add("input-updated");
  }

  function showError(msg) {
    const el = $("error-banner");
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  // ==========================================================================
  // 1. Read, Populate & Synchronize LinkConfig Form Controls
  // ==========================================================================
  function updateDrawerBadges() {
    const hasOverride = $("alpha-override-enabled").checked;
    const fiberDrawerBadge = $("drawer-fiber-badge");
    const overrideChip = $("override-badge");

    if (hasOverride) {
      const ovVal = parseFloat($("alpha-override-val").value);
      const label = Number.isFinite(ovVal) ? `Override ${ovVal.toFixed(2)} dB/km` : "Override";
      fiberDrawerBadge.textContent = label;
      fiberDrawerBadge.hidden = false;
      overrideChip.textContent = label;
      overrideChip.hidden = false;
    } else {
      const customActive = $("fiber-preset").value === "custom";
      fiberDrawerBadge.textContent = "Custom";
      fiberDrawerBadge.hidden = !customActive;
      overrideChip.hidden = true;
    }

    const hwFlags = [];
    if ($("rx-overload-enabled").checked) hwFlags.push("Overload");
    if (state.spliceMode === "reel") hwFlags.push("Reel");
    if (state.splitterMode === "manual") hwFlags.push("Manual split");
    if ($("amp-sat-enabled").checked && (parseInt($("num-amps").value, 10) || 0) > 0) hwFlags.push("P_sat");

    const hwBadge = $("drawer-hw-badge");
    if (hwFlags.length > 0) {
      hwBadge.textContent = hwFlags.join(", ");
      hwBadge.hidden = false;
    } else {
      hwBadge.hidden = true;
    }
  }

  function readConfigFromUI() {
    const overrideEnabled = $("alpha-override-enabled").checked;
    const fpKey = $("fiber-preset").value;
    const baseFp = state.fiberPresets[fpKey] || {};
    return {
      wavelength_nm: parseFloat($("wavelength-nm").value),
      fiber_length_km: parseFloat($("fiber-length").value),
      tx_power_dbm: parseFloat($("tx-power").value),
      rx_sensitivity_dbm: parseFloat($("rx-sens").value),
      rx_overload_enabled: $("rx-overload-enabled").checked,
      rx_overload_dbm: parseFloat($("rx-overload-val").value),
      system_margin_db: parseFloat($("sys-margin").value),
      num_connectors: parseInt($("num-connectors").value, 10) || 0,
      loss_per_connector_db: parseFloat($("loss-connector").value),
      splice_mode: state.spliceMode,
      num_splices: parseInt($("num-splices").value, 10) || 0,
      reel_length_km: parseFloat($("reel-length").value),
      loss_per_splice_db: parseFloat($("loss-splice").value),
      splitter_mode: state.splitterMode,
      split_ratio: parseInt($("split-ratio").value, 10) || 1,
      splitter_excess_loss_db: parseFloat($("splitter-excess").value),
      manual_splitter_loss_db: parseFloat($("splitter-manual-db").value),
      splitter_position_frac: Math.min(0.95, Math.max(0.05, (parseFloat($("splitter-pos-pct").value) || 80) / 100)),
      num_amplifiers: parseInt($("num-amps").value, 10) || 0,
      amp_gain_db: parseFloat($("amp-gain").value),
      amp_sat_enabled: $("amp-sat-enabled").checked,
      amp_sat_out_dbm: parseFloat($("amp-sat-out").value),
      fiber_params: {
        name: baseFp.name || "Custom Silica Fiber",
        rayleigh_coeff_cr: parseFloat($("fp-cr").value),
        uv_a: baseFp.uv_a ?? 1.1e-3,
        uv_lambda_um: baseFp.uv_lambda_um ?? 4.63,
        ir_a: baseFp.ir_a ?? 7.81e11,
        ir_lambda_um: baseFp.ir_lambda_um ?? 48.48,
        oh_concentration_ppb: parseFloat($("fp-oh").value),
        waveguide_loss_db_per_km: parseFloat($("fp-wg").value),
        bend_radius_mm: parseFloat($("fp-bend-r").value),
        bend_rc0_mm: baseFp.bend_rc0_mm ?? 0.35,
        bend_prefactor_db_per_km: baseFp.bend_prefactor_db_per_km ?? 100.0,
        microbending_db_per_km: parseFloat($("fp-micro").value),
        alpha_override_db_per_km: overrideEnabled ? parseFloat($("alpha-override-val").value) : null,
      },
    };
  }

  function writeConfigToUI(cfg, options = {}) {
    const autoManageDrawers = options.autoManageDrawers !== false;

    $("wavelength-nm").value = cfg.wavelength_nm;
    syncWavelengthPills(cfg.wavelength_nm);

    // Format length cleanly (max 2 decimal places, stripping redundant trailing zeros on integers)
    const cleanLen = Number(Number(cfg.fiber_length_km).toFixed(2));
    $("fiber-length").value = cleanLen;
    $("design-target-length").value = cleanLen;
    $("tx-power").value = cfg.tx_power_dbm;
    $("rx-sens").value = cfg.rx_sensitivity_dbm;
    $("sys-margin").value = cfg.system_margin_db;

    const ovOn = Boolean(cfg.rx_overload_enabled);
    $("rx-overload-enabled").checked = ovOn;
    $("rx-overload-val").value = cfg.rx_overload_dbm ?? -3.0;
    $("rx-overload-wrap").hidden = !ovOn;

    $("num-connectors").value = cfg.num_connectors;
    $("loss-connector").value = cfg.loss_per_connector_db;

    setSpliceMode(cfg.splice_mode || "fixed", false);
    $("num-splices").value = cfg.num_splices;
    $("reel-length").value = cfg.reel_length_km ?? 2.0;
    $("reel-length-mirror").value = `${cfg.reel_length_km ?? 2.0} km`;
    $("loss-splice").value = cfg.loss_per_splice_db;

    setSplitterMode(cfg.splitter_mode || "ratio", false);
    $("split-ratio").value = String(cfg.split_ratio || 1);
    $("splitter-excess").value = cfg.splitter_excess_loss_db ?? 0.5;
    $("splitter-manual-db").value = cfg.manual_splitter_loss_db ?? 0.0;
    $("splitter-pos-pct").value = Math.round((cfg.splitter_position_frac ?? 0.8) * 100);

    $("num-amps").value = cfg.num_amplifiers;
    $("amp-gain").value = cfg.amp_gain_db;
    $("amp-sat-enabled").checked = Boolean(cfg.amp_sat_enabled);
    $("amp-sat-out").value = cfg.amp_sat_out_dbm ?? 17.0;
    $("amp-sat-wrap").hidden = !cfg.amp_sat_enabled;

    const fp = cfg.fiber_params || {};
    $("fp-cr").value = fp.rayleigh_coeff_cr ?? 0.85;
    $("fp-oh").value = fp.oh_concentration_ppb ?? 15.0;
    $("fp-bend-r").value = fp.bend_radius_mm ?? 30.0;
    $("fp-micro").value = fp.microbending_db_per_km ?? 0.0;
    $("fp-wg").value = fp.waveguide_loss_db_per_km ?? 0.015;

    const hasOverride = fp.alpha_override_db_per_km !== null && fp.alpha_override_db_per_km !== undefined;
    $("alpha-override-enabled").checked = hasOverride;
    $("alpha-override-wrap").hidden = !hasOverride;
    if (hasOverride) {
      $("alpha-override-val").value = fp.alpha_override_db_per_km;
    }

    let matchedKey = "custom";
    for (const [k, f] of Object.entries(state.fiberPresets)) {
      if (
        Math.abs((fp.rayleigh_coeff_cr ?? 0) - f.rayleigh_coeff_cr) < 1e-6 &&
        Math.abs((fp.oh_concentration_ppb ?? 0) - f.oh_concentration_ppb) < 1e-6 &&
        Math.abs((fp.waveguide_loss_db_per_km ?? 0) - f.waveguide_loss_db_per_km) < 1e-6
      ) {
        matchedKey = k;
        break;
      }
    }
    $("fiber-preset").value = matchedKey;

    if (autoManageDrawers) {
      $("drawer-fiber-physics").open = hasOverride || matchedKey === "custom";
      $("drawer-hardware-limits").open = false;
    }
    updateDrawerBadges();
  }

  function syncWavelengthPills(wlNm) {
    document.querySelectorAll(".wl-btn").forEach((btn) => {
      const val = parseFloat(btn.dataset.wl);
      btn.classList.toggle("active", Math.abs(val - wlNm) < 1.0);
    });
    document.documentElement.style.setProperty("--accent-active", wlAccent(wlNm));
  }

  function setSpliceMode(mode, trigger = true) {
    state.spliceMode = mode;
    document.querySelectorAll("[data-splice-mode]").forEach((btn) => {
      const on = btn.dataset.spliceMode === mode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-checked", String(on));
    });
    const isReel = mode === "reel";
    $("splice-fixed-wrap").hidden = isReel;
    $("splice-reel-core-note").hidden = !isReel;
    $("splice-reel-wrap").hidden = !isReel;
    updateDrawerBadges();
    if (trigger) scheduleAnalyze();
  }

  function setSplitterMode(mode, trigger = true) {
    state.splitterMode = mode;
    document.querySelectorAll("[data-splitter-mode]").forEach((btn) => {
      const on = btn.dataset.splitterMode === mode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-checked", String(on));
    });
    const isManual = mode === "manual";
    $("splitter-excess-wrap").hidden = isManual;
    $("splitter-manual-wrap").hidden = !isManual;
    $("split-ratio").disabled = isManual;
    updateDrawerBadges();
    if (trigger) scheduleAnalyze();
  }

  function hideDesignResultBanner() {
    $("design-result-bar").hidden = true;
    state.lastDesign = null;
  }

  function setUiMode(mode, runNow = true) {
    state.uiMode = mode;
    const isDesign = mode === "design";
    $("tab-analysis").classList.toggle("active", !isDesign);
    $("tab-analysis").setAttribute("aria-selected", String(!isDesign));
    $("tab-design").classList.toggle("active", isDesign);
    $("tab-design").setAttribute("aria-selected", String(isDesign));
    $("design-controls").hidden = !isDesign;

    if (isDesign) {
      $("verdict-quickfix").hidden = true;
    } else {
      hideDesignResultBanner();
      if (runNow) scheduleAnalyze(0);
    }
  }

  function setDesignMode(dMode) {
    state.designMode = dMode;
    document.querySelectorAll("[data-design-mode]").forEach((btn) => {
      const on = btn.dataset.designMode === dMode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-checked", String(on));
    });
    const isAmp = dMode === "required_amplifiers";
    $("design-target-length-wrap").hidden = !isAmp;
    $("btn-run-design").textContent = isAmp ? "Solve required amplifiers" : "Solve max reach";
  }

  function setActiveViewTab(tabId) {
    state.activeViewTab = tabId;
    document.querySelectorAll(".view-tab").forEach((btn) => {
      const on = btn.dataset.viewTab === tabId;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    ["loss", "margin", "spectrum", "ledger"].forEach((id) => {
      const pane = $(`pane-${id}`);
      const on = id === tabId;
      pane.hidden = !on;
      pane.classList.toggle("active", on);
    });
  }

  // ==========================================================================
  // 2. Local Python API Calls & Quick-Fix / Design Mode Actions
  // ==========================================================================
  async function apiFetch(url, options = {}) {
    if (!window.OpticalEngine || typeof window.OpticalEngine.handleApi !== "function") {
      throw new Error("Client-side OpticalEngine failed to load.");
    }
    return window.OpticalEngine.handleApi(url, options);
  }

  function scheduleAnalyze(delayMs = 110) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(runAnalyze, delayMs);
  }

  async function runAnalyze() {
    try {
      const cfg = readConfigFromUI();
      const data = await apiFetch("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ config: cfg }),
      });
      state.lastResponse = data;
      showError("");
      renderAll(data.budget, data.spectrum, data.margin_sweep, data.config);
      return data;
    } catch (err) {
      showError(err.message);
      return null;
    }
  }

  async function runDesignSolver() {
    try {
      const cfg = readConfigFromUI();
      const targetLen = parseFloat($("design-target-length").value);
      const data = await apiFetch("/api/design", {
        method: "POST",
        body: JSON.stringify({
          mode: state.designMode,
          target_length_km: targetLen,
          config: cfg,
        }),
      });
      state.lastDesign = data;
      showError("");
      renderDesignSolution(data.solution);
      renderAll(data.solution.verified_result, data.spectrum, data.margin_sweep, data.solved_config);
    } catch (err) {
      showError(err.message);
    }
  }

  /**
   * Apply solved Design Mode result cleanly (rounded to 2 decimal places for length),
   * switch to Analysis Mode, re-analyze to confirm exact margin, pulse changed input(s),
   * and display explicit before -> after toast confirmation.
   */
  async function applyDesignSolution() {
    if (!state.lastDesign || !state.lastDesign.solved_config) return;
    const sol = state.lastDesign.solution;
    const solvedCfg = { ...state.lastDesign.solved_config };

    const prevLen = parseFloat($("fiber-length").value);
    const prevAmps = parseInt($("num-amps").value, 10) || 0;

    if (sol.mode === "max_reach") {
      solvedCfg.fiber_length_km = floorTo2Decimals(solvedCfg.fiber_length_km);
    } else {
      solvedCfg.fiber_length_km = Number(Number(solvedCfg.fiber_length_km).toFixed(2));
    }

    writeConfigToUI(solvedCfg, { autoManageDrawers: false });
    hideDesignResultBanner();
    setUiMode("analysis", false);

    const fresh = await runAnalyze();
    const b = fresh ? fresh.budget : sol.verified_result;

    if (sol.mode === "max_reach") {
      pulseInputWrapper("wrap-fiber-length");
      showNotification(
        "Max reach applied to link",
        `Fiber Length L updated: ${prevLen.toFixed(2)} km \u2192 ${solvedCfg.fiber_length_km.toFixed(2)} km (Net Margin: ${fmtSigned(b.net_margin_db, 2)} dB, ${b.status_label})`,
        5500,
        b.passed ? COLORS.pass : COLORS.warn
      );
    } else {
      pulseInputWrapper("wrap-num-amps");
      if (Math.abs(solvedCfg.fiber_length_km - prevLen) > 1e-6) {
        pulseInputWrapper("wrap-fiber-length");
      }
      const newAmps = solvedCfg.num_amplifiers;
      const spans = newAmps + 1;
      const spanLen = solvedCfg.fiber_length_km / spans;
      showNotification(
        "Amplifier design applied to link",
        `In-Line Amplifiers updated: ${prevAmps} \u2192 ${newAmps} (${spans} span${spans > 1 ? "s" : ""} \u00d7 ${spanLen.toFixed(2)} km, Net Margin: ${fmtSigned(b.net_margin_db, 2)} dB, ${b.status_label})`,
        5500,
        b.passed ? COLORS.pass : COLORS.warn
      );
    }
  }

  /**
   * Analysis-Mode Quick-Fix 1: Apply Max Reach (L_max) directly from the FAIL banner.
   * Uses /api/design (max_reach) so saturation/reel spacing are respected, then floors
   * cleanly to 2 decimal places so M_net >= 0 dB (PASS) is strictly guaranteed.
   */
  async function quickFixApplyMaxReach() {
    try {
      const cfg = readConfigFromUI();
      const prevLen = cfg.fiber_length_km;
      const data = await apiFetch("/api/design", {
        method: "POST",
        body: JSON.stringify({ mode: "max_reach", config: cfg }),
      });
      const rawReach = data.solution.solved_max_reach_km ?? 0;
      const safeReach = floorTo2Decimals(rawReach);

      if (safeReach <= 0) {
        showNotification(
          "Cannot resolve by shortening fiber",
          "Fixed component losses exceed available power budget even at L = 0.00 km. Reduce splitter/connector loss or add amplification.",
          5500,
          COLORS.fail
        );
        return;
      }

      $("fiber-length").value = safeReach.toFixed(2);
      $("design-target-length").value = safeReach.toFixed(2);
      pulseInputWrapper("wrap-fiber-length");

      const fresh = await runAnalyze();
      if (fresh) {
        const b = fresh.budget;
        showNotification(
          "Max reach applied to link",
          `Fiber Length L updated: ${prevLen.toFixed(2)} km \u2192 ${safeReach.toFixed(2)} km (Net Margin: ${fmtSigned(b.net_margin_db, 2)} dB, ${b.status_label})`,
          5500,
          b.passed ? COLORS.pass : COLORS.warn
        );
      }
    } catch (err) {
      showError(err.message);
    }
  }

  /**
   * Analysis-Mode Quick-Fix 2: Auto-Add Amplifiers directly from the FAIL banner.
   * Calls /api/design (required_amplifiers) for the active fiber_length_km, updates
   * num_amplifiers, re-runs /api/analyze, pulses the field, and confirms before -> after.
   */
  async function quickFixAutoAddAmplifiers() {
    try {
      const cfg = readConfigFromUI();
      const prevAmps = cfg.num_amplifiers;
      const data = await apiFetch("/api/design", {
        method: "POST",
        body: JSON.stringify({
          mode: "required_amplifiers",
          target_length_km: cfg.fiber_length_km,
          config: cfg,
        }),
      });
      const sol = data.solution;
      if (!sol.feasible || sol.solved_num_amplifiers === null) {
        showNotification(
          "Amplifier auto-fix infeasible",
          sol.summary || "Ensure amplifier gain G_amp > 0 dB.",
          5500,
          COLORS.fail
        );
        return;
      }

      const newAmps = sol.solved_num_amplifiers;
      $("num-amps").value = newAmps;
      updateDrawerBadges();
      pulseInputWrapper("wrap-num-amps");

      const fresh = await runAnalyze();
      if (fresh) {
        const b = fresh.budget;
        const spans = newAmps + 1;
        const spanLen = cfg.fiber_length_km / spans;
        showNotification(
          "In-line amplifiers updated",
          `In-Line Amplifiers updated: ${prevAmps} \u2192 ${newAmps} (${spans} span${spans > 1 ? "s" : ""} \u00d7 ${spanLen.toFixed(2)} km, Net Margin: ${fmtSigned(b.net_margin_db, 2)} dB, ${b.status_label})`,
          5500,
          b.passed ? COLORS.pass : COLORS.warn
        );
      }
    } catch (err) {
      showError(err.message);
    }
  }

  // ==========================================================================
  // 3. Telemetry, Design Bar & Ledger Rendering
  // ==========================================================================
  function renderAll(budget, spectrum, marginSweep, cfg) {
    renderTelemetry(budget, cfg);
    renderPowerLevelChart(budget, cfg);
    renderLossBreakdownChart(budget, cfg);
    renderMarginVsLengthChart(marginSweep, budget);
    renderSpectrumChart(spectrum, budget);
    renderLedgerTable(budget, cfg);
  }

  function renderTelemetry(b, cfg) {
    const block = $("verdict-block");
    block.classList.toggle("verdict-pass", b.passed);
    block.classList.toggle("verdict-fail", !b.passed);
    $("verdict-pill").textContent = b.status_label;
    $("verdict-headline").textContent = b.diagnostic_message;

    const warnEl = $("verdict-warnings");
    if (b.warnings && b.warnings.length > 0) {
      warnEl.hidden = false;
      warnEl.textContent = "Note: " + b.warnings.join(" | ");
    } else {
      warnEl.hidden = true;
      warnEl.textContent = "";
    }

    // Show contextual Quick-Fix buttons ONLY in Analysis Mode when link FAILS due to power deficit
    const showQuickFix = state.uiMode === "analysis" && !b.passed && b.net_margin_db < -1e-9;
    const qfEl = $("verdict-quickfix");
    qfEl.hidden = !showQuickFix;
    if (showQuickFix) {
      const safeL = floorTo2Decimals(b.max_reach_km);
      const reachBtn = $("btn-quick-max-reach");
      reachBtn.disabled = safeL <= 0;
      reachBtn.innerHTML = safeL > 0
        ? `Apply Max Reach (${safeL.toFixed(2)} km)`
        : `Apply Max Reach (L<sub>max</sub>)`;
      $("btn-quick-add-amps").disabled = !(cfg.amp_gain_db > 0);
    }

    $("kpi-prx").textContent = `${fmtSigned(b.received_power_dbm, 2)} dBm`;
    $("kpi-prx-mw").textContent = `${fmtPowerLinear(b.received_power_mw)} (thresh ${b.design_threshold_dbm.toFixed(1)} dBm)`;

    const mnetEl = $("kpi-mnet");
    mnetEl.textContent = `${fmtSigned(b.net_margin_db, 2)} dB`;
    mnetEl.classList.toggle("val-pass", b.net_margin_db >= -1e-9);
    mnetEl.classList.toggle("val-fail", b.net_margin_db < -1e-9);
    $("kpi-mgross").textContent = `Gross ${fmtSigned(b.gross_margin_db, 2)} dB (M_s ${b.system_margin_db.toFixed(1)} dB)`;

    $("kpi-cl").textContent = `${b.total_passive_loss_db.toFixed(2)} dB`;
    $("kpi-gain").textContent = b.effective_amp_gain_db > 0
      ? `Gain +${b.effective_amp_gain_db.toFixed(2)} dB (net ${b.net_loss_db.toFixed(2)} dB)`
      : `Budget ${b.available_channel_loss_db.toFixed(2)} dB`;

    const att = b.attenuation;
    $("kpi-alpha").textContent = `${att.total_db_per_km.toFixed(4)} dB/km`;
    $("kpi-alpha-sub").textContent = att.is_override
      ? `Direct override (${b.wavelength_nm.toFixed(0)} nm)`
      : `R ${att.rayleigh_db_per_km.toFixed(3)} / Abs ${att.total_absorption_db_per_km.toFixed(3)} / Bnd ${att.total_bending_db_per_km.toFixed(3)}`;

    $("kpi-lmax").textContent = `${b.max_reach_km.toFixed(2)} km`;
    $("kpi-lmax-sub").textContent = b.max_reach_distributed_km !== null
      ? `Reel est. ${b.max_reach_distributed_km.toFixed(2)} km`
      : `Span L = ${b.fiber_length_km.toFixed(2)} km`;
  }

  function renderDesignSolution(sol) {
    const bar = $("design-result-bar");
    bar.hidden = false;
    $("design-result-tag").textContent =
      sol.mode === "max_reach" ? "Design solution: Maximum reach" : "Design solution: Required amplifiers";
    $("design-result-summary").textContent = sol.summary;

    const metrics = [];
    if (sol.solved_max_reach_km !== null) {
      metrics.push(`L_max = ${sol.solved_max_reach_km.toFixed(2)} km`);
    }
    if (sol.solved_num_amplifiers !== null) {
      metrics.push(`N_amp = ${sol.solved_num_amplifiers}`);
    }
    if (sol.span_length_km !== null && sol.span_length_km > 0) {
      metrics.push(`Span L_A = ${sol.span_length_km.toFixed(2)} km (${sol.span_loss_db.toFixed(2)} dB/span)`);
    }
    if (sol.amplifier_positions_km && sol.amplifier_positions_km.length > 0) {
      const posTxt = sol.amplifier_positions_km.map((z) => `${z.toFixed(1)} km`).join(", ");
      metrics.push(`Amp positions: [${posTxt}]`);
    }
    $("design-result-metrics").innerHTML = metrics.map((m) => `<span>${escapeHtml(m)}</span>`).join("");
    $("btn-apply-design").disabled = !sol.feasible;
  }

  function renderLedgerTable(b, cfg) {
    const att = b.attenuation;
    const rows = [
      ["Transmitter launch power (P_tx)", `${fmtPowerLinear(b.tx_power_mw)} average launch`, `${fmtSigned(b.tx_power_dbm, 2)} dBm`, "Source"],
      [
        "Fiber attenuation loss (alpha_f * L)",
        `${att.total_db_per_km.toFixed(4)} dB/km \u00d7 ${b.fiber_length_km.toFixed(2)} km` + (att.is_override ? " (direct override)" : ""),
        `\u2212${b.fiber_loss_db.toFixed(3)} dB`,
        "Passive loss",
      ],
      [
        "Connector loss (alpha_con)",
        `${cfg.num_connectors} connector(s) \u00d7 ${cfg.loss_per_connector_db.toFixed(2)} dB`,
        `\u2212${b.connector_loss_db.toFixed(3)} dB`,
        "Passive loss",
      ],
      [
        "Splice loss (alpha_splice)",
        `${b.effective_num_splices} splice(s) \u00d7 ${cfg.loss_per_splice_db.toFixed(2)} dB (${cfg.splice_mode} mode)`,
        `\u2212${b.splice_loss_db.toFixed(3)} dB`,
        "Passive loss",
      ],
      [
        "Optical splitter loss (alpha_split)",
        cfg.splitter_mode === "ratio"
          ? (cfg.split_ratio > 1 ? `1:${cfg.split_ratio} (+${cfg.splitter_excess_loss_db.toFixed(2)} dB excess)` : "None (1:1)")
          : `Manual (${cfg.manual_splitter_loss_db.toFixed(2)} dB)`,
        `\u2212${b.splitter_loss_db.toFixed(3)} dB`,
        "Passive loss",
      ],
      [
        "Total passive channel loss (C_L)",
        "alpha_f*L + alpha_con + alpha_splice + alpha_split",
        `\u2212${b.total_passive_loss_db.toFixed(3)} dB`,
        "Subtotal",
      ],
      [
        "Effective optical amplifier gain (G_total)",
        `${cfg.num_amplifiers} amp(s) \u00d7 ${cfg.amp_gain_db.toFixed(1)} dB nominal` + (cfg.amp_sat_enabled ? ` (P_sat <= ${cfg.amp_sat_out_dbm} dBm)` : ""),
        `+${b.effective_amp_gain_db.toFixed(3)} dB`,
        "Gain",
      ],
      [
        "Received optical power (P_rx)",
        `P_tx \u2212 C_L + G_total (${fmtPowerLinear(b.received_power_mw)})`,
        `${fmtSigned(b.received_power_dbm, 3)} dBm`,
        "At RX input",
      ],
      [
        "Receiver sensitivity (P_rec)",
        `${fmtPowerLinear(b.rx_sensitivity_mw)} minimum average power`,
        `${fmtSigned(b.rx_sensitivity_dbm, 2)} dBm`,
        "Requirement",
      ],
      [
        "Reserved system margin (M_s)",
        "Aging, temperature & unforeseen penalty allowance",
        `\u2212${b.system_margin_db.toFixed(2)} dB`,
        "Requirement",
      ],
    ];

    const body = $("ledger-body");
    body.innerHTML =
      rows
        .map(
          ([name, spec, val, role]) => `
          <tr>
            <td>${escapeHtml(name)}</td>
            <td><code>${escapeHtml(spec)}</code></td>
            <td class="num">${escapeHtml(val)}</td>
            <td class="num">${escapeHtml(role)}</td>
          </tr>`
        )
        .join("") +
      `<tr class="row-total">
        <td>Net link margin (M_net = P_rx \u2212 P_rec \u2212 M_s)</td>
        <td>Design threshold = ${fmtSigned(b.design_threshold_dbm, 2)} dBm</td>
        <td class="num">${fmtSigned(b.net_margin_db, 3)} dB</td>
        <td class="num"><span class="${b.passed ? "badge-pass" : "badge-fail"}">${b.status_label}</span></td>
      </tr>`;
  }

  // ==========================================================================
  // 4. Native Offline SVG Charts
  // ==========================================================================
  function svgEl(tag, attrs = {}, text = null) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
    if (text !== null) el.textContent = text;
    return el;
  }

  function niceTicks(minVal, maxVal, targetCount = 6) {
    if (Math.abs(maxVal - minVal) < 1e-9) {
      return [minVal - 1, minVal, minVal + 1];
    }
    const rawStep = (maxVal - minVal) / Math.max(2, targetCount);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    let step;
    if (norm <= 1.2) step = 1 * mag;
    else if (norm <= 2.5) step = 2 * mag;
    else if (norm <= 5.5) step = 5 * mag;
    else step = 10 * mag;

    const start = Math.ceil(minVal / step - 1e-9) * step;
    const ticks = [];
    for (let v = start; v <= maxVal + step * 1e-6; v += step) {
      ticks.push(Math.abs(v) < 1e-10 ? 0 : Number(v.toPrecision(8)));
    }
    return ticks;
  }

  // --- Chart 1: Focal Power-Level Diagram P(z) ---
  function renderPowerLevelChart(b, cfg) {
    const container = $("chart-power-level");
    container.innerHTML = "";

    const W = 900, H = 316;
    const pad = { top: 22, right: 34, bottom: 44, left: 68 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const pts = b.power_profile || [];
    const maxZ = Math.max(b.fiber_length_km, 0.1);
    const allY = pts.map((p) => p.power_dbm);
    allY.push(b.rx_sensitivity_dbm, b.design_threshold_dbm, b.tx_power_dbm);
    if (cfg.rx_overload_enabled) allY.push(cfg.rx_overload_dbm);

    const rawMinY = Math.min(...allY);
    const rawMaxY = Math.max(...allY);
    const spanY = Math.max(8, rawMaxY - rawMinY);
    const yMin = rawMinY - spanY * 0.14;
    const yMax = rawMaxY + spanY * 0.15;

    const sx = (z) => pad.left + (z / maxZ) * plotW;
    const sy = (p) => pad.top + (1 - (p - yMin) / (yMax - yMin)) * plotH;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Optical Power-Level Diagram" });
    svg.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "#FFFFFF" }));

    // Shaded Fail & Reserved-Margin Zones
    const ySens = Math.min(pad.top + plotH, Math.max(pad.top, sy(b.rx_sensitivity_dbm)));
    const yThresh = Math.min(pad.top + plotH, Math.max(pad.top, sy(b.design_threshold_dbm)));
    svg.appendChild(svgEl("rect", { x: pad.left, y: ySens, width: plotW, height: Math.max(0, pad.top + plotH - ySens), fill: "#FEE2E2", opacity: 0.45 }));
    svg.appendChild(svgEl("rect", { x: pad.left, y: yThresh, width: plotW, height: Math.max(0, ySens - yThresh), fill: "#FEF3C7", opacity: 0.50 }));

    // Grid & Axes
    for (const xt of niceTicks(0, maxZ, 7)) {
      const x = sx(xt);
      svg.appendChild(svgEl("line", { x1: x, y1: pad.top, x2: x, y2: pad.top + plotH, stroke: COLORS.grid, "stroke-dasharray": "2 3" }));
      svg.appendChild(svgEl("text", { x, y: pad.top + plotH + 17, "text-anchor": "middle", fill: COLORS.secondary, "font-family": "var(--font-mono)", "font-size": 10.8 }, String(xt)));
    }
    for (const yt of niceTicks(yMin, yMax, 6)) {
      const y = sy(yt);
      svg.appendChild(svgEl("line", { x1: pad.left, y1: y, x2: pad.left + plotW, y2: y, stroke: COLORS.grid, "stroke-dasharray": "2 3" }));
      svg.appendChild(svgEl("text", { x: pad.left - 9, y: y + 4, "text-anchor": "end", fill: COLORS.secondary, "font-family": "var(--font-mono)", "font-size": 10.8 }, String(yt)));
    }

    // Axis spines
    svg.appendChild(svgEl("line", { x1: pad.left, y1: pad.top, x2: pad.left, y2: pad.top + plotH, stroke: COLORS.ink, "stroke-width": 1.1 }));
    svg.appendChild(svgEl("line", { x1: pad.left, y1: pad.top + plotH, x2: pad.left + plotW, y2: pad.top + plotH, stroke: COLORS.ink, "stroke-width": 1.1 }));

    // Axis labels
    svg.appendChild(svgEl("text", { x: pad.left + plotW / 2, y: H - 8, "text-anchor": "middle", fill: COLORS.ink, "font-size": 11.8, "font-weight": 500 }, "Transmission Distance, z (km)"));
    svg.appendChild(svgEl("text", { x: 16, y: pad.top + plotH / 2, "text-anchor": "middle", fill: COLORS.ink, "font-size": 11.8, "font-weight": 500, transform: `rotate(-90 16 ${pad.top + plotH / 2})` }, "Optical Power, P(z) (dBm)"));

    // Reference threshold dashed lines
    svg.appendChild(svgEl("line", { x1: pad.left, y1: ySens, x2: pad.left + plotW, y2: ySens, stroke: COLORS.fail, "stroke-width": 1.45, "stroke-dasharray": "6 4" }));
    if (b.system_margin_db > 0) {
      svg.appendChild(svgEl("line", { x1: pad.left, y1: yThresh, x2: pad.left + plotW, y2: yThresh, stroke: COLORS.warn, "stroke-width": 1.3, "stroke-dasharray": "6 3 2 3" }));
    }

    // Non-overlapping Threshold & Sensitivity Labels:
    // 1) Design Threshold anchored ABOVE its line; RX Sensitivity anchored BELOW its line (>= 18 px apart).
    // 2) Right-offset well clear of the final RX marker dot at z = L (extra clearance if RX dot sits nearby).
    const MIN_SEP = 18;
    const minLabelY = pad.top + 13;
    const maxLabelY = pad.top + plotH - 6;

    let labelYThresh = Math.max(minLabelY, yThresh - 6);
    let labelYSens = Math.min(maxLabelY, ySens + 13);

    if (b.system_margin_db > 0 && labelYSens - labelYThresh < MIN_SEP) {
      if (labelYThresh + MIN_SEP <= maxLabelY) {
        labelYSens = labelYThresh + MIN_SEP;
      } else {
        labelYSens = maxLabelY;
        labelYThresh = Math.max(minLabelY, labelYSens - MIN_SEP);
      }
    }

    const yRxDot = sy(b.received_power_dbm);
    const threshNearRx = Math.abs(labelYThresh - yRxDot) < 18;
    const sensNearRx = Math.abs(labelYSens - yRxDot) < 18;
    const xLabelBase = pad.left + plotW - 14;
    const xLabelThresh = threshNearRx ? xLabelBase - 14 : xLabelBase;
    const xLabelSens = sensNearRx ? xLabelBase - 14 : xLabelBase;

    if (b.system_margin_db > 0) {
      svg.appendChild(svgEl("text", {
        x: xLabelThresh,
        y: labelYThresh,
        "text-anchor": "end",
        fill: COLORS.warn,
        stroke: "#FFFFFF",
        "stroke-width": 3.5,
        "paint-order": "stroke",
        "font-family": "var(--font-mono)",
        "font-size": 10.2,
        "font-weight": 600,
      }, `Design Threshold P_rec + M_s (${b.design_threshold_dbm.toFixed(1)} dBm)`));
    }

    svg.appendChild(svgEl("text", {
      x: xLabelSens,
      y: labelYSens,
      "text-anchor": "end",
      fill: COLORS.fail,
      stroke: "#FFFFFF",
      "stroke-width": 3.5,
      "paint-order": "stroke",
      "font-family": "var(--font-mono)",
      "font-size": 10.2,
      "font-weight": 600,
    }, `RX Sensitivity (${b.rx_sensitivity_dbm.toFixed(1)} dBm)`));

    if (cfg.rx_overload_enabled) {
      const yOv = sy(cfg.rx_overload_dbm);
      if (yOv >= pad.top && yOv <= pad.top + plotH) {
        svg.appendChild(svgEl("line", { x1: pad.left, y1: yOv, x2: pad.left + plotW, y2: yOv, stroke: COLORS.overload, "stroke-width": 1.2, "stroke-dasharray": "4 4" }));
        svg.appendChild(svgEl("text", {
          x: pad.left + 8,
          y: Math.max(minLabelY, yOv - 5),
          fill: COLORS.overload,
          stroke: "#FFFFFF",
          "stroke-width": 3,
          "paint-order": "stroke",
          "font-family": "var(--font-mono)",
          "font-size": 10.2,
          "font-weight": 600,
        }, `RX Overload (${cfg.rx_overload_dbm.toFixed(1)} dBm)`));
      }
    }

    // Main optical trace polyline
    const traceColor = wlAccent(b.wavelength_nm);
    if (pts.length >= 2) {
      const dStr = pts.map((pt, i) => `${i === 0 ? "M" : "L"}${sx(pt.distance_km).toFixed(2)},${sy(pt.power_dbm).toFixed(2)}`).join(" ");
      svg.appendChild(svgEl("path", { d: dStr, fill: "none", stroke: traceColor, "stroke-width": 2.4, "stroke-linejoin": "round" }));
    }

    // Discrete vertical transitions (EDFAs, splitters, splices, connectors)
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const x = sx(curr.distance_km);
      const y1 = sy(prev.power_dbm);
      const y2 = sy(curr.power_dbm);

      if (curr.event_type === "amplifier_out") {
        svg.appendChild(svgEl("line", { x1: x, y1, x2: x, y2, stroke: COLORS.amp, "stroke-width": 2.8 }));
        svg.appendChild(svgEl("polygon", { points: `${x},${y2 - 5} ${x - 4.5},${y2 + 3} ${x + 4.5},${y2 + 3}`, fill: COLORS.amp, stroke: "#FFFFFF", "stroke-width": 0.9 }));
        svg.appendChild(svgEl("text", { x, y: Math.max(pad.top + 11, y2 - 9), "text-anchor": "middle", fill: COLORS.amp, stroke: "#FFFFFF", "stroke-width": 2.8, "paint-order": "stroke", "font-family": "var(--font-mono)", "font-size": 10, "font-weight": 600 }, `+${curr.delta_db.toFixed(1)} dB`));
      } else if (curr.event_type === "splitter") {
        svg.appendChild(svgEl("line", { x1: x, y1, x2: x, y2, stroke: COLORS.splitter, "stroke-width": 2.8 }));
        svg.appendChild(svgEl("polygon", { points: `${x},${y2 + 5} ${x - 4.5},${y2 - 3} ${x + 4.5},${y2 - 3}`, fill: COLORS.splitter, stroke: "#FFFFFF", "stroke-width": 0.9 }));
        svg.appendChild(svgEl("text", { x: Math.min(pad.left + plotW - 44, x + 7), y: (y1 + y2) / 2 + 3, fill: COLORS.splitter, stroke: "#FFFFFF", "stroke-width": 2.8, "paint-order": "stroke", "font-family": "var(--font-mono)", "font-size": 10, "font-weight": 600 }, `${curr.delta_db.toFixed(1)} dB`));
      } else if (curr.event_type === "splice") {
        svg.appendChild(svgEl("circle", { cx: x, cy: y2, r: 3.0, fill: COLORS.splice, stroke: "#FFFFFF", "stroke-width": 0.8 }));
      } else if (curr.event_type === "connector") {
        svg.appendChild(svgEl("line", { x1: x, y1, x2: x, y2, stroke: COLORS.connector, "stroke-width": 2.4 }));
      }
    }

    // TX & RX terminal markers
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first) {
      svg.appendChild(svgEl("circle", { cx: sx(first.distance_km), cy: sy(first.power_dbm), r: 4.5, fill: COLORS.ink, stroke: "#FFFFFF", "stroke-width": 1.3 }));
    }
    if (last) {
      svg.appendChild(svgEl("circle", { cx: sx(last.distance_km), cy: sy(last.power_dbm), r: 5.2, fill: b.passed ? COLORS.pass : COLORS.fail, stroke: "#FFFFFF", "stroke-width": 1.4 }));
    }

    // Interactive Crosshair Hover
    const hoverLine = svgEl("line", { x1: pad.left, y1: pad.top, x2: pad.left, y2: pad.top + plotH, stroke: "#64748B", "stroke-width": 1, "stroke-dasharray": "3 3", visibility: "hidden" });
    const hoverDot = svgEl("circle", { cx: 0, cy: 0, r: 4.8, fill: traceColor, stroke: "#FFFFFF", "stroke-width": 1.5, visibility: "hidden" });
    svg.appendChild(hoverLine);
    svg.appendChild(hoverDot);

    const overlay = svgEl("rect", { x: pad.left, y: pad.top, width: plotW, height: plotH, fill: "transparent", cursor: "crosshair" });
    const readout = $("power-hover-readout");
    const defaultReadout = `TX ${fmtSigned(b.tx_power_dbm, 1)} dBm \u2192 RX ${fmtSigned(b.received_power_dbm, 2)} dBm (${b.status_label})`;

    overlay.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const mx = ((ev.clientX - rect.left) / rect.width) * W;
      const zCursor = Math.min(maxZ, Math.max(0, ((mx - pad.left) / plotW) * maxZ));

      let bestPt = pts[0];
      let bestDist = Infinity;
      for (const pt of pts) {
        const d = Math.abs(pt.distance_km - zCursor);
        if (d < bestDist) {
          bestDist = d;
          bestPt = pt;
        }
      }

      let showZ = zCursor;
      let showP = bestPt ? bestPt.power_dbm : 0;
      let label = "Fiber span";

      if (bestPt && bestDist <= maxZ * 0.018) {
        showZ = bestPt.distance_km;
        showP = bestPt.power_dbm;
        label = bestPt.event + (bestPt.delta_db !== 0 ? ` (${fmtSigned(bestPt.delta_db, 2)} dB)` : "");
      } else {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], c = pts[i];
          if (zCursor >= a.distance_km && zCursor <= c.distance_km && c.distance_km > a.distance_km) {
            const t = (zCursor - a.distance_km) / (c.distance_km - a.distance_km);
            showP = a.power_dbm + t * (c.power_dbm - a.power_dbm);
            break;
          }
        }
      }

      hoverLine.setAttribute("x1", sx(showZ).toFixed(1));
      hoverLine.setAttribute("x2", sx(showZ).toFixed(1));
      hoverLine.setAttribute("visibility", "visible");
      hoverDot.setAttribute("cx", sx(showZ).toFixed(1));
      hoverDot.setAttribute("cy", sy(showP).toFixed(1));
      hoverDot.setAttribute("visibility", "visible");
      readout.textContent = `z = ${showZ.toFixed(2)} km | P = ${fmtSigned(showP, 2)} dBm | ${label}`;
    });

    overlay.addEventListener("mouseleave", () => {
      hoverLine.setAttribute("visibility", "hidden");
      hoverDot.setAttribute("visibility", "hidden");
      readout.textContent = defaultReadout;
    });

    svg.appendChild(overlay);
    readout.textContent = defaultReadout;
    container.appendChild(svg);
  }

  // --- Chart 2: Full-Width Loss Breakdown + Fiber Mechanism Strip ---
  function renderLossBreakdownChart(b, cfg) {
    const container = $("chart-loss-breakdown");
    container.innerHTML = "";

    const totalBudget = Math.max(0.1, b.tx_power_dbm + b.effective_amp_gain_db - b.rx_sensitivity_dbm);
    const items = [
      { label: "Fiber attenuation", val: b.fiber_loss_db, color: wlAccent(b.wavelength_nm) },
      { label: "Optical splitter", val: b.splitter_loss_db, color: COLORS.splitter },
      { label: "System margin (M_s)", val: b.system_margin_db, color: COLORS.margin },
      { label: `Connectors (\u00d7${cfg.num_connectors})`, val: b.connector_loss_db, color: COLORS.connector },
      { label: `Splices (\u00d7${b.effective_num_splices})`, val: b.splice_loss_db, color: COLORS.splice },
      {
        label: b.net_margin_db >= 0 ? "Excess margin (M_net)" : "Power deficit",
        val: Math.abs(b.net_margin_db),
        color: b.net_margin_db >= 0 ? COLORS.pass : COLORS.fail,
        signedVal: b.net_margin_db,
      },
    ];

    const W = 900, H = 248;
    const pad = { top: 12, right: 148, bottom: 36, left: 164 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const maxVal = Math.max(1.0, ...items.map((d) => d.val)) * 1.06;
    const sx = (v) => pad.left + (v / maxVal) * plotW;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Loss Breakdown Bar Chart" });
    svg.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "#FFFFFF" }));

    for (const xt of niceTicks(0, maxVal, 6)) {
      const x = sx(xt);
      svg.appendChild(svgEl("line", { x1: x, y1: pad.top, x2: x, y2: pad.top + plotH, stroke: COLORS.grid, "stroke-dasharray": "2 3" }));
      svg.appendChild(svgEl("text", { x, y: pad.top + plotH + 16, "text-anchor": "middle", fill: COLORS.secondary, "font-family": "var(--font-mono)", "font-size": 10.8 }, String(xt)));
    }

    const rowH = plotH / items.length;
    const barH = Math.min(22, rowH * 0.62);

    items.forEach((item, i) => {
      const cy = pad.top + rowH * (i + 0.5);
      const w = Math.max(0, sx(item.val) - pad.left);
      svg.appendChild(svgEl("text", { x: pad.left - 10, y: cy + 4, "text-anchor": "end", fill: COLORS.ink, "font-size": 11.8, "font-weight": 500 }, item.label));
      svg.appendChild(svgEl("rect", { x: pad.left, y: cy - barH / 2, width: w, height: barH, rx: 2, fill: item.color }));

      const pct = (item.val / totalBudget) * 100;
      const numStr = item.signedVal !== undefined && item.signedVal < 0
        ? `${item.signedVal.toFixed(2)} dB`
        : `${item.val.toFixed(2)} dB (${pct.toFixed(1)}%)`;
      svg.appendChild(svgEl("text", { x: pad.left + w + 8, y: cy + 4, fill: COLORS.ink, "font-family": "var(--font-mono)", "font-size": 10.8, "font-weight": 500 }, numStr));
    });

    svg.appendChild(svgEl("line", { x1: pad.left, y1: pad.top, x2: pad.left, y2: pad.top + plotH, stroke: COLORS.ink, "stroke-width": 1.1 }));
    svg.appendChild(svgEl("line", { x1: pad.left, y1: pad.top + plotH, x2: pad.left + plotW, y2: pad.top + plotH, stroke: COLORS.ink, "stroke-width": 1.1 }));
    svg.appendChild(svgEl("text", { x: pad.left + plotW / 2, y: H - 5, "text-anchor": "middle", fill: COLORS.ink, "font-size": 11.5, "font-weight": 500 }, "Loss / Allocation (dB)"));

    container.appendChild(svg);

    const att = b.attenuation;
    const strip = $("fiber-mech-strip");
    if (att.is_override) {
      strip.innerHTML = `<div class="mech-strip-title"><span>Fiber attenuation mode</span><span>Direct override: ${att.total_db_per_km.toFixed(4)} dB/km</span></div>`;
      return;
    }
    const tot = Math.max(1e-9, att.total_db_per_km);
    const parts = [
      { name: "Rayleigh", val: att.rayleigh_db_per_km, col: COLORS.rayleigh },
      { name: "Absorption", val: att.total_absorption_db_per_km, col: COLORS.absorption },
      { name: "Waveguide", val: att.waveguide_db_per_km, col: COLORS.wg },
      { name: "Bending", val: att.total_bending_db_per_km, col: COLORS.bend },
    ];
    strip.innerHTML = `
      <div class="mech-strip-title">
        <span>Fiber attenuation mechanisms at ${b.wavelength_nm.toFixed(0)} nm</span>
        <span>${att.total_db_per_km.toFixed(4)} dB/km</span>
      </div>
      <div class="mech-bar-track">
        ${parts.map((p) => `<div style="width:${(100 * p.val / tot).toFixed(2)}%;background:${p.col}" title="${p.name}: ${p.val.toFixed(4)} dB/km"></div>`).join("")}
      </div>
      <div class="mech-legend">
        ${parts.map((p) => `<span><i class="mech-dot" style="background:${p.col}"></i>${p.name} ${(100 * p.val / tot).toFixed(1)}% (${p.val.toFixed(3)} dB/km)</span>`).join("")}
      </div>
    `;
  }

  // --- Chart 3: Full-Width Link Margin vs. Length (850 / 1310 / 1550 nm) ---
  function renderMarginVsLengthChart(sweep, b) {
    const container = $("chart-margin-length");
    container.innerHTML = "";

    const W = 900, H = 286;
    const pad = { top: 18, right: 26, bottom: 42, left: 68 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const lengths = sweep.lengths_km || [];
    const curves = sweep.curves || [];
    const maxL = Math.max(sweep.max_length_km || 10, 1);

    const y0 = curves.length > 0 && curves[0].net_margin_db.length > 0 ? curves[0].net_margin_db[0] : 20;
    const yMax = Math.max(10, y0 + 6);
    const yMin = -Math.max(16, Math.min(35, yMax * 1.1));

    const sx = (L) => pad.left + (L / maxL) * plotW;
    const sy = (m) => pad.top + (1 - (m - yMin) / (yMax - yMin)) * plotH;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Net Link Margin vs Fiber Length" });
    svg.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "#FFFFFF" }));

    const yZero = Math.min(pad.top + plotH, Math.max(pad.top, sy(0)));
    svg.appendChild(svgEl("rect", { x: pad.left, y: pad.top, width: plotW, height: Math.max(0, yZero - pad.top), fill: "#F0FDF4", opacity: 0.65 }));
    svg.appendChild(svgEl("rect", { x: pad.left, y: yZero, width: plotW, height: Math.max(0, pad.top + plotH - yZero), fill: "#FEF2F2", opacity: 0.50 }));

    for (const xt of niceTicks(0, maxL, 8)) {
      const x = sx(xt);
      svg.appendChild(svgEl("line", { x1: x, y1: pad.top, x2: x, y2: pad.top + plotH, stroke: COLORS.grid, "stroke-dasharray": "2 3" }));
      svg.appendChild(svgEl("text", { x, y: pad.top + plotH + 16, "text-anchor": "middle", fill: COLORS.secondary, "font-family": "var(--font-mono)", "font-size": 10.8 }, String(xt)));
    }
    for (const yt of niceTicks(yMin, yMax, 6)) {
      const y = sy(yt);
      svg.appendChild(svgEl("line", { x1: pad.left, y1: y, x2: pad.left + plotW, y2: y, stroke: COLORS.grid, "stroke-dasharray": "2 3" }));
      svg.appendChild(svgEl("text", { x: pad.left - 9, y: y + 4, "text-anchor": "end", fill: COLORS.secondary, "font-family": "var(--font-mono)", "font-size": 10.8 }, String(yt)));
    }

    svg.appendChild(svgEl("line", { x1: pad.left, y1: yZero, x2: pad.left + plotW, y2: yZero, stroke: COLORS.fail, "stroke-width": 1.5, "stroke-dasharray": "6 4" }));
    svg.appendChild(svgEl("text", { x: pad.left + plotW - 6, y: pad.top + 14, "text-anchor": "end", fill: COLORS.pass, "font-family": "var(--font-mono)", "font-size": 10.3, "font-weight": 600 }, "PASS (M_net \u2265 0 dB)"));
    svg.appendChild(svgEl("text", { x: pad.left + plotW - 6, y: pad.top + plotH - 7, "text-anchor": "end", fill: COLORS.fail, "font-family": "var(--font-mono)", "font-size": 10.3, "font-weight": 600 }, "FAIL (M_net < 0 dB)"));

    if (b.fiber_length_km >= 0 && b.fiber_length_km <= maxL) {
      const xAct = sx(b.fiber_length_km);
      svg.appendChild(svgEl("line", { x1: xAct, y1: pad.top, x2: xAct, y2: pad.top + plotH, stroke: COLORS.ink, "stroke-width": 1.1, "stroke-dasharray": "3 3", opacity: 0.55 }));
    }

    const clipId = "clip-margin-plot";
    const defs = svgEl("defs");
    const clip = svgEl("clipPath", { id: clipId });
    clip.appendChild(svgEl("rect", { x: pad.left, y: pad.top, width: plotW, height: plotH }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    const curveGroup = svgEl("g", { "clip-path": `url(#${clipId})` });
    curves.forEach((c) => {
      const col = wlAccent(c.wavelength_nm);
      const d = lengths.map((L, idx) => `${idx === 0 ? "M" : "L"}${sx(L).toFixed(1)},${sy(c.net_margin_db[idx]).toFixed(1)}`).join(" ");
      curveGroup.appendChild(svgEl("path", { d, fill: "none", stroke: col, "stroke-width": 2.3 }));
    });
    svg.appendChild(curveGroup);

    curves.forEach((c) => {
      const col = wlAccent(c.wavelength_nm);
      if (c.max_reach_km >= 0 && c.max_reach_km <= maxL) {
        svg.appendChild(svgEl("circle", { cx: sx(c.max_reach_km), cy: yZero, r: 4.5, fill: col, stroke: "#FFFFFF", "stroke-width": 1.2 }));
      }
    });

    const legX = pad.left + 10;
    const legY = pad.top + plotH - 64;
    svg.appendChild(svgEl("rect", { x: legX, y: legY, width: 294, height: 56, rx: 3, fill: "#FFFFFF", "fill-opacity": 0.95, stroke: "#CBD5E1" }));
    curves.forEach((c, i) => {
      const col = wlAccent(c.wavelength_nm);
      const ry = legY + 15 + i * 16;
      svg.appendChild(svgEl("line", { x1: legX + 9, y1: ry - 3, x2: legX + 25, y2: ry - 3, stroke: col, "stroke-width": 2.4 }));
      svg.appendChild(svgEl("text", { x: legX + 31, y: ry, fill: COLORS.ink, "font-family": "var(--font-mono)", "font-size": 10.2, "font-weight": 500 }, `${c.wavelength_nm.toFixed(0)} nm (\u03b1=${c.alpha_db_per_km.toFixed(3)} dB/km) \u2014 L_max = ${c.max_reach_km.toFixed(1)} km`));
    });

    svg.appendChild(svgEl("line", { x1: pad.left, y1: pad.top, x2: pad.left, y2: pad.top + plotH, stroke: COLORS.ink, "stroke-width": 1.1 }));
    svg.appendChild(svgEl("line", { x1: pad.left, y1: pad.top + plotH, x2: pad.left + plotW, y2: pad.top + plotH, stroke: COLORS.ink, "stroke-width": 1.1 }));
    svg.appendChild(svgEl("text", { x: pad.left + plotW / 2, y: H - 6, "text-anchor": "middle", fill: COLORS.ink, "font-size": 11.8, "font-weight": 500 }, "Fiber Link Length, L (km)"));
    svg.appendChild(svgEl("text", { x: 16, y: pad.top + plotH / 2, "text-anchor": "middle", fill: COLORS.ink, "font-size": 11.8, "font-weight": 500, transform: `rotate(-90 16 ${pad.top + plotH / 2})` }, "Net Margin, M_net (dB)"));

    container.appendChild(svg);
  }

  // --- Chart 4: Semi-Log Silica Attenuation Spectrum alpha(lambda) ---
  function renderSpectrumChart(spec, b) {
    const container = $("chart-spectrum");
    container.innerHTML = "";

    const W = 900, H = 286;
    const pad = { top: 18, right: 26, bottom: 42, left: 68 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const wls = spec.wavelengths_nm || [];
    const minWl = 800, maxWl = 1700;
    const minLog = -2.0;
    const maxLog = 1.0;

    const sx = (w) => pad.left + ((w - minWl) / (maxWl - minWl)) * plotW;
    const sy = (a) => {
      const lg = Math.log10(Math.max(1e-4, a));
      const clamped = Math.min(maxLog, Math.max(minLog, lg));
      return pad.top + (1 - (clamped - minLog) / (maxLog - minLog)) * plotH;
    };

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Silica Fiber Attenuation Spectrum" });
    svg.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "#FFFFFF" }));

    svg.appendChild(svgEl("rect", { x: sx(1260), y: pad.top, width: sx(1360) - sx(1260), height: plotH, fill: "#DBEAFE", opacity: 0.42 }));
    svg.appendChild(svgEl("rect", { x: sx(1530), y: pad.top, width: sx(1565) - sx(1530), height: plotH, fill: "#CCFBF1", opacity: 0.50 }));

    for (let w = 800; w <= 1700; w += 100) {
      const x = sx(w);
      svg.appendChild(svgEl("line", { x1: x, y1: pad.top, x2: x, y2: pad.top + plotH, stroke: COLORS.grid, "stroke-dasharray": "2 3" }));
      svg.appendChild(svgEl("text", { x, y: pad.top + plotH + 16, "text-anchor": "middle", fill: COLORS.secondary, "font-family": "var(--font-mono)", "font-size": 10.8 }, String(w)));
    }
    [0.01, 0.1, 1, 10].forEach((yt) => {
      const y = sy(yt);
      svg.appendChild(svgEl("line", { x1: pad.left, y1: y, x2: pad.left + plotW, y2: y, stroke: COLORS.grid, "stroke-dasharray": "2 3" }));
      svg.appendChild(svgEl("text", { x: pad.left - 9, y: y + 4, "text-anchor": "end", fill: COLORS.secondary, "font-family": "var(--font-mono)", "font-size": 10.8 }, String(yt)));
    });

    const clipId = "clip-spec-plot";
    const defs = svgEl("defs");
    const clip = svgEl("clipPath", { id: clipId });
    clip.appendChild(svgEl("rect", { x: pad.left, y: pad.top, width: plotW, height: plotH }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    const g = svgEl("g", { "clip-path": `url(#${clipId})` });
    const makePath = (arr, color, width, dash = "") => {
      const d = wls.map((w, i) => `${i === 0 ? "M" : "L"}${sx(w).toFixed(1)},${sy(arr[i]).toFixed(1)}`).join(" ");
      const attrs = { d, fill: "none", stroke: color, "stroke-width": width };
      if (dash) attrs["stroke-dasharray"] = dash;
      g.appendChild(svgEl("path", attrs));
    };

    makePath(spec.rayleigh, COLORS.rayleigh, 1.5, "5 3");
    makePath(spec.uv_absorption, COLORS.absorption, 1.4, "2 3");
    makePath(spec.ir_absorption, COLORS.ir, 1.4, "6 3 2 3");
    makePath(spec.total_bending, COLORS.bend, 1.4, "4 2");
    makePath(spec.total, COLORS.ink, 2.3);
    svg.appendChild(g);

    if (b.wavelength_nm >= minWl && b.wavelength_nm <= maxWl) {
      const xa = sx(b.wavelength_nm);
      const ya = sy(b.attenuation.total_db_per_km);
      const col = wlAccent(b.wavelength_nm);
      svg.appendChild(svgEl("line", { x1: xa, y1: pad.top, x2: xa, y2: pad.top + plotH, stroke: col, "stroke-width": 1.4, "stroke-dasharray": "4 3" }));
      svg.appendChild(svgEl("circle", { cx: xa, cy: ya, r: 5, fill: col, stroke: "#FFFFFF", "stroke-width": 1.3 }));
      $("spectrum-hover-readout").textContent = `\u03bb = ${b.wavelength_nm.toFixed(0)} nm | \u03b1 = ${b.attenuation.total_db_per_km.toFixed(4)} dB/km`;
    }

    const legendItems = [
      ["Total \u03b1(\u03bb)", COLORS.ink, ""],
      ["Rayleigh", COLORS.rayleigh, "5 3"],
      ["UV tail", COLORS.absorption, "2 3"],
      ["IR tail", COLORS.ir, "6 3 2 3"],
      ["Bending", COLORS.bend, "4 2"],
    ];
    let lx = pad.left + 12;
    const ly = pad.top + plotH - 12;
    svg.appendChild(svgEl("rect", { x: lx - 6, y: ly - 12, width: 422, height: 19, rx: 3, fill: "#FFFFFF", "fill-opacity": 0.94, stroke: "#CBD5E1" }));
    legendItems.forEach(([txt, col, dash]) => {
      const attrs = { x1: lx, y1: ly - 3, x2: lx + 16, y2: ly - 3, stroke: col, "stroke-width": 2 };
      if (dash) attrs["stroke-dasharray"] = dash;
      svg.appendChild(svgEl("line", attrs));
      svg.appendChild(svgEl("text", { x: lx + 20, y: ly, fill: COLORS.ink, "font-family": "var(--font-mono)", "font-size": 10.2 }, txt));
      lx += 83;
    });

    svg.appendChild(svgEl("line", { x1: pad.left, y1: pad.top, x2: pad.left, y2: pad.top + plotH, stroke: COLORS.ink, "stroke-width": 1.1 }));
    svg.appendChild(svgEl("line", { x1: pad.left, y1: pad.top + plotH, x2: pad.left + plotW, y2: pad.top + plotH, stroke: COLORS.ink, "stroke-width": 1.1 }));
    svg.appendChild(svgEl("text", { x: pad.left + plotW / 2, y: H - 6, "text-anchor": "middle", fill: COLORS.ink, "font-size": 11.8, "font-weight": 500 }, "Operating Wavelength, \u03bb (nm)"));
    svg.appendChild(svgEl("text", { x: 16, y: pad.top + plotH / 2, "text-anchor": "middle", fill: COLORS.ink, "font-size": 11.8, "font-weight": 500, transform: `rotate(-90 16 ${pad.top + plotH / 2})` }, "Attenuation, \u03b1 (dB/km)"));

    container.appendChild(svg);
  }

  // ==========================================================================
  // 5. Agrawal 5th Ed. Live Validation Modal
  // ==========================================================================
  async function openValidationModal() {
    const modal = $("validate-modal");
    modal.hidden = false;
    $("validate-summary").textContent = "Executing live Agrawal 5th Ed. benchmarks...";
    $("validate-summary").className = "modal-summary";
    $("validate-tbody").innerHTML = "";

    try {
      const rep = await apiFetch("/api/validate");
      const summaryEl = $("validate-summary");
      summaryEl.className = "modal-summary " + (rep.all_passed ? "ok" : "bad");
      summaryEl.textContent = `${rep.passed_count} / ${rep.total_count} textbook benchmark checks passed (tolerance < ${rep.tolerance_pct}% vs. exact Agrawal 5th Ed. equations).`;

      let lastGroup = "";
      const html = [];
      for (const item of rep.checks) {
        if (item.group !== lastGroup) {
          lastGroup = item.group;
          html.push(`<tr class="row-group"><td colspan="5">${escapeHtml(lastGroup)}</td></tr>`);
        }
        const exp = item.unit === "exact" ? String(item.expected) : `${Number(item.expected).toFixed(4)} ${item.unit}`;
        const cmp = item.unit === "exact" ? String(item.computed) : `${Number(item.computed).toFixed(4)} ${item.unit}`;
        html.push(`
          <tr>
            <td>${escapeHtml(item.name)}</td>
            <td class="num">${escapeHtml(exp)}</td>
            <td class="num">${escapeHtml(cmp)}</td>
            <td class="num">${Number(item.error_pct).toFixed(4)}%</td>
            <td class="num"><span class="${item.passed ? "badge-pass" : "badge-fail"}">${item.passed ? "PASS" : "FAIL"}</span></td>
          </tr>
        `);
      }
      $("validate-tbody").innerHTML = html.join("");
    } catch (err) {
      $("validate-summary").className = "modal-summary bad";
      $("validate-summary").textContent = `Validation failed: ${err.message}`;
    }
  }

  // ==========================================================================
  // 6. Export Utilities (CSV, JSON, SVG, HiDPI PNG, Print)
  // ==========================================================================
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportBudgetCSV() {
    if (!state.lastResponse) return;
    const b = state.lastResponse.budget;
    const cfg = state.lastResponse.config;
    const lines = [
      "Section,Parameter,Value,Unit",
      `Summary,Status,${b.status_label},`,
      `Summary,Wavelength,${b.wavelength_nm},nm`,
      `Summary,Fiber Length,${b.fiber_length_km},km`,
      `Summary,TX Power,${b.tx_power_dbm},dBm`,
      `Summary,RX Sensitivity,${b.rx_sensitivity_dbm},dBm`,
      `Summary,System Margin,${b.system_margin_db},dB`,
      `Summary,Fiber Attenuation Coeff,${b.attenuation.total_db_per_km.toFixed(6)},dB/km`,
      `Summary,Fiber Loss,${b.fiber_loss_db.toFixed(4)},dB`,
      `Summary,Connector Loss (${cfg.num_connectors}x),${b.connector_loss_db.toFixed(4)},dB`,
      `Summary,Splice Loss (${b.effective_num_splices}x),${b.splice_loss_db.toFixed(4)},dB`,
      `Summary,Splitter Loss,${b.splitter_loss_db.toFixed(4)},dB`,
      `Summary,Total Passive Loss C_L,${b.total_passive_loss_db.toFixed(4)},dB`,
      `Summary,Effective Amplifier Gain,${b.effective_amp_gain_db.toFixed(4)},dB`,
      `Summary,Received Power P_rx,${b.received_power_dbm.toFixed(4)},dBm`,
      `Summary,Gross Margin,${b.gross_margin_db.toFixed(4)},dB`,
      `Summary,Net Link Margin,${b.net_margin_db.toFixed(4)},dB`,
      `Summary,Maximum Reach L_max,${b.max_reach_km.toFixed(4)},km`,
      "",
      "Distance_km,Power_dBm,Event,Delta_dB",
      ...b.power_profile.map((pt) => `${pt.distance_km.toFixed(4)},${pt.power_dbm.toFixed(4)},"${pt.event}",${pt.delta_db.toFixed(4)}`),
    ];
    const fn = `link_budget_${Math.round(b.wavelength_nm)}nm.csv`;
    downloadBlob(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }), fn);
    showNotification("Exported CSV", fn, 3200, COLORS.wl1310);
  }

  function exportConfigJSON() {
    if (!state.lastResponse) return;
    const payload = {
      exported_at: new Date().toISOString(),
      config: state.lastResponse.config,
      budget: state.lastResponse.budget,
      design_solution: state.lastDesign ? state.lastDesign.solution : null,
    };
    const fn = `link_budget_${Math.round(state.lastResponse.budget.wavelength_nm)}nm.json`;
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }), fn);
    showNotification("Exported JSON", fn, 3200, COLORS.wl1310);
  }

  function serializeChartSvg(containerId) {
    const svg = $(containerId)?.querySelector("svg");
    if (!svg) return null;
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    let text = new XMLSerializer().serializeToString(clone);
    text = text.replace(/var\(--font-mono\)/g, "JetBrains Mono, Consolas, monospace");
    return text;
  }

  function exportChartSVG(containerId, filename) {
    const svgText = serializeChartSvg(containerId);
    if (!svgText) return;
    downloadBlob(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }), filename);
    showNotification("Exported SVG", filename, 3200, COLORS.wl1310);
  }

  function exportChartPNG(containerId, filename) {
    const svgText = serializeChartSvg(containerId);
    if (!svgText) return;
    const svgElNode = $(containerId).querySelector("svg");
    const vb = svgElNode.viewBox.baseVal;
    const scale = 2.5;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vb.width * scale);
    canvas.height = Math.round(vb.height * scale);
    const ctx = canvas.getContext("2d");
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));
    img.onload = () => {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) {
          downloadBlob(blob, filename);
          showNotification("Exported HiDPI PNG", filename, 3200, COLORS.wl1310);
        }
      }, "image/png");
    };
    img.src = url;
  }

  // ==========================================================================
  // 7. Initialization & Event Wiring
  // ==========================================================================
  function loadPresetById(presetId) {
    const found = state.presets.find((p) => p.id === presetId);
    if (!found) return;
    $("preset-select").value = presetId;
    writeConfigToUI(found.config, { autoManageDrawers: true });
    hideDesignResultBanner();
    scheduleAnalyze(0);
    showNotification("Preset loaded", found.label, 3000, COLORS.wl1550);
  }

  function bindEvents() {
    $("preset-select").addEventListener("change", (e) => {
      if (e.target.value) loadPresetById(e.target.value);
    });

    // Mode tabs
    $("tab-analysis").addEventListener("click", () => setUiMode("analysis"));
    $("tab-design").addEventListener("click", () => setUiMode("design"));

    // Secondary view tabs
    document.querySelectorAll(".view-tab").forEach((btn) => {
      btn.addEventListener("click", () => setActiveViewTab(btn.dataset.viewTab));
    });

    // Analysis-mode FAIL Quick-Fix actions
    $("btn-quick-max-reach").addEventListener("click", quickFixApplyMaxReach);
    $("btn-quick-add-amps").addEventListener("click", quickFixAutoAddAmplifiers);

    // Design mode controls
    document.querySelectorAll("[data-design-mode]").forEach((btn) => {
      btn.addEventListener("click", () => setDesignMode(btn.dataset.designMode));
    });
    $("btn-run-design").addEventListener("click", runDesignSolver);
    $("btn-dismiss-design").addEventListener("click", () => {
      hideDesignResultBanner();
      scheduleAnalyze(0);
    });
    $("btn-apply-design").addEventListener("click", applyDesignSolution);

    // Wavelength pills
    document.querySelectorAll(".wl-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const wl = parseFloat(btn.dataset.wl);
        $("wavelength-nm").value = wl;
        syncWavelengthPills(wl);
        scheduleAnalyze(0);
      });
    });

    $("wavelength-nm").addEventListener("input", () => {
      const wl = parseFloat($("wavelength-nm").value);
      if (!Number.isNaN(wl)) syncWavelengthPills(wl);
      scheduleAnalyze();
    });

    // Fiber model dropdown
    $("fiber-preset").addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "custom") {
        $("drawer-fiber-physics").open = true;
        updateDrawerBadges();
        return;
      }
      const fp = state.fiberPresets[val];
      if (!fp) return;
      $("fp-cr").value = fp.rayleigh_coeff_cr;
      $("fp-oh").value = fp.oh_concentration_ppb;
      $("fp-bend-r").value = fp.bend_radius_mm;
      $("fp-micro").value = fp.microbending_db_per_km;
      $("fp-wg").value = fp.waveguide_loss_db_per_km;
      $("alpha-override-enabled").checked = false;
      $("alpha-override-wrap").hidden = true;
      updateDrawerBadges();
      scheduleAnalyze(0);
    });

    // Advanced drawer checkboxes & override
    $("alpha-override-enabled").addEventListener("change", (e) => {
      $("alpha-override-wrap").hidden = !e.target.checked;
      updateDrawerBadges();
      scheduleAnalyze(0);
    });
    $("alpha-override-val").addEventListener("input", () => {
      updateDrawerBadges();
      scheduleAnalyze();
    });

    ["fp-cr", "fp-oh", "fp-bend-r", "fp-micro", "fp-wg"].forEach((id) => {
      $(id).addEventListener("input", () => {
        $("fiber-preset").value = "custom";
        updateDrawerBadges();
        scheduleAnalyze();
      });
    });

    $("rx-overload-enabled").addEventListener("change", (e) => {
      $("rx-overload-wrap").hidden = !e.target.checked;
      updateDrawerBadges();
      scheduleAnalyze(0);
    });

    $("amp-sat-enabled").addEventListener("change", (e) => {
      $("amp-sat-wrap").hidden = !e.target.checked;
      updateDrawerBadges();
      scheduleAnalyze(0);
    });

    $("reel-length").addEventListener("input", () => {
      $("reel-length-mirror").value = `${$("reel-length").value} km`;
      scheduleAnalyze();
    });

    $("num-amps").addEventListener("input", () => {
      updateDrawerBadges();
      scheduleAnalyze();
    });

    document.querySelectorAll("[data-splice-mode]").forEach((btn) => {
      btn.addEventListener("click", () => setSpliceMode(btn.dataset.spliceMode));
    });
    document.querySelectorAll("[data-splitter-mode]").forEach((btn) => {
      btn.addEventListener("click", () => setSplitterMode(btn.dataset.splitterMode));
    });

    const customBound = new Set([
      "wavelength-nm", "fiber-preset", "alpha-override-enabled", "alpha-override-val",
      "fp-cr", "fp-oh", "fp-bend-r", "fp-micro", "fp-wg",
      "rx-overload-enabled", "amp-sat-enabled", "reel-length", "reel-length-mirror",
      "num-amps", "design-target-length",
    ]);
    document.querySelectorAll(".control-rail input, .control-rail select").forEach((el) => {
      if (customBound.has(el.id)) return;
      el.addEventListener("input", () => scheduleAnalyze());
      el.addEventListener("change", () => scheduleAnalyze(0));
    });

    // Validation modal
    $("btn-validate").addEventListener("click", openValidationModal);
    $("btn-close-modal").addEventListener("click", () => { $("validate-modal").hidden = true; });
    $("validate-modal").addEventListener("click", (e) => {
      if (e.target === $("validate-modal")) $("validate-modal").hidden = true;
    });
    document.querySelectorAll("[data-load-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        $("validate-modal").hidden = true;
        loadPresetById(btn.dataset.loadPreset);
      });
    });

    // Export dropdown
    const menu = $("export-menu");
    const toggleBtn = $("btn-export-toggle");
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      toggleBtn.setAttribute("aria-expanded", String(willOpen));
    });
    document.addEventListener("click", () => {
      menu.hidden = true;
      toggleBtn.setAttribute("aria-expanded", "false");
    });

    $("export-csv").addEventListener("click", exportBudgetCSV);
    $("export-json").addEventListener("click", exportConfigJSON);
    $("export-svg").addEventListener("click", () => exportChartSVG("chart-power-level", "power_level_diagram.svg"));
    $("export-png").addEventListener("click", () => exportChartPNG("chart-power-level", "power_level_diagram.png"));
    $("export-print").addEventListener("click", () => window.print());

    document.querySelectorAll("[data-export-chart]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cid = btn.dataset.exportChart;
        exportChartSVG(cid, `${cid.replace(/^chart-/, "")}.svg`);
      });
    });

    // Toast hover pause & dismiss
    const toast = $("toast");
    toast.addEventListener("mouseenter", () => { state.toastHovered = true; });
    toast.addEventListener("mouseleave", () => {
      state.toastHovered = false;
      clearTimeout(state.toastTimer);
      state.toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
    });
    $("toast-close").addEventListener("click", () => {
      clearTimeout(state.toastTimer);
      toast.hidden = true;
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $("validate-modal").hidden = true;
        menu.hidden = true;
        toggleBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  async function init() {
    $("design-controls").hidden = true;
    $("design-result-bar").hidden = true;
    $("verdict-quickfix").hidden = true;
    setActiveViewTab("loss");

    bindEvents();
    try {
      const data = await apiFetch("/api/presets");
      state.presets = data.presets || [];
      state.fiberPresets = data.fiber_presets || {};

      const sel = $("preset-select");
      sel.innerHTML = state.presets
        .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
        .join("");

      const defaultId = state.presets.some((p) => p.id === "longhaul_1550_amplified")
        ? "longhaul_1550_amplified"
        : state.presets[0]?.id;
      if (defaultId) {
        sel.value = defaultId;
        const found = state.presets.find((p) => p.id === defaultId);
        writeConfigToUI(found.config, { autoManageDrawers: true });
      }
      await runAnalyze();
    } catch (err) {
      showError(`Failed to initialize optical workstation: ${err.message}`);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
