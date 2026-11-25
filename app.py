"""
================================================================================
app.py — Zero-Dependency Local HTTP API & Static Server for Optical Link Tool
================================================================================
Course:        26ECE31H — Fiber Optic Communications (BUE)
Project:       Option 2 — Attenuation and Link Power Budget Tool (Group 9)

Dependencies:  Python 3 Standard Library ONLY + local `physics_engine.py` and
               `validate_agrawal.py` (no Flask, FastAPI, or Streamlit required).

Usage:
    py -3.13 app.py                # Starts server & auto-opens browser
    py -3.13 app.py --port 8080    # Specify preferred port (auto-fallback if busy)
    py -3.13 app.py --no-browser   # Headless mode (for automated testing)

API Endpoints:
    GET  /                  -> Serves web/index.html
    GET  /<asset>           -> Serves static assets from web/
    GET  /api/presets       -> Built-in link presets & fiber presets
    POST /api/analyze       -> Evaluates link budget, attenuation spectrum & margin sweep
    POST /api/design        -> Runs Design Mode solver (max_reach | required_amplifiers)
    GET  /api/validate      -> Executes live Agrawal 5th Ed. validation benchmark suite
    POST /api/validate      -> Same as GET /api/validate
================================================================================
"""

from __future__ import annotations

import argparse
import copy
import json
import mimetypes
import socket
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Tuple
from urllib.parse import urlparse

from physics_engine import (
    FIBER_PRESETS,
    LinkConfig,
    compute_attenuation_spectrum,
    compute_margin_vs_length,
    evaluate_link_budget,
    list_presets_serialized,
    solve_max_reach,
    solve_required_amplifiers,
)
from validate_agrawal import run_all_validations

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"

# Ensure consistent MIME types on Windows registries
mimetypes.add_type("application/javascript; charset=utf-8", ".js")
mimetypes.add_type("text/css; charset=utf-8", ".css")
mimetypes.add_type("text/html; charset=utf-8", ".html")
mimetypes.add_type("image/svg+xml", ".svg")


def _find_available_port(host: str, preferred_port: int) -> int:
    """Return `preferred_port` if free, otherwise scan upward or ask OS for a free port."""
    for port in range(preferred_port, preferred_port + 25):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


class OpticalLinkRequestHandler(BaseHTTPRequestHandler):
    """HTTP handler serving the custom web/ UI and physics JSON API."""

    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        """Concise server log output (suppressed during quiet mode if configured)."""
        if getattr(self.server, "quiet", False):
            return
        sys.stderr.write(f"[optical-bench] {self.address_string()} - {format % args}\n")

    def _send_json(self, payload: Dict[str, Any], status: int = HTTPStatus.OK) -> None:
        raw = json.dumps(payload, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _send_bytes(self, content: bytes, content_type: str, status: int = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def _read_json_body(self) -> Dict[str, Any]:
        length_header = self.headers.get("Content-Length")
        if not length_header:
            return {}
        length = int(length_header)
        if length <= 0:
            return {}
        if length > 2 * 1024 * 1024:
            raise ValueError("Request body exceeds 2 MB limit.")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON request payload must be an object.")
        return data

    def _serve_static(self, url_path: str) -> None:
        rel = "index.html" if url_path in ("", "/") else url_path.lstrip("/")
        try:
            candidate = (WEB_DIR / rel).resolve()
            candidate.relative_to(WEB_DIR.resolve())
        except Exception:
            self._send_json({"error": "Forbidden path."}, HTTPStatus.FORBIDDEN)
            return

        if not candidate.is_file():
            self._send_json({"error": f"Static resource not found: /{rel}"}, HTTPStatus.NOT_FOUND)
            return

        mime, _ = mimetypes.guess_type(str(candidate))
        content_type = mime or "application/octet-stream"
        self._send_bytes(candidate.read_bytes(), content_type, HTTPStatus.OK)

    def _handle_presets(self) -> None:
        fiber_presets_dict = {key: fp.to_dict() for key, fp in FIBER_PRESETS.items()}
        self._send_json({
            "presets": list_presets_serialized(),
            "fiber_presets": fiber_presets_dict,
        })

    def _handle_validate(self) -> None:
        report = run_all_validations(tolerance_pct=0.1)
        self._send_json(report)

    def _handle_analyze(self) -> None:
        body = self._read_json_body()
        cfg_data = body.get("config", body)
        cfg = LinkConfig.from_dict(cfg_data)
        cfg.validate()

        budget = evaluate_link_budget(cfg)
        spectrum = compute_attenuation_spectrum(fiber_params=cfg.fiber_params)
        margin_sweep = compute_margin_vs_length(
            cfg,
            wavelengths_nm=(850.0, 1310.0, 1550.0),
            num_points=181,
            ignore_alpha_override=True,
        )

        self._send_json({
            "config": cfg.to_dict(),
            "budget": budget.to_dict(),
            "spectrum": spectrum,
            "margin_sweep": margin_sweep,
        })

    def _handle_design(self) -> None:
        body = self._read_json_body()
        mode = str(body.get("mode", "max_reach")).strip().lower()
        cfg_data = body.get("config")
        if not isinstance(cfg_data, dict):
            raise ValueError("Design request must include a 'config' object.")

        cfg = LinkConfig.from_dict(cfg_data)
        cfg.validate()

        if mode == "max_reach":
            solution = solve_max_reach(cfg)
            solved_cfg = copy.deepcopy(cfg)
            solved_cfg.fiber_length_km = solution.solved_max_reach_km or 0.0
        elif mode == "required_amplifiers":
            target_len = body.get("target_length_km", cfg.fiber_length_km)
            target_len_f = float(target_len)
            if target_len_f < 0.0:
                raise ValueError("target_length_km cannot be negative.")
            solution = solve_required_amplifiers(cfg, target_length_km=target_len_f)
            solved_cfg = copy.deepcopy(cfg)
            solved_cfg.fiber_length_km = target_len_f
            if solution.solved_num_amplifiers is not None:
                solved_cfg.num_amplifiers = solution.solved_num_amplifiers
        else:
            raise ValueError("Design mode must be 'max_reach' or 'required_amplifiers'.")

        spectrum = compute_attenuation_spectrum(fiber_params=solved_cfg.fiber_params)
        margin_sweep = compute_margin_vs_length(
            solved_cfg,
            wavelengths_nm=(850.0, 1310.0, 1550.0),
            num_points=181,
            ignore_alpha_override=True,
        )

        self._send_json({
            "mode": mode,
            "solution": solution.to_dict(),
            "solved_config": solved_cfg.to_dict(),
            "spectrum": spectrum,
            "margin_sweep": margin_sweep,
        })

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/presets":
                self._handle_presets()
            elif path == "/api/validate":
                self._handle_validate()
            elif path == "/api/health":
                self._send_json({"status": "ok"})
            else:
                self._serve_static(path)
        except (ValueError, KeyError, TypeError) as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._send_json({"error": f"Internal server error: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/analyze":
                self._handle_analyze()
            elif path == "/api/design":
                self._handle_design()
            elif path == "/api/validate":
                self._handle_validate()
            else:
                self._send_json({"error": f"Unknown API endpoint: {path}"}, HTTPStatus.NOT_FOUND)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._send_json({"error": f"Internal server error: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def create_server(host: str = "127.0.0.1", preferred_port: int = 8080, quiet: bool = False) -> Tuple[ThreadingHTTPServer, int]:
    """Instantiate the multithreaded local HTTP server on an available port."""
    port = _find_available_port(host, preferred_port)
    server = ThreadingHTTPServer((host, port), OpticalLinkRequestHandler)
    server.daemon_threads = True
    server.quiet = quiet  # type: ignore[attr-defined]
    return server, port


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Option 2: Optical Fiber Attenuation & Link Power Budget Tool (Local Web GUI)"
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080, help="Preferred port (default: 8080)")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open the web browser")
    parser.add_argument("--quiet", action="store_true", help="Suppress HTTP access logs")
    args = parser.parse_args()

    if not (WEB_DIR / "index.html").is_file():
        print(f"ERROR: Could not find GUI assets at {WEB_DIR}", file=sys.stderr)
        return 1

    server, port = create_server(host=args.host, preferred_port=args.port, quiet=args.quiet)
    url = f"http://{args.host}:{port}/"

    print("=" * 74)
    print("  Optical Link Power Budget & Attenuation Analyzer — 26ECE31H (Group 9)")
    print(f"  Local workstation URL: {url}")
    print("  Press Ctrl+C to stop the local server.")
    print("=" * 74)

    if not args.no_browser:
        def _open_browser() -> None:
            time.sleep(0.45)
            webbrowser.open(url)
        threading.Thread(target=_open_browser, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down local optical workstation server.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
