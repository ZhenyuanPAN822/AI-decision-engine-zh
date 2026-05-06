"""
Decision Framework Server
- Serves index.html (light theme, API-powered)
- POST /save         → writes JSON to input/
- GET  /load         → reads JSON from input/
- POST /api/generate → proxies LLM API calls (OpenAI, DeepSeek, Gemini, Claude, Custom)
- POST /api/simulate → runs the deterministic Monte Carlo simulator (simulator.py)

Run:  python server.py
Open: http://localhost:3456
"""

import json
import os
import ssl
import time
import traceback
from datetime import datetime
import urllib.error
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse

import simulator

PORT = 3456
BASE = Path(__file__).parent
INPUT_DIR = BASE / "input"
INPUT_DIR.mkdir(exist_ok=True)

ssl_ctx = ssl.create_default_context()

OPENAI_COMPAT_ENDPOINTS = {
    "openai": "https://api.openai.com/v1/chat/completions",
    "deepseek": "https://api.deepseek.com/chat/completions",
}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        "": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE), **kwargs)

    # ── POST ──────────────────────────────────────────────
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)

        if self.path == "/save":
            body = json.loads(raw)
            filename = body.get("file", "")
            data = body.get("data", {})
            if not filename or ".." in filename:
                return self._json(400, {"error": "bad filename"})
            target = INPUT_DIR / filename
            target.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(f"[save] {target}")
            return self._json(200, {"ok": True, "path": str(target)})

        if self.path == "/api/generate":
            body = json.loads(raw)
            try:
                content = self._proxy_api(body)
                return self._json(200, {"ok": True, "content": content})
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8", errors="replace")
                print(f"[api HTTP {e.code}] {err_body[:500]}")
                return self._json(e.code, {"error": f"API error {e.code}: {err_body[:300]}"})
            except Exception as e:
                print(f"[api error] {traceback.format_exc()}")
                return self._json(500, {"error": str(e)})

        if self.path == "/api/simulate":
            try:
                spec = json.loads(raw)
            except Exception as e:
                return self._json(400, {"ok": False, "error": f"invalid JSON: {e}"})
            try:
                result = simulator.simulate(spec)
                print(f"[sim] options={spec.get('options')} ranking={result['ranking']} "
                      f"stability={result['ranking_stability']} elapsed={result['elapsed_sec']}s")
                return self._json(200, result)
            except simulator.SpecError as e:
                errs = e.args[0] if e.args else [str(e)]
                if not isinstance(errs, list):
                    errs = [str(errs)]
                print(f"[sim invalid] {len(errs)} validation errors")
                return self._json(400, {"ok": False, "error": "sim_spec validation failed", "errors": errs})
            except Exception as e:
                print(f"[sim error] {traceback.format_exc()}")
                return self._json(500, {"ok": False, "error": str(e)})

        self._json(404, {"error": "not found"})

    # ── API Proxy ─────────────────────────────────────────
    def _proxy_api(self, body):
        provider = body.get("provider", "")
        api_key = body.get("api_key", "")
        model = body.get("model", "")
        messages = body.get("messages", [])
        max_tokens = body.get("max_tokens", 4096)
        endpoint = body.get("endpoint", "")

        if not api_key:
            raise ValueError("API key is required")

        if provider in ("openai", "deepseek"):
            url = OPENAI_COMPAT_ENDPOINTS[provider]
            return self._call_openai_compat(url, api_key, model, messages, max_tokens)
        elif provider == "custom":
            if not endpoint:
                raise ValueError("Custom endpoint URL is required")
            return self._call_openai_compat(endpoint, api_key, model, messages, max_tokens)
        elif provider == "gemini":
            return self._call_gemini(api_key, model, messages, max_tokens)
        elif provider == "anthropic":
            return self._call_anthropic(api_key, model, messages, max_tokens)
        else:
            raise ValueError(f"Unknown provider: {provider}")

    def _call_openai_compat(self, url, key, model, messages, max_tokens=4096):
        payload = json.dumps(
            {"model": model, "messages": messages, "temperature": 0.7, "max_tokens": max_tokens}
        ).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
            },
        )
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=180) as resp:
            result = json.loads(resp.read())
        return result["choices"][0]["message"]["content"]

    def _call_gemini(self, key, model, messages, max_tokens=4096):
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/"
            f"models/{model}:generateContent?key={key}"
        )
        # Convert chat messages to Gemini format
        contents = []
        system_text = ""
        for m in messages:
            if m["role"] == "system":
                system_text = m["content"]
            else:
                role = "user" if m["role"] == "user" else "model"
                contents.append({"role": role, "parts": [{"text": m["content"]}]})
        # Prepend system instruction to first user message if present
        if system_text and contents:
            contents[0]["parts"][0]["text"] = (
                system_text + "\n\n" + contents[0]["parts"][0]["text"]
            )
        gen_config = {"maxOutputTokens": max_tokens}
        payload = json.dumps({"contents": contents, "generationConfig": gen_config}).encode("utf-8")
        req = urllib.request.Request(
            url, data=payload, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=180) as resp:
            result = json.loads(resp.read())
        return result["candidates"][0]["content"]["parts"][0]["text"]

    def _call_anthropic(self, key, model, messages, max_tokens=4096):
        system = ""
        chat = []
        for m in messages:
            if m["role"] == "system":
                system = m["content"]
            else:
                chat.append({"role": m["role"], "content": m["content"]})
        body = {"model": model, "max_tokens": max_tokens, "messages": chat}
        if system:
            body["system"] = system
        payload = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
            },
        )
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=180) as resp:
            result = json.loads(resp.read())
        return result["content"][0]["text"]

    # ── GET ───────────────────────────────────────────────
    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/load":
            params = parse_qs(parsed.query)
            filename = params.get("file", [""])[0]
            if not filename or ".." in filename:
                return self._json(400, {"error": "bad filename"})
            target = INPUT_DIR / filename
            if not target.exists():
                return self._json(404, {"exists": False})
            data = json.loads(target.read_text(encoding="utf-8"))
            return self._json(200, {"exists": True, "data": data})

        if parsed.path == "/health":
            now = datetime.now()
            return self._json(200, {
                "ok": True,
                "server_time": now.isoformat(),
                "date": now.strftime("%Y-%m-%d"),
                "time": now.strftime("%H:%M:%S")
            })

        # Static files
        super().do_GET()

    # ── Helpers ───────────────────────────────────────────
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, fmt, *args):
        msg = fmt % args
        print(f"[server] {msg}")


class ThreadedServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"╔══════════════════════════════════════════╗")
    print(f"║  Decision Framework Server               ║")
    print(f"║  http://localhost:{PORT}                   ║")
    print(f"╚══════════════════════════════════════════╝")
    print(f"Input directory: {INPUT_DIR}")
    ThreadedServer(("", PORT), Handler).serve_forever()
