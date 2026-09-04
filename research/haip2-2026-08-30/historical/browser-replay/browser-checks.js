async (page) => {
  const frames = page.frames();
  const inner = frames.find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame());
  if (!inner) throw new Error("No inner app frame");
  const mainProbe = await page.evaluate(() => window.probe);
  const proxy = inner.parentFrame();
  const sandbox = await proxy.evaluate(() => document.querySelector("iframe").getAttribute("sandbox"));
  const readout = await inner.evaluate(async () => {
    const throwsSecurity = fn => { try { fn(); return false; } catch (error) { return error.name === "SecurityError"; } };
    const result = {
      origin:self.origin,url:location.href,title:document.querySelector("h1")?.textContent,
      body:document.body.innerText,
      localStorageDenied:throwsSecurity(()=>localStorage.getItem("haip-probe")),
      cookiesDenied:throwsSecurity(()=>document.cookie),
      parentDocumentDenied:throwsSecurity(()=>parent.document.body),
      topDocumentDenied:throwsSecurity(()=>top.document.body),
      resourcesBeforeProbe:performance.getEntriesByType("resource").map(r=>r.name)
    };
    const violations=[];
    document.addEventListener("securitypolicyviolation", e=>violations.push({directive:e.effectiveDirective,blocked:e.blockedURI}),{once:true});
    try { await fetch("https://haip-blocked.invalid/probe"); result.networkDenied=false; }
    catch { result.networkDenied=true; }
    await new Promise(r=>setTimeout(r,20));
    result.violations=violations;
    return result;
  });
  const checks = [
    ["two iframe boundaries",frames.length===3],
    ["separate host and proxy origins",proxy.url().split("/").slice(0,3).join("/")!==page.url().split("/").slice(0,3).join("/")],
    ["scripts-only inner sandbox",sandbox==="allow-scripts"],
    ["opaque inner origin",readout.origin==="null"],
    ["inner source is stored srcdoc",readout.url==="about:srcdoc"],
    ["Plan Review visible",readout.title==="Plan Review"],
    ["flow view rendered",readout.body.includes("Clean · 2 steps analyzed")],
    ["single app initialisation",mainProbe.initialised===1],
    ["one tool input",mainProbe.inputCount===1],
    ["one tool result",mainProbe.resultCount===1],
    ["no tool or live-resource requests",mainProbe.forbiddenCalls.length===0],
    ["no host-reported runtime errors",mainProbe.errors.length===0],
    ["cookies inaccessible",readout.cookiesDenied],
    ["localStorage inaccessible",readout.localStorageDenied],
    ["parent DOM inaccessible",readout.parentDocumentDenied],
    ["top DOM inaccessible",readout.topDocumentDenied],
    ["no inner network resources loaded",readout.resourcesBeforeProbe.length===0],
    ["fetch denied by CSP",readout.networkDenied&&readout.violations.some(v=>v.directive==="connect-src")]
  ].map(([name,passed])=>({name,passed}));
  const record={mode:mainProbe.mode,checks,passed:checks.filter(c=>c.passed).length,total:checks.length,mainProbe,readout};
  await page.evaluate(async record=>{const reply=await fetch("/record",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(record)});if(!reply.ok)throw new Error("Cannot retain browser results");},record);
  return record;
}