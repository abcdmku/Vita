// @vita/greeter — a "Vita-packageable UI" module (the SIMPLE convention): export a default mount(root,
// host?) that paints into the provided element. It does NOT import the Vita SDK. When the packager
// bridge hosts it on the new platform, the served host page provides `root` and the puter.js SDK is
// available globally (wired to the api_origin), so this module could call window.puter.* if it wanted.
export default function mount(root, host) {
  const title = (host && host.title) || "Greeter";
  root.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;font-family:Inter,system-ui,sans-serif">' +
    '<div data-greeter-title style="font-size:13px;color:#9aa7b4">' + title + '</div>' +
    '<div data-greeter-hello style="font-size:34px;font-weight:700">Hello from @vita/greeter 👋</div>' +
    '<div style="font-size:11px;color:#6b7682">packaged onto the Vita platform</div>' +
    '</div>';
  return () => { /* cleanup: nothing to tear down */ };
}
