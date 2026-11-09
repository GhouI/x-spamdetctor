const D = { apiKey: "", model: "gpt-6-luna", threshold: 0.7, mode: "hide", enabled: true };
const $ = id => document.getElementById(id);
chrome.storage.local.get(Object.keys(D)).then(v => {
  const s = { ...D, ...v };
  for (const k of ["apiKey", "model", "threshold", "mode"]) $(k).value = s[k];
  $("enabled").checked = s.enabled;
});
$("save").onclick = async () => {
  await chrome.storage.local.set({ apiKey: $("apiKey").value.trim(), model: $("model").value.trim() || D.model,
    threshold: parseFloat($("threshold").value) || D.threshold, mode: $("mode").value, enabled: $("enabled").checked });
  $("s").textContent = "Saved — reload X tabs"; 
};
