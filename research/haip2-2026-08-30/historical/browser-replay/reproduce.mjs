import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(process.argv[2] || process.cwd());
const require = createRequire(resolve(workspace, "apps/mcp-ui-host/package.json"));
const esbuild = require("esbuild");
const read = name => readFileSync(resolve(here, name), "utf8");
const sha = text => createHash("sha256").update(text).digest("hex");
const html = read("plasm-plan.html");
const fixture = JSON.parse(read("plasm-dry-run.json"));
const originalProxy = read("upstream-sandbox.ts");
const oldBlock = `        // Use document.write instead of srcdoc (which the CesiumJS Map won't work with)
        const doc = inner.contentDocument || inner.contentWindow?.document;
        if (doc) {
          doc.open();
          doc.write(html);
          doc.close();
        } else {
          // Fallback to srcdoc if document is not accessible
          console.warn("[Sandbox] document.write not available, falling back to srcdoc");
          inner.srcdoc = html;
        }`;
for (const required of ['"allow-scripts allow-same-origin allow-forms"', 'event.origin !== OWN_ORIGIN', oldBlock]) {
  if (!originalProxy.includes(required)) throw new Error("Pinned upstream source does not match expected adaptation");
}
const proxySource = originalProxy
  .replace('"allow-scripts allow-same-origin allow-forms"', '"allow-scripts"')
  .replace('event.origin !== OWN_ORIGIN', 'event.origin !== "null"')
  .replace('        OWN_ORIGIN\n', '        "null"\n')
  .replace(oldBlock, '        inner.srcdoc = html;');
writeFileSync(resolve(here, "adapted-sandbox.ts"), proxySource);
const build = async source => (await esbuild.build({stdin:{contents:source,resolveDir:resolve(workspace,"apps/mcp-ui-host"),loader:"ts"},bundle:true,format:"iife",platform:"browser",write:false})).outputFiles[0].text;
const proxyJs = await build(proxySource);
const hostJs = await build(`import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
(async () => {
const probe = window.probe = {forbiddenCalls:[], handshake:[], inputCount:0, resultCount:0, initialised:0, errors:[]};
window.addEventListener("error", e => probe.errors.push(String(e.message)));
const config = await (await fetch("/config")).json();
const mode = new URLSearchParams(location.search).get("mode") || "legacy";
probe.mode = mode;
const result = await (await fetch("/fixture?mode="+mode)).json();
const html = await (await fetch("/bundle")).text();
const iframe = document.createElement("iframe");
iframe.id = "sandbox";
iframe.style = "width:100%;height:100vh;border:0";
iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
iframe.src = config.proxyOrigin;
document.body.appendChild(iframe);
window.addEventListener("message", e => {
  if (e.source === iframe.contentWindow && e.origin === config.proxyOrigin) {
    probe.handshake.push({method:e.data?.method || null, id:e.data?.id ?? null});
  }
});
const bridge = new AppBridge(null, {name:"HAIP isolated review experiment",version:"0.0.1"}, {logging:{}});
bridge.oncalltool = async p => { probe.forbiddenCalls.push({kind:"tool",name:p.name}); throw new Error("No tools in this experiment"); };
bridge.onreadresource = async p => { probe.forbiddenCalls.push({kind:"resource",uri:p.uri}); throw new Error("No live resources in this experiment"); };
bridge.onsandboxready = async () => { await bridge.sendSandboxResourceReady({html,sandbox:"allow-scripts"}); };
bridge.oninitialized = async () => {
  probe.initialised++;
  await bridge.sendToolInput({arguments:{logical_session_ref:result._meta.plasm.logical_session_ref,program:"items = e1; return items"}});
  probe.inputCount++;
  await bridge.sendToolResult(result);
  probe.resultCount++;
};
bridge.onerror = e => probe.errors.push(String(e));
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
})();`);
writeFileSync(resolve(here, "host.js"), hostJs);
writeFileSync(resolve(here, "sandbox.js"), proxyJs);
const requests = [];
let hostOrigin;
const proxy = createServer((req,res) => {
  requests.push({origin:"sandbox",method:req.method,url:req.url});
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy",`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src about:; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors ${hostOrigin}`);
  res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()");
  res.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}</style><body><script>${proxyJs.replaceAll("</script", "<\\/script")}</script>`);
});
await new Promise(r=>proxy.listen(0,"127.0.0.1",r));
const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
const records = [];
const host = createServer(async (req,res) => {
  requests.push({origin:"host",method:req.method,url:req.url});
  const url = new URL(req.url,"http://localhost");
  res.setHeader("Cache-Control","no-store");
  if (url.pathname === "/host.js") { res.setHeader("Content-Type","text/javascript"); res.end(hostJs); }
  else if (url.pathname === "/config") {res.setHeader("Content-Type","application/json");res.end(JSON.stringify({proxyOrigin}));}
  else if (url.pathname === "/favicon.ico") {res.writeHead(204);res.end();}
  else if (url.pathname === "/bundle") {res.setHeader("Content-Type","text/html");res.end(html);}
  else if (url.pathname === "/fixture") {
    const selected = structuredClone(fixture);
    if (url.searchParams.get("mode") === "current") {
      const content = selected._meta.ui.plasm;
      selected.structuredContent.ui = {kind:"plan_review",...content};
      delete selected._meta.ui.plasm;
      delete selected.structuredContent.plasm.comp;
      delete selected.structuredContent.plasm.plan_ux_reflection;
    }
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify(selected));
  }
  else if (url.pathname === "/record" && req.method === "POST") {
    let body=""; for await (const piece of req) {body+=piece; if(body.length>1024*1024){res.writeHead(413);res.end();return;}}
    records.push(JSON.parse(body));
    writeFileSync(resolve(here,"browser-results.json"),JSON.stringify({recorded_at:new Date().toISOString(),records,requests},null,2));
    res.setHeader("Content-Type","application/json");res.end("{\"saved\":true}");
  }
  else if (url.pathname === "/") {res.setHeader("Content-Type","text/html");res.end('<!doctype html><meta charset="utf-8"><title>HAIP review replay experiment</title><style>html,body{margin:0;height:100%}</style><script src="/host.js" defer></script>');}
  else {res.writeHead(404);res.end();}
});
await new Promise(r=>host.listen(0,"127.0.0.1",r));
hostOrigin = `http://127.0.0.1:${host.address().port}`;
const manifest = {
  experiment:"HAIP stored Plasm MCP App replay, isolated browser",
  scope:"Feasibility only: two-node read-only fixture; not production host or hostile-bundle conformance",
  upstream_ext_apps:"v1.7.4", ext_apps:JSON.parse(readFileSync(resolve(workspace,"apps/mcp-ui-host/node_modules/@modelcontextprotocol/ext-apps/package.json"))).version,
  sdk:JSON.parse(readFileSync(resolve(workspace,"apps/mcp-ui-host/node_modules/@modelcontextprotocol/sdk/package.json"))).version,
  node:process.version, esbuild:esbuild.version,
  asset_sha256:sha(html),fixture_sha256:sha(read("plasm-dry-run.json")),upstream_proxy_sha256:sha(originalProxy),adapted_proxy_sha256:sha(proxySource),
  proxy_adaptations:["inner sandbox allow-scripts only from creation", "require exact source window and opaque null origin", "use srcdoc unconditionally"],
  hostOrigin,proxyOrigin,started_at:new Date().toISOString()
};
if (manifest.ext_apps !== "1.7.4" || manifest.sdk !== "1.29.0") throw new Error("Dependency pin drift");
writeFileSync(resolve(here,"manifest.json"),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({artefacts:here,hostOrigin,proxyOrigin,asset_sha256:manifest.asset_sha256}));
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal,()=>{host.close();proxy.close();process.exit(0);});
