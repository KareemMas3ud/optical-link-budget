================================================================================
Option 2: Optical Fiber Attenuation & Link Power Budget Tool
================================================================================
Course:        26ECE31H - Fiber Optic Communications (The British University in Egypt)
Module Leader: Dr. Tamer Mekkawy
Group:         Group 9 - Kareem Mohammed (238253) & Rawan Essam (235067)
Reference:     Govind P. Agrawal, "Fiber-Optic Communication Systems," 5th Ed. (2021)

--------------------------------------------------------------------------------
1. Requirements
--------------------------------------------------------------------------------
- Python 3.10+ (tested on Python 3.13)
- NumPy (`py -m pip install numpy`) - required for physics engine & GUI
- Matplotlib (`py -m pip install matplotlib`) - only needed to regenerate
  the 300 DPI report figures (`generate_report_figures.py`)
- No commercial libraries, no Streamlit/Flask, and no internet connection needed.

--------------------------------------------------------------------------------
2. Launching the Interactive Web GUI
--------------------------------------------------------------------------------
Option A (One-click on Windows):
    Double-click `Run_Optical_Link_Tool.bat`

Option B (Command line):
    py app.py
    (or: py -3.13 app.py)

This starts a local zero-dependency HTTP server on http://127.0.0.1:8080/
(automatically selecting a free port if 8080 is busy) and opens the optical
workstation in your default browser. Press Ctrl+C in the console to stop.

Optional flags:
    py app.py --port 8080      Specify preferred port
    py app.py --no-browser     Start without auto-opening a browser tab

--------------------------------------------------------------------------------
3. Running Automated Textbook Validation (Agrawal 5th Ed.)
--------------------------------------------------------------------------------
    py validate_agrawal.py

Verifies `physics_engine.py` against four textbook benchmarks to < 0.1% error:
  - Ch. 5, Sec. 5.2.3, Table 5.1 (pp. 158-159): 0.85 um Laser+PIN, LED+PIN, LED+APD
  - Ch. 5, Problem 5.4 (pp. 179-180): 1.3 um LED link with 2 km cable-reel splices
  - Ch. 2, Sec. 2.5.3 Eq. (2.5.4) & Sec. 2.5.4 (p. 48): Rayleigh scattering & bending
  - Ch. 7, Sec. 7.1.2 (p. 237): Periodic lumped amplification (Design Mode solver)

(You can also run the same live validation suite inside the GUI via the
"Verify Agrawal 5e" button in the top bar.)

--------------------------------------------------------------------------------
4. Regenerating 300 DPI Report Figures
--------------------------------------------------------------------------------
    py generate_report_figures.py

Saves five 300 DPI publication-grade PNG figures to `report_figures/`:
  - fig0_attenuation_spectrum.png  (800-1700 nm decomposed silica attenuation)
  - fig1_power_level_diagram.png   (Power-level diagram P(z) with drops & EDFA jumps)
  - fig2_loss_breakdown.png        (Link loss breakdown & attenuation mechanism share)
  - fig3_margin_vs_length.png      (Net margin vs. length for 850 / 1310 / 1550 nm)
  - fig4_agrawal_validation.png    (Agrawal 5e Table 5.1 worked example validation)

--------------------------------------------------------------------------------
5. Project File Structure
--------------------------------------------------------------------------------
  Run_Optical_Link_Tool.bat    One-click Windows launcher
  README.txt                   Quick-start and usage guide (this file)
  app.py                       Zero-dependency Python HTTP API & static server
  physics_engine.py            Core optical physics & Design Mode solvers (NumPy)
  validate_agrawal.py          Automated Agrawal 5th Ed. verification suite
  generate_report_figures.py   300 DPI Matplotlib report figure generator
  web/                         Offline HTML5/CSS/JS GUI (index.html, styles.css, app.js)
  report_figures/              Generated 300 DPI PNG figures for the report
