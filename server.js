#!/usr/bin/env node
// Local backend for the After-Hours Ticker Dashboard.
//
// Holds FIRECRAWL_API_KEY server-side and scrapes Yahoo Finance's chart
// endpoint through Firecrawl on the dashboard's behalf, so the browser
// never sees the key and never hits Yahoo's CORS wall directly.
//
// Usage:
//   FIRECRAWL_API_KEY=fc-xxxxxxxx node server.js
//   then open http://localhost:8000
//
// The dashboard (index.html) still works without this running — it falls
// back to a chain of public CORS proxies — but responses are faster and
// more reliable through here.

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// Minimal .env loader (no dependency) — only fills in vars not already set in the environment.
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 8000;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "";
const FIRECRAWL_ENDPOINTS = [
  "https://api.firecrawl.dev/v1/scrape",
  "https://api.firecrawl.dev/v2/scrape"
];

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,15}$/;
const CACHE_TTL_MS = 20000;
const cache = new Map(); // key -> { expires, body }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function extractJsonPayload(container) {
  const raw = container.rawHtml || container.html || container.markdown || "";
  try {
    return JSON.parse(raw);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* fall through */ }
    }
    throw new Error("Firecrawl response did not contain parseable JSON");
  }
}

async function firecrawlScrape(targetUrl) {
  let lastErr = null;
  for (const endpoint of FIRECRAWL_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + FIRECRAWL_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: targetUrl, formats: ["rawHtml"] }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) { lastErr = new Error(endpoint + " -> HTTP " + res.status + ": " + text.slice(0, 200)); continue; }
      let outer;
      try { outer = JSON.parse(text); } catch (e) { lastErr = new Error(endpoint + " returned non-JSON response"); continue; }
      const container = outer.data || outer;
      return extractJsonPayload(container);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr || new Error("all Firecrawl endpoints failed");
}

async function handleQuote(req, res, query) {
  if (!FIRECRAWL_API_KEY) {
    sendJson(res, 500, { error: "FIRECRAWL_API_KEY is not set on the server. Start with: FIRECRAWL_API_KEY=fc-... node server.js" });
    return;
  }
  const symbol = (query.get("symbol") || "").toUpperCase();
  const period1 = parseInt(query.get("period1"), 10);
  const period2 = parseInt(query.get("period2"), 10);
  if (!SYMBOL_RE.test(symbol) || !Number.isFinite(period1) || !Number.isFinite(period2)) {
    sendJson(res, 400, { error: "invalid symbol/period1/period2" });
    return;
  }

  const cacheKey = symbol + "|" + period1 + "|" + period2;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    sendJson(res, 200, cached.body);
    return;
  }

  const targetUrl = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) +
    "?interval=5m&includePrePost=true&period1=" + period1 + "&period2=" + period2;

  try {
    const yahooJson = await firecrawlScrape(targetUrl);
    if (!yahooJson || !yahooJson.chart) throw new Error("unexpected payload shape from Firecrawl scrape");
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, body: yahooJson });
    sendJson(res, 200, yahooJson);
  } catch (e) {
    sendJson(res, 502, { error: "Firecrawl scrape failed: " + (e && e.message ? e.message : String(e)) });
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

function serveStatic(req, res) {
  const reqPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(__dirname, path.normalize(reqPath).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(filePath, (err, data) => {
    if (err) { sendJson(res, 404, { error: "not found" }); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/quote") {
    handleQuote(req, res, url.searchParams).catch((e) => sendJson(res, 500, { error: String(e) }));
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  if (!FIRECRAWL_API_KEY) {
    console.warn("Warning: FIRECRAWL_API_KEY is not set — /api/quote will return 500 until it is.");
    console.warn("Run as: FIRECRAWL_API_KEY=fc-xxxxxxxx node server.js");
  }
  console.log("After-Hours Ticker Dashboard running at http://localhost:" + PORT);
});
