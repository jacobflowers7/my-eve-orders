// Extracts the inline <script> from index.html and evals it with stubs.
// Usage: const { run, check, summary } = require("./harness");
const fs = require("fs");
const path = require("path");

function extractScript() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const m = html.match(/^<script>\n([\s\S]*?)\n<\/script>/m);
  if (!m) throw new Error("inline <script> not found");
  return m[1];
}

function el() {
  return { value: "", style: {}, classList: { add() {}, remove() {}, toggle() {} },
           textContent: "", innerHTML: "", title: "", options: [], placeholder: "" };
}

function stubs(overrides = {}) {
  const store = overrides.store ?? {};
  return {
    fetch: overrides.fetch ?? (async () => ({ ok: false, json: async () => null, headers: { get: () => "1" } })),
    localStorage: overrides.localStorage ?? {
      getItem: k => store[k] ?? null,
      setItem: (k, v) => { store[k] = v; },
      removeItem: k => { delete store[k]; },
    },
    document: overrides.document ?? { getElementById: () => el(), querySelectorAll: () => [], title: "" },
    window: overrides.window ?? { crypto: globalThis.crypto },
    location: overrides.location ?? { protocol: "http:", origin: "http://localhost:8741", pathname: "/", search: "" },
    history: overrides.history ?? { replaceState() {} },
    store,
  };
}

async function run(body, overrides = {}) {
  const s = stubs(overrides);
  const fn = new Function("fetch", "localStorage", "document", "window", "location", "history",
    extractScript() + `\nreturn (async () => { ${body} })();`);
  return fn(s.fetch, s.localStorage, s.document, s.window, s.location, s.history);
}

let failures = 0;
function check(label, ok) {
  if (!ok) { failures++; console.log("FAIL " + label); } else console.log("ok   " + label);
}
function summary(name) {
  console.log(failures === 0 ? `${name}: ALL PASSED` : `${name}: ${failures} FAILURE(S)`);
  process.exit(failures ? 1 : 0);
}

module.exports = { run, check, summary, stubs };
