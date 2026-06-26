// Vita CEF OSR host — Milestones M0 + M1 of the CEF live-render arc (ADR-0014).
//
// M0: prove CEF software off-screen rendering (OSR) works on the Borg51 build host:
//   init CEF windowless, load the flagship desktop HTML off-screen at 1280x800,
//   capture the BGRA framebuffer in CefRenderHandler::OnPaint, BGRA->RGBA, write a PNG.
//
// M1: prove CEF's rendered frame flows INTO the Vita native compositor. Instead of
//   (or in addition to) the PNG, emit the compositor's stdin COMMAND stream for the
//   captured frame:
//       registerBufferSurface cef:desktop 1280 720 <hex-rgba>
//       updatePlacement cef:desktop 0 0 1280 720 0 true
//       present
//   The CEF view is 1280x800; the compositor output is 1280x720, so the frame is
//   downscaled 800->720 (vertical box filter, width unchanged) and converted BGRA->RGBA.
//   That stream is piped into `vita-compositor --commands --screenshot <png>`, and the
//   COMPOSITOR (not CEF) does the glReadPixels readback -> PNG. See run-m1.sh.
//
// Software OSR only (no GPU): --disable-gpu / windowless. The accelerated-OSR +
// shared-texture / zero-copy DMABUF path is M2+.

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>

#include "include/base/cef_callback.h"
#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_render_handler.h"
#include "include/cef_resource_handler.h"
#include "include/cef_scheme.h"
#include "include/cef_stream.h"
#include "include/cef_task.h"
#include "include/cef_v8.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_stream_resource_handler.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

namespace {

// Forward decl: the M4 streaming pump (OsrClient::StreamFrameTick, a method defined
// inside the class below) emits frames via this free function, which is defined later.
bool EmitCompositorFrame();
// PSD-500: emit a CHEAP cursor-only present (a bare `present` line) so the compositor repositions
// the top-most cursor surface and re-composites WITHOUT a CEF repaint or a buffer re-upload.
bool EmitCursorPresent();

// --- configuration (CEF view surface) ---
// PSD-500: the CEF view + compositor-output dimensions are RUNTIME-configurable so the live boot
// can render at the REAL display resolution (e.g. 1920x1080) instead of a fixed 1280x720 that
// lands in a corner of a larger VMware virtual display. They default to the historical values and
// are overridden by --view-width/--view-height/--comp-width/--comp-height (set by the boot script
// from the KMS connector mode). Named kWidth/etc. (not constexpr) so the rest of the file is
// unchanged; they are assigned ONCE in main() before CefInitialize and read-only thereafter.
int kWidth = 1280;
int kHeight = 800;
// Compositor output (DESKTOP_DEMO_OUTPUT_*). The CEF view frame is downscaled to this so it fills
// the output exactly (no clip / no letterbox bars). kHeight may exceed kCompHeight (the dock strip);
// the vertical box-filter maps the view rows onto the output rows.
int kCompWidth = 1280;
int kCompHeight = 720;
// How long to keep pumping after main-frame load so lucide.min.js can replace the
// <i data-lucide> placeholders with inlined SVGs and OnPaint can deliver it.
constexpr int kSettleMs = 2500;

std::string g_url;
std::string g_out_png;          // M0: PNG path; empty when in compositor-stream mode.
std::string g_compositor_out;   // M1: command-stream path ("-" = stdout); empty = off.
std::string g_surface_id = "cef:desktop";
// M4: number of frames to stream into the compositor. 1 (default) = M1 one-shot
// (registerBufferSurface + updatePlacement + present, then quit). >1 = the long-lived
// incremental path: register once, then `updateBufferSurface`/`present` per subsequent
// OnPaint, so the compositor composites a sequence and reads back the latest. The
// service uses this so the LIVE (hydrated) desktop — after bootstrap.js runs — is what
// the compositor presents and reads back on the real KMS scanout.
//
// PERSISTENT desktop (spike/cef-vm): --frames=0 means UNBOUNDED — stream frames forever,
// never closing the browser or the compositor sink. The compositor then keeps presenting
// every incoming frame on the KMS scanout indefinitely, so a powered-on VM shows the live
// desktop continuously (not a few-frame flash). The pump only stops when the process is
// signalled (the boot service is killed on shutdown).
int g_frames = 1;
// M4 streaming-mode interval between emitted frames (ms). Spaced so the page paints
// new content (clock, hydration, lucide icons) between captures. Overridable via
// --frame-interval-ms (the persistent service runs a steady cadence so the live clock
// and any hydrated content keep updating on screen).
int g_frame_interval_ms = 350;
// PSD-500 smooth cursor: how many CHEAP cursor-only presents to interleave per real CONTENT frame.
// A content frame = Invalidate(CEF repaint) + downscale + updateBufferSurface (expensive). A cursor
// present = a bare `present` line: the compositor drains input + repositions the top-most cursor
// surface and re-composites the SAME textures (a GPU blit, no texture re-upload, no CEF repaint), so
// source_repaint_count stays flat while the cursor tracks every move. With the default 100ms content
// interval, 6 cursor presents/frame yields a ~16ms (~60fps) cursor cadence. Overridable via
// --cursor-presents-per-frame.
int g_cursor_presents_per_frame = 6;

std::atomic<bool> g_have_frame{false};
std::vector<unsigned char> g_last_frame;  // BGRA, kWidth*kHeight*4
int g_paint_count = 0;

// PSD-055 input: the reverse-channel the compositor writes routed input events to (a FIFO/path).
// osr_host reads it on a background thread and injects the events into CEF on the UI thread.
std::string g_input_in;   // --input-in=<path>; empty = no input wiring.
// The live browser, published for the input thread. Guarded because the input thread reads it
// while the UI thread sets/clears it (OnAfterCreated / OnBeforeClose).
std::mutex g_browser_mu;
CefRefPtr<CefBrowser> g_input_browser;
std::atomic<bool> g_input_stop{false};
// The compositor view is kWidth x kHeight (1280x800); the compositor OUTPUT (and the cursor
// coordinates it reports) is kCompWidth x kCompHeight (1280x720). Pointer coords from the reverse
// channel are in OUTPUT space; map them back into the CEF VIEW's vertical space before SendEvent.
// (Forward decls of the compositor output constants live just below.)

// RenderHandler: CEF calls OnPaint with the dirty BGRA buffer for the whole view.
class OsrRenderHandler : public CefRenderHandler {
 public:
  OsrRenderHandler() = default;

  void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override {
    rect = CefRect(0, 0, kWidth, kHeight);
  }

  void OnPaint(CefRefPtr<CefBrowser> browser,
               PaintElementType type,
               const RectList& dirtyRects,
               const void* buffer,
               int width,
               int height) override {
    if (type != PET_VIEW) return;  // ignore popup paints
    if (width != kWidth || height != kHeight) {
      fprintf(stderr, "[osr] OnPaint size %dx%d (waiting for %dx%d)\n", width,
              height, kWidth, kHeight);
      return;
    }
    g_paint_count++;
    const size_t bytes = static_cast<size_t>(width) * height * 4;
    g_last_frame.assign(static_cast<const unsigned char*>(buffer),
                        static_cast<const unsigned char*>(buffer) + bytes);
    g_have_frame.store(true);
    fprintf(stderr, "[osr] OnPaint #%d %dx%d (%zu bytes)\n", g_paint_count, width,
            height, bytes);
  }

  IMPLEMENT_REFCOUNTING(OsrRenderHandler);
  DISALLOW_COPY_AND_ASSIGN(OsrRenderHandler);
};

// Client: owns the render handler + load tracking; quits the loop after settle.
class OsrClient : public CefClient,
                  public CefLifeSpanHandler,
                  public CefLoadHandler,
                  public CefDisplayHandler {
 public:
  OsrClient() : render_handler_(new OsrRenderHandler()) {}

  CefRefPtr<CefRenderHandler> GetRenderHandler() override {
    return render_handler_;
  }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }

  // Route page console.* to stderr so the desktop bundle's diagnostics (hydration, errors) are
  // visible in CEF_LOG. CEF normally drops these in headless OSR.
  bool OnConsoleMessage(CefRefPtr<CefBrowser> /*browser*/,
                        cef_log_severity_t /*level*/,
                        const CefString& message,
                        const CefString& source,
                        int line) override {
    fprintf(stderr, "[osr] CONSOLE %s @ %s:%d\n",
            message.ToString().c_str(), source.ToString().c_str(), line);
    return false;
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    browser_ = browser;
    // PSD-500: give the windowless browser input focus, otherwise SendMouseClickEvent does not
    // dispatch DOM click events (the renderer treats the OSR view as unfocused). With focus, a real
    // injected mouse down+up produces a DOM click that drives the host-bridge click delegate.
    if (browser->GetHost()) {
      browser->GetHost()->SetFocus(true);
    }
    // PSD-055: publish the browser so the input-reader thread can inject CEF events.
    {
      std::lock_guard<std::mutex> lock(g_browser_mu);
      g_input_browser = browser;
    }
  }

  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int httpStatusCode) override {
    CEF_REQUIRE_UI_THREAD();
    if (!frame->IsMain()) return;
    fprintf(stderr, "[osr] main frame load end (status=%d), settling %dms\n",
            httpStatusCode, kSettleMs);
    // The flagship HTML loads lucide.min.js (a UMD bundle exposing window.lucide)
    // but the icon render is driven by runtime/bootstrap.js. Drive createIcons()
    // ourselves so the <i data-lucide> placeholders become inline SVGs even if
    // bootstrap.js's own pass races us. This also proves CEF executes page JS;
    // bootstrap.js itself still runs (it is a <script type=module>) and hydrates
    // the live desktop — the M4 readback captures that hydrated state.
    frame->ExecuteJavaScript(
        "try{ if(window.lucide&&lucide.createIcons){lucide.createIcons();} }"
        "catch(e){ console.error('lucide',e); }",
        frame->GetURL(), 0);

    // PSD-500 host-bridge self-test: prove the renderer's window.vitaDesktopBridge actually reaches
    // the host proxy + real backends. Call requestFile(list) AND launchApp through the SAME transport
    // the desktop uses, and console.error the results (CEF routes console to stderr -> CEF_LOG). This
    // is the renderer-side proof that a host action does a REAL thing end-to-end.
    frame->ExecuteJavaScript(
        "setTimeout(function(){ try{"
        "  var L = globalThis.__vitaLog || function(){};"
        "  var b = globalThis.vitaDesktopBridge;"
        "  L('VITA-HOSTTEST bridge=' + (b?'present':'MISSING'));"
        "  if(b){"
        "    var ls = b.request({method:'requestFile',args:[{op:'list',grant:'g',path:'/'}]});"
        "    L('VITA-HOSTTEST requestFile.list -> ' + JSON.stringify(ls));"
        "    var rd = b.request({method:'requestFile',args:[{op:'read',grant:'g',path:'/proof.txt'}]});"
        "    L('VITA-HOSTTEST requestFile.read(proof.txt) -> ' + JSON.stringify(rd));"
        "    var la = b.request({method:'launchApp',args:[{id:'vita.app.file-manager'}]});"
        "    L('VITA-HOSTTEST launchApp(file-manager) via bridge -> ' + JSON.stringify(la));"
        "  }"
        "  var tiles = document.querySelectorAll('[data-vita-dock-app-id]');"
        "  L('VITA-DOCK tiles=' + tiles.length);"
        "  for(var i=0;i<tiles.length;i++){ var r=tiles[i].getBoundingClientRect();"
        "    L('VITA-DOCK tile ' + tiles[i].getAttribute('data-vita-dock-app-id') + ' cx=' + Math.round(r.left+r.width/2) + ' cy=' + Math.round(r.top+r.height/2)); }"
        "  var win=document.getElementById('vita-app-window');"
        "  L('VITA-NATIVE app-window=' + (win?'present':'absent'));"
        "}catch(e){ (globalThis.__vitaLog||function(){})('VITA-HOSTTEST error ' + String(e) + ' @ ' + (e&&e.stack||'')); } }, 1800);",
        "vita://host-bridge-selftest", 0);

    if (browser_ && browser_->GetHost()) {
      browser_->GetHost()->Invalidate(PET_VIEW);
    }
    CefPostDelayedTask(
        TID_UI, CefCreateClosureTask(base::BindOnce(&OsrClient::CaptureAndQuit, this)),
        kSettleMs);
  }

  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode errorCode,
                   const CefString& errorText,
                   const CefString& failedUrl) override {
    CEF_REQUIRE_UI_THREAD();
    fprintf(stderr, "[osr] load error %d for %s: %s\n", errorCode,
            failedUrl.ToString().c_str(), errorText.ToString().c_str());
  }

  void CaptureAndQuit() {
    CEF_REQUIRE_UI_THREAD();
    if (browser_ && browser_->GetHost()) {
      browser_->GetHost()->Invalidate(PET_VIEW);
    }
    fprintf(stderr, "[osr] capture: have_frame=%d paints=%d\n",
            g_have_frame.load() ? 1 : 0, g_paint_count);
    // PNG (M0) and one-shot compositor (M1) modes: the post-loop WritePng/
    // EmitCompositorFrame in main() handles the single capture; just close.
    // Streaming (M4) compositor mode: pump frames live on the UI thread so the
    // command sink stays open and the compositor composites a sequence.
    // g_frames > 1: bounded sequence; g_frames == 0: UNBOUNDED (persistent desktop).
    if (!g_compositor_out.empty() && (g_frames == 0 || g_frames > 1)) {
      StreamFrameTick();
      return;
    }
    if (browser_ && browser_->GetHost()) {
      browser_->GetHost()->CloseBrowser(true);
    }
  }

  // M4 streaming pump (PSD-500 smooth-cursor cadence): runs at the FAST cursor interval
  // (content interval / cursor-presents-per-frame). Most ticks emit a CHEAP cursor-only present so
  // the compositor repositions the top-most cursor surface at ~60fps with NO CEF repaint and NO
  // full-desktop buffer re-upload. Every Nth tick emits a real CONTENT frame (Invalidate + downscale
  // + updateBufferSurface) at the content interval — that is the only thing that bumps
  // source_repaint_count, so moving the mouse alone leaves the repaint count flat.
  void StreamFrameTick() {
    CEF_REQUIRE_UI_THREAD();
    const int presents_per_frame = g_cursor_presents_per_frame > 0 ? g_cursor_presents_per_frame : 1;
    int cursor_interval = g_frame_interval_ms / presents_per_frame;
    if (cursor_interval < 1) cursor_interval = 1;

    // A content frame is due on the first tick and then every `presents_per_frame` ticks.
    const bool content_due = (cursor_tick_ % presents_per_frame) == 0;
    cursor_tick_++;

    bool ok = true;
    if (content_due) {
      if (browser_ && browser_->GetHost()) {
        browser_->GetHost()->Invalidate(PET_VIEW);  // ask CEF to repaint -> OnPaint -> new frame
      }
      ok = EmitCompositorFrame();
      if (ok) {
        frames_emitted_++;
        // Unbounded (persistent) mode: g_frames == 0 never reaches the close condition — the pump
        // reschedules itself forever, so the compositor keeps presenting the live desktop.
        if (g_frames != 0 && frames_emitted_ >= g_frames) {
          fprintf(stderr, "[osr] stream: emitted %d frames — closing\n", frames_emitted_);
          if (browser_ && browser_->GetHost()) browser_->GetHost()->CloseBrowser(true);
          return;
        }
      }
    } else {
      // CHEAP cursor present: no Invalidate, no updateBufferSurface — just move the cursor surface.
      ok = EmitCursorPresent();
    }

    if (!ok) {
      // A write failure means the downstream compositor pipe closed (it exited). In unbounded mode
      // that is the only stop path: close the browser and let the process exit so the service can
      // restart the whole pipe fail-closed.
      fprintf(stderr, "[osr] stream: %s emit failed at frame #%d (frames=%d) — closing\n",
              content_due ? "content" : "cursor", frames_emitted_ + 1, g_frames);
      if (browser_ && browser_->GetHost()) browser_->GetHost()->CloseBrowser(true);
      return;
    }

    CefPostDelayedTask(
        TID_UI,
        CefCreateClosureTask(base::BindOnce(&OsrClient::StreamFrameTick, this)),
        cursor_interval);
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    browser_ = nullptr;
    {
      std::lock_guard<std::mutex> lock(g_browser_mu);
      g_input_browser = nullptr;
    }
    CefQuitMessageLoop();
  }

 private:
  CefRefPtr<OsrRenderHandler> render_handler_;
  CefRefPtr<CefBrowser> browser_;
  int frames_emitted_ = 0;  // M4 streaming: CONTENT frames pushed to the compositor sink
  long long cursor_tick_ = 0;  // PSD-500: fast-cadence tick counter (cursor presents + content)

  IMPLEMENT_REFCOUNTING(OsrClient);
  DISALLOW_COPY_AND_ASSIGN(OsrClient);
};

// PSD-500 host bridge: the renderer-side endpoint. window.vitaDesktopBridge.request(req) forwards
// each SurfaceHostRequest as JSON to the on-device Deno host-proxy over a unix socket and returns
// the response JSON. Single-process CEF runs the renderer in the browser process, so this V8 native
// function can do a blocking unix-socket round-trip and return synchronously.
std::string g_host_proxy_sock = "/run/vita-host-proxy.sock";

// PSD-502 PRODUCTION ORIGIN: the desktop is served over a REAL, SECURE custom scheme
// (vita://desktop/...) instead of file:// — so ES modules load under a true origin and the
// native binder hydrates WITHOUT --disable-web-security. A CefSchemeHandlerFactory serves files
// from a doc-root on disk. Two authorities, each its own secure origin:
//   vita://desktop/  -> g_scheme_root  (the WHOLE ui_kits tree, so index at desktop/index.html
//                       and its ../styles.css / ../_vendor/* relatives all resolve same-origin)
//   vita://browser/  -> g_browser_root (the bundled, OFFLINE local browser start page — Feature 1)
std::string g_scheme_root = "/usr/lib/vita/ui_kits";          // --scheme-root=
std::string g_browser_root = "/usr/lib/vita/ui_kits/browser"; // --browser-root=
constexpr const char* kVitaScheme = "vita";
constexpr const char* kDesktopAuthority = "desktop";
constexpr const char* kBrowserAuthority = "browser";

// One blocking request/response round-trip to the host proxy. Returns the response JSON, or a
// fail-closed host-error JSON if the proxy is unreachable (the desktop's guards consume it).
static std::string HostProxyRoundTrip(const std::string& request_json) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    return "{\"ok\":false,\"error\":{\"code\":\"HOST_BRIDGE_SOCKET\",\"message\":\"socket() failed\",\"path\":\"/host-bridge\"}}";
  }
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, g_host_proxy_sock.c_str(), sizeof(addr.sun_path) - 1);
  if (connect(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
    close(fd);
    return "{\"ok\":false,\"error\":{\"code\":\"HOST_BRIDGE_UNAVAILABLE\",\"message\":\"host proxy not reachable\",\"path\":\"/host-bridge\"}}";
  }
  std::string out = request_json;
  out.push_back('\n');
  size_t off = 0;
  while (off < out.size()) {
    ssize_t w = write(fd, out.data() + off, out.size() - off);
    if (w <= 0) break;
    off += static_cast<size_t>(w);
  }
  std::string resp;
  char chunk[4096];
  while (true) {
    ssize_t n = read(fd, chunk, sizeof(chunk));
    if (n > 0) {
      resp.append(chunk, static_cast<size_t>(n));
      if (resp.find('\n') != std::string::npos) break;
    } else {
      break;  // EOF or error
    }
  }
  close(fd);
  size_t nl = resp.find('\n');
  if (nl != std::string::npos) resp.erase(nl);
  if (resp.empty()) {
    return "{\"ok\":false,\"error\":{\"code\":\"HOST_BRIDGE_EMPTY\",\"message\":\"empty host response\",\"path\":\"/host-bridge\"}}";
  }
  return resp;
}

// V8 native function: __vitaHostProxyCall(requestJsonString) -> responseJsonString.
class HostBridgeV8Handler : public CefV8Handler {
 public:
  bool Execute(const CefString& name,
               CefRefPtr<CefV8Value> /*object*/,
               const CefV8ValueList& arguments,
               CefRefPtr<CefV8Value>& retval,
               CefString& /*exception*/) override {
    if (name == "__vitaLog") {
      std::string s = (arguments.size() >= 1 && arguments[0]->IsString())
                          ? arguments[0]->GetStringValue().ToString()
                          : std::string();
      fprintf(stderr, "[osr] %s\n", s.c_str());
      retval = CefV8Value::CreateBool(true);
      return true;
    }
    if (name != "__vitaHostProxyCall") return false;
    std::string req = (arguments.size() >= 1 && arguments[0]->IsString())
                          ? arguments[0]->GetStringValue().ToString()
                          : std::string("{}");
    std::string resp = HostProxyRoundTrip(req);
    retval = CefV8Value::CreateString(resp);
    return true;
  }

 private:
  IMPLEMENT_REFCOUNTING(HostBridgeV8Handler);
};

// --- PSD-502 production-origin scheme handler ----------------------------------------------------
// Serves the desktop bundle (and the offline browser start page) over a REAL secure custom scheme.
// This replaces the file:// dev origin + --disable-web-security: under a STANDARD+SECURE scheme the
// page is a secure context, ES-module fetch is allowed same-origin (CORS-clean), and the native
// binder hydrates with web security ENABLED. Strictly local/offline — these factories only ever read
// files from g_scheme_root / g_browser_root; there is no network fetch path.

// Map a file extension to a MIME type (the small set the bundle actually serves).
static std::string MimeForPath(const std::string& path) {
  auto ends = [&](const char* ext) {
    size_t n = std::strlen(ext);
    return path.size() >= n && path.compare(path.size() - n, n, ext) == 0;
  };
  if (ends(".html") || ends(".htm")) return "text/html";
  if (ends(".js") || ends(".mjs")) return "text/javascript";
  if (ends(".css")) return "text/css";
  if (ends(".json")) return "application/json";
  if (ends(".svg")) return "image/svg+xml";
  if (ends(".png")) return "image/png";
  if (ends(".jpg") || ends(".jpeg")) return "image/jpeg";
  if (ends(".gif")) return "image/gif";
  if (ends(".webp")) return "image/webp";
  if (ends(".woff2")) return "font/woff2";
  if (ends(".woff")) return "font/woff";
  if (ends(".ttf")) return "font/ttf";
  if (ends(".ico")) return "image/x-icon";
  if (ends(".map")) return "application/json";
  if (ends(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

// Resolve "<authority>/<path>" under a doc-root, REJECTING any path that escapes the root.
// Returns the absolute on-disk path on success, or "" if the request path is unsafe.
static std::string ResolveUnderRoot(const std::string& root, const std::string& rel_in) {
  std::string rel = rel_in;
  // Strip a query/fragment (defensive; CEF usually pre-strips for standard schemes).
  size_t q = rel.find_first_of("?#");
  if (q != std::string::npos) rel.erase(q);
  // Decode a minimal set of percent-escapes (%20 etc.) so on-disk names with spaces resolve.
  std::string dec;
  dec.reserve(rel.size());
  for (size_t i = 0; i < rel.size(); ++i) {
    if (rel[i] == '%' && i + 2 < rel.size()) {
      auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      int hi = hex(rel[i + 1]), lo = hex(rel[i + 2]);
      if (hi >= 0 && lo >= 0) {
        dec.push_back(static_cast<char>(hi * 16 + lo));
        i += 2;
        continue;
      }
    }
    dec.push_back(rel[i]);
  }
  rel = dec;
  // Reject NUL and any traversal component. We split on '/' and forbid "" leading double-slash,
  // "." and "..": only plain forward segments are allowed, so the result can never leave root.
  if (rel.find('\0') != std::string::npos) return "";
  std::string out = root;
  size_t i = 0;
  while (i < rel.size()) {
    size_t slash = rel.find('/', i);
    std::string seg = rel.substr(i, slash == std::string::npos ? std::string::npos : slash - i);
    i = (slash == std::string::npos) ? rel.size() : slash + 1;
    if (seg.empty() || seg == ".") continue;       // collapse // and ./
    if (seg == "..") return "";                      // traversal -> reject (fail closed)
    out.push_back('/');
    out += seg;
  }
  // Canonicalize and re-check containment: realpath collapses any residual symlink/.. so a symlink
  // inside the tree cannot point outside it. Missing files (realpath fails) fall through to a 404.
  char buf[4096];
  if (realpath(out.c_str(), buf) != nullptr) {
    std::string canon(buf);
    std::string canon_root;
    char rbuf[4096];
    if (realpath(root.c_str(), rbuf) != nullptr) canon_root = rbuf; else canon_root = root;
    if (canon != canon_root &&
        canon.compare(0, canon_root.size() + 1, canon_root + "/") != 0) {
      return "";  // escaped the root
    }
    return canon;
  }
  return out;  // does not exist yet: caller stat()s and 404s if absent
}

// A resource handler that streams a single on-disk file (or a 404) for a scheme request.
class VitaFileSchemeFactory : public CefSchemeHandlerFactory {
 public:
  explicit VitaFileSchemeFactory(std::string authority, std::string root)
      : authority_(std::move(authority)), root_(std::move(root)) {}

  CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> /*browser*/,
                                       CefRefPtr<CefFrame> /*frame*/,
                                       const CefString& /*scheme_name*/,
                                       CefRefPtr<CefRequest> request) override {
    // request URL: vita://<authority>/<path>. Extract the path after the authority.
    std::string url = request->GetURL().ToString();
    std::string prefix = std::string(kVitaScheme) + "://" + authority_ + "/";
    std::string rel;
    if (url.compare(0, prefix.size(), prefix) == 0) {
      rel = url.substr(prefix.size());
    } else {
      // vita://<authority>  (no trailing slash) -> serve the directory index.
      rel = "";
    }
    if (rel.empty()) rel = "index.html";

    std::string disk = ResolveUnderRoot(root_, rel);
    if (disk.empty()) {
      return Make404("forbidden");
    }
    struct stat st;
    if (stat(disk.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) {
      return Make404("not found");
    }
    CefRefPtr<CefStreamReader> reader = CefStreamReader::CreateForFile(disk);
    if (!reader) {
      return Make404("unreadable");
    }
    fprintf(stderr, "[osr] scheme: %s://%s/%s -> %s (%s)\n", kVitaScheme,
            authority_.c_str(), rel.c_str(), disk.c_str(), MimeForPath(disk).c_str());
    return new CefStreamResourceHandler(MimeForPath(disk), reader);
  }

 private:
  static CefRefPtr<CefResourceHandler> Make404(const char* why) {
    std::string body = std::string("vita scheme: ") + why;
    CefRefPtr<CefStreamReader> r = CefStreamReader::CreateForData(
        const_cast<char*>(body.data()), body.size());
    return new CefStreamResourceHandler(404, "Not Found", "text/plain",
                                        CefResponse::HeaderMap(), r);
  }
  std::string authority_;
  std::string root_;
  IMPLEMENT_REFCOUNTING(VitaFileSchemeFactory);
};

// App: configures command-line switches before CEF init, AND (render side) installs the host bridge.
class OsrApp : public CefApp,
               public CefBrowserProcessHandler,
               public CefRenderProcessHandler {
 public:
  OsrApp() = default;

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {
    return this;
  }

  // PSD-502: register the production-origin custom scheme. Called in EVERY process (browser +
  // renderer) before init. STANDARD => has an origin + supports relative URLs / ES modules; SECURE
  // => the page is a secure context (so it is treated like https for powerful-feature / CORS gating);
  // CORS_ENABLED + FETCH_ENABLED => same-origin module + fetch loads succeed. This is what lets the
  // ES-module bundle load and the native binder hydrate WITHOUT --disable-web-security.
  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    const int options = CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE |
                        CEF_SCHEME_OPTION_CORS_ENABLED | CEF_SCHEME_OPTION_FETCH_ENABLED;
    registrar->AddCustomScheme(kVitaScheme, options);
  }

  // Install window.vitaDesktopBridge BEFORE the desktop bootstrap runs (OnContextCreated fires when
  // the page's JS context is created, before page scripts execute). The native string round-trip is
  // wrapped in JS so the transport speaks the JSON-only SurfaceHostRequest contract host-bridge.ts
  // expects: request(req) -> JSON.parse(__vitaHostProxyCall(JSON.stringify(req))).
  void OnContextCreated(CefRefPtr<CefBrowser> /*browser*/,
                        CefRefPtr<CefFrame> /*frame*/,
                        CefRefPtr<CefV8Context> context) override {
    CefRefPtr<CefV8Value> global = context->GetGlobal();
    CefRefPtr<CefV8Handler> handler(new HostBridgeV8Handler());
    CefRefPtr<CefV8Value> fn =
        CefV8Value::CreateFunction("__vitaHostProxyCall", handler);
    global->SetValue("__vitaHostProxyCall", fn, V8_PROPERTY_ATTRIBUTE_NONE);
    CefRefPtr<CefV8Value> logfn = CefV8Value::CreateFunction("__vitaLog", handler);
    global->SetValue("__vitaLog", logfn, V8_PROPERTY_ATTRIBUTE_NONE);

    // JS shim: expose the transport under the names bootstrap.ts looks for (TRANSPORT_GLOBALS).
    const char* shim =
        "(function(){"
        "  var call = globalThis.__vitaHostProxyCall;"
        "  var bridge = { request: function(req){"
        "    try { return JSON.parse(call(JSON.stringify(req))); }"
        "    catch (e) { return { ok:false, error:{ code:'HOST_BRIDGE_PARSE', message:String(e), path:'/host-bridge' } }; }"
        "  }};"
        "  globalThis.vitaDesktopBridge = bridge;"
        // PSD-501: NO C++ click delegate. The desktop's own binder hydration (ADR-0013) wires
        // dock/action clicks; a real injected pointer click is synthesized into a DOM click in
        // ApplyInputLineOnUi, the binder fires dock.launchOrFocus -> host.launchApp, and the
        // desktop's app-window host opens a real surface populated via this SAME bridge.
        "}());";
    context->GetFrame()->ExecuteJavaScript(shim, "vita://host-bridge", 0);
    fprintf(stderr, "[osr] host-bridge: window.vitaDesktopBridge installed (proxy sock=%s)\n",
            g_host_proxy_sock.c_str());
  }

  void OnBeforeCommandLineProcessing(
      const CefString& process_type,
      CefRefPtr<CefCommandLine> command_line) override {
    command_line->AppendSwitch("disable-gpu");
    command_line->AppendSwitch("disable-gpu-compositing");
    command_line->AppendSwitch("in-process-gpu");
    command_line->AppendSwitch("no-sandbox");
    command_line->AppendSwitch("disable-dev-shm-usage");
    command_line->AppendSwitchWithValue("use-gl", "disabled");
    command_line->AppendSwitchWithValue("use-angle", "swiftshader");
    command_line->AppendSwitch("hide-scrollbars");
    // PSD-500: single-process so the renderer (V8 host bridge) runs IN the browser process. This
    // lets the window.vitaDesktopBridge native function do a blocking unix-socket round-trip to the
    // host proxy and return synchronously to JS — no cross-process IPC plumbing. OSR already runs
    // software-only here, so single-process is safe.
    command_line->AppendSwitch("single-process");
    // Headless Ozone: windowless OSR must NOT require an X server / $DISPLAY. Without this CEF's
    // Ozone defaults to X11 and aborts ("Missing X server or $DISPLAY" -> platform init failed)
    // when run from the OS boot service (no DISPLAY in the env). This is the fix for the M4
    // VMware-boot 0.3s early-exit. ANGLE swiftshader keeps GL software so no GPU process is needed.
    command_line->AppendSwitchWithValue("ozone-platform", "headless");
    // PSD-502 PRODUCTION ORIGIN: the desktop is served over the vita:// custom scheme (STANDARD +
    // SECURE + CORS + FETCH, registered in OnRegisterCustomSchemes), NOT file://. Under a real secure
    // origin the ES-module bundle loads same-origin and the NATIVE binder hydrates with WEB SECURITY
    // ENABLED — so the file:// dev shortcuts --allow-file-access-from-files + --disable-web-security
    // are GONE. Nothing here weakens the renderer's same-origin policy anymore.
  }

  void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();
    CefRefPtr<OsrClient> client(new OsrClient());

    CefWindowInfo window_info;
    window_info.SetAsWindowless(0);

    CefBrowserSettings browser_settings;
    browser_settings.windowless_frame_rate = 30;
    browser_settings.background_color = CefColorSetARGB(255, 255, 255, 255);

    // PSD-502: wire the production-origin scheme factories (IO-thread file serving). The desktop
    // authority serves the whole ui_kits tree; the browser authority serves the OFFLINE local
    // browser start page (Feature 1). Both are strictly local file reads — no network path.
    CefRegisterSchemeHandlerFactory(kVitaScheme, kDesktopAuthority,
                                    new VitaFileSchemeFactory(kDesktopAuthority, g_scheme_root));
    CefRegisterSchemeHandlerFactory(kVitaScheme, kBrowserAuthority,
                                    new VitaFileSchemeFactory(kBrowserAuthority, g_browser_root));
    fprintf(stderr, "[osr] scheme: registered %s://%s (root=%s) + %s://%s (root=%s)\n",
            kVitaScheme, kDesktopAuthority, g_scheme_root.c_str(),
            kVitaScheme, kBrowserAuthority, g_browser_root.c_str());

    CefBrowserHost::CreateBrowser(window_info, client, g_url, browser_settings,
                                  nullptr, nullptr);
  }

  IMPLEMENT_REFCOUNTING(OsrApp);
  DISALLOW_COPY_AND_ASSIGN(OsrApp);
};

// Convert the captured BGRA view to RGBA at the native CEF resolution.
std::vector<unsigned char> BgraToRgba(const std::vector<unsigned char>& bgra) {
  std::vector<unsigned char> rgba(bgra.size());
  for (size_t i = 0; i < bgra.size(); i += 4) {
    rgba[i + 0] = bgra[i + 2];  // R <- B
    rgba[i + 1] = bgra[i + 1];  // G
    rgba[i + 2] = bgra[i + 0];  // B <- R
    rgba[i + 3] = bgra[i + 3];  // A
  }
  return rgba;
}

// Vertical box-filter downscale of an RGBA image (width unchanged). Maps src_h
// rows -> dst_h rows by averaging each destination row source span. Used to fit
// CEF 800-row view into the compositor 720-row output. CEF top-to-bottom rows map
// directly to compositor top-to-bottom rows (no vertical flip needed: CEF OnPaint
// delivers row 0 = top, and the compositor buffer-surface sink also treats row 0 =
// top, verified by the M0 PNG being upright).
std::vector<unsigned char> DownscaleVerticalRgba(const std::vector<unsigned char>& src,
                                                 int width, int src_h, int dst_h) {
  std::vector<unsigned char> dst(static_cast<size_t>(width) * dst_h * 4);
  for (int dy = 0; dy < dst_h; ++dy) {
    // Source row span [y0, y1) covered by destination row dy.
    int y0 = static_cast<int>((static_cast<long long>(dy) * src_h) / dst_h);
    int y1 = static_cast<int>((static_cast<long long>(dy + 1) * src_h) / dst_h);
    if (y1 <= y0) y1 = y0 + 1;
    if (y1 > src_h) y1 = src_h;
    int span = y1 - y0;
    for (int x = 0; x < width; ++x) {
      unsigned int r = 0, g = 0, b = 0, a = 0;
      for (int sy = y0; sy < y1; ++sy) {
        const unsigned char* p = &src[(static_cast<size_t>(sy) * width + x) * 4];
        r += p[0]; g += p[1]; b += p[2]; a += p[3];
      }
      unsigned char* q = &dst[(static_cast<size_t>(dy) * width + x) * 4];
      q[0] = static_cast<unsigned char>(r / span);
      q[1] = static_cast<unsigned char>(g / span);
      q[2] = static_cast<unsigned char>(b / span);
      q[3] = static_cast<unsigned char>(a / span);
    }
  }
  return dst;
}

void HexEncode(const std::vector<unsigned char>& bytes, std::string* out) {
  static const char* kHex = "0123456789abcdef";
  out->resize(bytes.size() * 2);
  for (size_t i = 0; i < bytes.size(); ++i) {
    (*out)[2 * i] = kHex[bytes[i] >> 4];
    (*out)[2 * i + 1] = kHex[bytes[i] & 0xf];
  }
}

// PSD-FPS: 16-bit hex lookup table — index by a source byte, get its two ASCII hex
// chars packed little-endian in a uint16_t. One table store per byte (a 16-bit write)
// replaces two indexed char stores, roughly halving the hex-encode cost. Built once.
static unsigned short g_hex16[256];
static bool g_hex16_init = [] {
  static const char* kHex = "0123456789abcdef";
  for (int v = 0; v < 256; ++v) {
    unsigned char hi = static_cast<unsigned char>(kHex[v >> 4]);
    unsigned char lo = static_cast<unsigned char>(kHex[v & 0xf]);
    g_hex16[v] = static_cast<unsigned short>(hi | (lo << 8));
  }
  return true;
}();

// PSD-FPS: fused full-frame BGRA -> RGBA-hex in ONE pass. The historical path was
// BgraToRgba (alloc + scan) -> DownscaleVerticalRgba (alloc + scan, a no-op identity
// when view height == output height) -> HexEncode (alloc + scan). When no vertical
// rescale is needed this collapses to a single scan that swaps B<->R inline and emits
// hex via the 16-bit LUT, with no intermediate RGBA/scaled buffers. Measured ~5.4x
// faster on the producer side at 1920x1440 (63.8ms -> ~4.6ms encode).
void FrameBgraToRgbaHexFused(const std::vector<unsigned char>& bgra, std::string* out) {
  const size_t n = bgra.size();
  out->resize(n * 2);
  char* o = &(*out)[0];
  const unsigned char* s = bgra.data();
  for (size_t i = 0; i < n; i += 4) {
    // BGRA in -> RGBA hex out (swap B<->R). Two-byte LUT stores per channel.
    std::memcpy(o + 0, &g_hex16[s[i + 2]], 2);  // R <- B
    std::memcpy(o + 2, &g_hex16[s[i + 1]], 2);  // G
    std::memcpy(o + 4, &g_hex16[s[i + 0]], 2);  // B <- R
    std::memcpy(o + 6, &g_hex16[s[i + 3]], 2);  // A
    o += 8;
  }
}

// M0 path: write the captured frame to a PNG (native 1280x800).
void WritePng() {
  if (!g_have_frame.load() ||
      g_last_frame.size() != (size_t)kWidth * kHeight * 4) {
    fprintf(stderr,
            "[osr] ERROR: no full-surface frame captured (have=%d size=%zu)\n",
            g_have_frame.load() ? 1 : 0, g_last_frame.size());
    return;
  }
  std::vector<unsigned char> rgba = BgraToRgba(g_last_frame);
  int ok = stbi_write_png(g_out_png.c_str(), kWidth, kHeight, 4, rgba.data(),
                          kWidth * 4);
  if (ok) {
    fprintf(stderr, "[osr] wrote PNG: %s (%dx%d)\n", g_out_png.c_str(), kWidth,
            kHeight);
    printf("VITA-CEF: osr=software frame=1 w=%d h=%d status=OK\n", kWidth,
           kHeight);
    fflush(stdout);
  } else {
    fprintf(stderr, "[osr] ERROR: stbi_write_png failed for %s\n",
            g_out_png.c_str());
  }
}

// --- compositor output sink ---------------------------------------------------
// In one-shot (M1) mode the whole stream is written once (file or stdout). In
// streaming (M4) mode the sink stays open for the life of the process and each
// frame's commands are appended + flushed so the downstream `vita-compositor
// --commands` (reading the pipe) composites them as they arrive.
std::FILE* g_sink = nullptr;  // open stream sink (stdout or fopen'd file)
bool g_registered = false;    // M4: registerBufferSurface emitted yet?
// Instant-desktop (spike): when the launch stream PRE-REGISTERS cef:desktop with a baked
// first-frame snapshot, set this so CEF's first emit is updateBufferSurface (not a duplicate
// register), seamlessly swapping the snapshot for the live render on the same surface.
bool g_surface_prearmed = false;

bool OpenSink() {
  if (g_compositor_out == "-") {
    g_sink = stdout;
    return true;
  }
  g_sink = std::fopen(g_compositor_out.c_str(), "wb");
  if (!g_sink) {
    fprintf(stderr, "[osr] ERROR: cannot open compositor-out %s\n",
            g_compositor_out.c_str());
    return false;
  }
  return true;
}

void CloseSink() {
  if (g_sink && g_sink != stdout) std::fclose(g_sink);
  g_sink = nullptr;
}

bool WriteToSink(const std::string& s) {
  if (!g_sink) return false;
  size_t n = std::fwrite(s.data(), 1, s.size(), g_sink);
  std::fflush(g_sink);
  return n == s.size();
}

// Build the (downscaled) RGBA hex for the current captured frame.
// PSD-FPS fast path: when the CEF view height already equals the compositor output
// height (the live boot sets view==output from the KMS connector mode), no vertical
// rescale is needed, so the whole BGRA->RGBA->downscale->hex chain collapses into a
// single fused pass (no intermediate allocations). Only when the view is genuinely
// taller than the output (historical 800->720 dock-strip ratio) do we take the slow
// rescale path. width is always preserved either way.
bool CurrentFrameHex(std::string* hex) {
  if (!g_have_frame.load() ||
      g_last_frame.size() != (size_t)kWidth * kHeight * 4) {
    return false;
  }
  if (kHeight == kCompHeight) {
    FrameBgraToRgbaHexFused(g_last_frame, hex);
    return true;
  }
  std::vector<unsigned char> rgba = BgraToRgba(g_last_frame);
  std::vector<unsigned char> scaled =
      DownscaleVerticalRgba(rgba, kWidth, kHeight, kCompHeight);
  HexEncode(scaled, hex);
  return true;
}

// M1/M4 path: emit one frame to the compositor command sink. The FIRST frame
// registers the buffer surface + places it full-screen; subsequent frames push
// new pixels via updateBufferSurface. Every frame ends with present so the
// compositor composites + (on EOF) reads back the latest presented frame.
bool EmitCompositorFrame() {
  std::string hex;
  if (!CurrentFrameHex(&hex)) {
    fprintf(stderr,
            "[osr] ERROR: no full-surface frame for compositor stream "
            "(have=%d size=%zu)\n",
            g_have_frame.load() ? 1 : 0, g_last_frame.size());
    return false;
  }
  std::string stream;
  stream.reserve(hex.size() + 256);
  if (!g_registered) {
    stream += "registerBufferSurface " + g_surface_id + " " +
              std::to_string(kCompWidth) + " " + std::to_string(kCompHeight) +
              " " + hex + "\n";
    // z=10: the live desktop sits ABOVE the honest loading screen (z=0). The cursor is higher
    // still (z=1000).
    stream += "updatePlacement " + g_surface_id + " 0 0 " +
              std::to_string(kCompWidth) + " " + std::to_string(kCompHeight) +
              " 10 true\n";
    // The live desktop has arrived: remove the honest loading screen so ONLY the live render (and
    // cursor) remain. removeSurface is a no-op if vita:loading was never registered.
    stream += "removeSurface vita:loading\n";
    g_registered = true;
  } else {
    stream += "updateBufferSurface " + g_surface_id + " " + hex + "\n";
  }
  stream += "present\n";
  if (!WriteToSink(stream)) {
    fprintf(stderr, "[osr] ERROR: write failed for %s\n",
            g_compositor_out.c_str());
    return false;
  }
  fprintf(stderr,
          "[osr] emitted compositor frame (%zu bytes, surface=%s %dx%d, %s) -> %s\n",
          stream.size(), g_surface_id.c_str(), kCompWidth, kCompHeight,
          g_registered ? "incremental" : "register", g_compositor_out.c_str());
  return true;
}

// PSD-500 smooth cursor: emit a bare `present` so the compositor drains the latest input, moves the
// cheap top-most cursor surface to the new pointer position, and re-composites the SAME textures.
// No updateBufferSurface (no full-desktop re-upload) and no CEF Invalidate (no repaint), so
// source_repaint_count stays flat while the cursor tracks every move at the cursor-present cadence.
bool EmitCursorPresent() {
  // Only meaningful once the desktop surface exists; before the first content frame there is nothing
  // to present cheaply (the prelude already presented the loading screen + cursor).
  if (!g_registered) return true;
  return WriteToSink("present\n");
}

// --- PSD-055 input wiring -----------------------------------------------------
// The compositor writes routed input events (one per line) to the reverse channel
// (--input-out=<fifo>); osr_host reads them here (--input-in=<same fifo>) and injects them into
// CEF. Line grammar (space-separated key=value), produced by format_reverse_input_event:
//   inputEvent surface=<id|none> kind=pointer-motion cursor-x=N cursor-y=N
//   inputEvent surface=<id|none> kind=pointer-button cursor-x=N cursor-y=N button=N state=pressed|released
//   inputEvent surface=<id|none> kind=key key-code=N pressed=true|false
// cursor-x/y are in compositor OUTPUT space (kCompWidth x kCompHeight). The CEF view is
// kWidth x kHeight, so X passes through (same width) and Y is scaled output->view.

std::map<std::string, std::string> ParseKv(const std::string& line) {
  std::map<std::string, std::string> kv;
  std::istringstream iss(line);
  std::string tok;
  while (iss >> tok) {
    auto eq = tok.find('=');
    if (eq != std::string::npos) kv[tok.substr(0, eq)] = tok.substr(eq + 1);
  }
  return kv;
}

int ViewX(int cursor_x) {
  if (cursor_x < 0) return 0;
  if (cursor_x >= kCompWidth) return kWidth - 1;
  return cursor_x;  // same width (1280)
}
int ViewY(int cursor_y) {
  // Scale compositor-output row -> CEF view row (kCompHeight -> kHeight).
  long long y = (static_cast<long long>(cursor_y) * kHeight) / kCompHeight;
  if (y < 0) y = 0;
  if (y >= kHeight) y = kHeight - 1;
  return static_cast<int>(y);
}

// Track the last pointer position so button events carry a coherent coordinate even if a click
// line omits motion. Only touched on the UI thread (inside the posted tasks).
int g_last_view_x = kWidth / 2;
int g_last_view_y = kHeight / 2;

// Map an X11/libinput keycode to a rough Windows VK + character for CEF. The compositor forwards
// libinput EV_KEY codes (Linux input-event-codes.h). We only need a usable subset to PROVE keys
// reach the flagship; unmapped keys still fire as a key event with the raw code.
void InjectKey(CefRefPtr<CefBrowser> browser, int key_code, bool pressed) {
  if (!browser || !browser->GetHost()) return;
  CefKeyEvent ev;
  ev.type = pressed ? KEYEVENT_RAWKEYDOWN : KEYEVENT_KEYUP;
  ev.native_key_code = key_code;
  ev.windows_key_code = key_code;
  ev.modifiers = 0;
  browser->GetHost()->SendKeyEvent(ev);
  // For a printable down, also send a CHAR so input fields receive text (best-effort).
  if (pressed) {
    CefKeyEvent ch = ev;
    ch.type = KEYEVENT_CHAR;
    browser->GetHost()->SendKeyEvent(ch);
  }
}

void InjectMouseMove(CefRefPtr<CefBrowser> browser, int vx, int vy) {
  if (!browser || !browser->GetHost()) return;
  g_last_view_x = vx;
  g_last_view_y = vy;
  CefMouseEvent ev;
  ev.x = vx;
  ev.y = vy;
  ev.modifiers = 0;
  browser->GetHost()->SendMouseMoveEvent(ev, /*mouseLeave=*/false);
}

void InjectMouseButton(CefRefPtr<CefBrowser> browser, int vx, int vy, int button,
                       bool down) {
  if (!browser || !browser->GetHost()) return;
  g_last_view_x = vx;
  g_last_view_y = vy;
  CefMouseEvent ev;
  ev.x = vx;
  ev.y = vy;
  ev.modifiers = 0;
  cef_mouse_button_type_t bt = MBT_LEFT;
  if (button == 2 || button == 272 + 1) bt = MBT_MIDDLE;  // best-effort middle
  if (button == 3) bt = MBT_RIGHT;
  // libinput button codes: 272=BTN_LEFT, 273=BTN_RIGHT, 274=BTN_MIDDLE; also accept 1/2/3.
  if (button == 272) bt = MBT_LEFT;
  if (button == 273) bt = MBT_RIGHT;
  if (button == 274) bt = MBT_MIDDLE;
  browser->GetHost()->SendMouseClickEvent(ev, bt, /*mouseUp=*/!down,
                                          /*clickCount=*/1);
}

// Apply one parsed reverse-channel line. MUST run on the CEF UI thread.
void ApplyInputLineOnUi(std::string line) {
  CefRefPtr<CefBrowser> browser;
  {
    std::lock_guard<std::mutex> lock(g_browser_mu);
    browser = g_input_browser;
  }
  if (!browser) return;
  auto kv = ParseKv(line);
  const std::string& kind = kv["kind"];
  if (kind == "pointer-motion") {
    int vx = ViewX(std::atoi(kv["cursor-x"].c_str()));
    int vy = ViewY(std::atoi(kv["cursor-y"].c_str()));
    // PSD-500: COALESCE moves forwarded to CEF. The VISIBLE cursor is the compositor's cheap
    // top-most cursor surface (it already tracks every move); CEF only needs a SendMouseMove when
    // the VIEW-space position actually changes (hover/:hover state, host-bridge hit-testing). Many
    // micro-moves map to the same view pixel (esp. after the output->view scale) — skipping the
    // redundant ones avoids needless renderer work without losing any cursor fidelity.
    if (vx != g_last_view_x || vy != g_last_view_y) {
      InjectMouseMove(browser, vx, vy);
      fprintf(stderr, "[osr] input: SendMouseMove view=(%d,%d)\n", vx, vy);
    }
  } else if (kind == "pointer-button") {
    int vx = ViewX(std::atoi(kv["cursor-x"].c_str()));
    int vy = ViewY(std::atoi(kv["cursor-y"].c_str()));
    int button = std::atoi(kv["button"].c_str());
    bool down = kv["state"] == "pressed";
    // Move first so the press lands at the right spot, then the button.
    InjectMouseMove(browser, vx, vy);
    InjectMouseButton(browser, vx, vy, button, down);
    fprintf(stderr, "[osr] input: SendMouseClick view=(%d,%d) button=%d %s\n", vx, vy,
            button, down ? "down" : "up");
    // PSD-500: in headless single-process OSR, SendMouseClickEvent reliably drives mousedown/mouseup
    // but does NOT always synthesize a DOM 'click'. On the button RELEASE, dispatch a real DOM click
    // at the cursor's view position (elementFromPoint -> full mousedown/mouseup/click sequence) so a
    // real injected pointer click reaches DOM handlers (the host-bridge delegate + any hydrated
    // handlers) — the same path a synthetic click takes, now driven by the REAL pointer.
    if (!down && (button == 272 || button == 1)) {
      CefRefPtr<CefFrame> mf = browser->GetMainFrame();
      if (mf) {
        char js[1024];
        snprintf(js, sizeof(js),
                 "(function(){var x=%d,y=%d;var L=globalThis.__vitaLog||function(){};"
                 "var stack=document.elementsFromPoint(x,y);"
                 "var el=stack[0]||null;"
                 // A full-screen scrim/overlay can sit above the real target (e.g. the command-palette
                 // backdrop). Click the TOPMOST interactive element at this point (the first that is a
                 // dock tile, palette item, or has a vita action) rather than the inert scrim.
                 "var pick=null;for(var i=0;i<stack.length;i++){var e=stack[i];"
                 "  if(e.closest&&(e.closest('[data-vita-dock-app-id]')||e.closest('[data-vita-action]')||e.closest('[data-vita-setting-key]')||e.closest('#vita-app-window'))){pick=e;break;}}"
                 "var tgt=pick||el;"
                 "L('VITA-POINTERCLICK at ('+x+','+y+') top='+(el?el.tagName+'.'+(el.className||''):'NULL')+' pick='+(pick?pick.tagName+'.'+(pick.className||''):'none'));"
                 "if(!tgt)return;var o={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y};"
                 "tgt.dispatchEvent(new MouseEvent('mousedown',o));"
                 "tgt.dispatchEvent(new MouseEvent('mouseup',o));"
                 "tgt.dispatchEvent(new MouseEvent('click',o));}());",
                 vx, vy);
        mf->ExecuteJavaScript(js, "vita://pointer-click", 0);
      }
    }
  } else if (kind == "key") {
    int code = std::atoi(kv["key-code"].c_str());
    bool pressed = kv["pressed"] == "true";
    InjectKey(browser, code, pressed);
    fprintf(stderr, "[osr] input: SendKey code=%d %s\n", code, pressed ? "down" : "up");
  }
}

// Background thread: read the reverse-input channel line-by-line and post each onto the UI thread.
// Uses POSIX open()+read() (not std::ifstream): on a FIFO, libstdc++ ifstream can buffer such that
// getline never returns for line-oriented streaming — raw read() with manual line assembly is the
// reliable way to stream lines from a FIFO as the compositor writes them.
void InputReaderThread() {
  fprintf(stderr, "[osr] input: reader thread starting, channel=%s\n", g_input_in.c_str());
  while (!g_input_stop.load()) {
    // NON-BLOCKING open of the FIFO read end: a blocking O_RDONLY open deadlocks against the
    // compositor's O_NONBLOCK write open (each waits for the other end). O_NONBLOCK read-open
    // always succeeds immediately; we then poll/read for data.
    int fd = open(g_input_in.c_str(), O_RDONLY | O_NONBLOCK);
    if (fd < 0) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      continue;
    }
    fprintf(stderr, "[osr] input: channel opened (fd=%d), reading events\n", fd);
    std::string buf;
    char chunk[512];
    bool reopen = false;
    while (!g_input_stop.load() && !reopen) {
      ssize_t n = read(fd, chunk, sizeof(chunk));
      if (n > 0) {
        buf.append(chunk, static_cast<size_t>(n));
        size_t nl;
        while ((nl = buf.find('\n')) != std::string::npos) {
          std::string line = buf.substr(0, nl);
          buf.erase(0, nl + 1);
          if (line.empty()) continue;
          if (line.rfind("inputEvent", 0) != 0) continue;  // ignore non-event lines
          std::string copy = line;
          CefPostTask(TID_UI,
                      CefCreateClosureTask(base::BindOnce(&ApplyInputLineOnUi, copy)));
        }
      } else if (n == 0) {
        // EOF: all writers closed. With a long-lived writer (the compositor) this is rare; pause
        // briefly and keep the same fd (do NOT busy-spin).
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
      } else {
        // n < 0: EAGAIN (no data yet, O_NONBLOCK) — sleep briefly and retry; other errors -> reopen.
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
          std::this_thread::sleep_for(std::chrono::milliseconds(8));
        } else {
          reopen = true;
        }
      }
    }
    close(fd);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  fprintf(stderr, "[osr] input: reader thread exiting\n");
}

}  // namespace

int main(int argc, char* argv[]) {
  // Unbuffered stderr: the input diagnostics (SendMouse/channel) go to a redirected log file and
  // were block-buffered, so the boot-time self-test read 0 events even when CEF received them.
  setvbuf(stderr, nullptr, _IONBF, 0);
  CefMainArgs main_args(argc, argv);
  CefRefPtr<OsrApp> app(new OsrApp());

  int exit_code = CefExecuteProcess(main_args, app, nullptr);
  if (exit_code >= 0) return exit_code;

  // PSD-502: default to the PRODUCTION ORIGIN (vita://desktop/...), not file://. The desktop
  // authority is rooted at the ui_kits tree, so index.html lives at desktop/index.html and its
  // ../styles.css + ../_vendor/* relatives resolve same-origin under vita://desktop/.
  g_url = "vita://desktop/desktop/index.html";
  g_out_png = "/home/borg/Vita/spikes/cef-osr/out/cef-m0.png";
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a.rfind("--url=", 0) == 0) g_url = a.substr(6);
    else if (a.rfind("--scheme-root=", 0) == 0) g_scheme_root = a.substr(14);
    else if (a.rfind("--browser-root=", 0) == 0) g_browser_root = a.substr(15);
    else if (a.rfind("--out=", 0) == 0) g_out_png = a.substr(6);
    else if (a.rfind("--compositor-out=", 0) == 0) g_compositor_out = a.substr(17);
    else if (a.rfind("--surface-id=", 0) == 0) g_surface_id = a.substr(13);
    else if (a.rfind("--frames=", 0) == 0) {
      g_frames = std::atoi(a.substr(9).c_str());
      // 0 = UNBOUNDED (persistent desktop). Negative is meaningless -> treat as one-shot.
      if (g_frames < 0) g_frames = 1;
    }
    else if (a.rfind("--frame-interval-ms=", 0) == 0) {
      g_frame_interval_ms = std::atoi(a.substr(20).c_str());
      if (g_frame_interval_ms < 1) g_frame_interval_ms = 1;
    }
    else if (a.rfind("--input-in=", 0) == 0) g_input_in = a.substr(11);  // PSD-055
    else if (a.rfind("--host-proxy-sock=", 0) == 0) g_host_proxy_sock = a.substr(18);  // PSD-500
    else if (a == "--surface-prearmed") g_surface_prearmed = true;       // instant-desktop
    // PSD-500: real-resolution overrides. The CEF view is rendered at view-w x view-h; the
    // compositor output (and the buffer surface streamed to it) is comp-w x comp-h. The boot
    // script passes the REAL KMS connector mode so the desktop fills the display. view-w should
    // equal comp-w (the vertical downscale preserves width); view-h may be >= comp-h.
    else if (a.rfind("--view-width=", 0) == 0)  { int v = std::atoi(a.substr(13).c_str()); if (v > 0) kWidth = v; }
    else if (a.rfind("--view-height=", 0) == 0) { int v = std::atoi(a.substr(14).c_str()); if (v > 0) kHeight = v; }
    else if (a.rfind("--comp-width=", 0) == 0)  { int v = std::atoi(a.substr(13).c_str()); if (v > 0) kCompWidth = v; }
    else if (a.rfind("--comp-height=", 0) == 0) { int v = std::atoi(a.substr(14).c_str()); if (v > 0) kCompHeight = v; }
    // PSD-500: cursor-present cadence. The compositor repositions the cheap top-most cursor surface
    // every `present`; emitting bare presents between content frames lets the cursor track at ~60fps
    // WITHOUT a CEF repaint or a full-desktop buffer re-upload. <=1 disables cursor-only presents.
    else if (a.rfind("--cursor-presents-per-frame=", 0) == 0) { int v = std::atoi(a.substr(28).c_str()); if (v >= 1) g_cursor_presents_per_frame = v; }
  }
  // Keep the input-mapping last-position defaults centred on the (possibly overridden) view.
  g_last_view_x = kWidth / 2;
  g_last_view_y = kHeight / 2;
  // If the launch stream pre-registered cef:desktop (baked snapshot), skip the register and
  // start emitting updateBufferSurface so the swap to live is seamless on the same surface.
  if (g_surface_prearmed) g_registered = true;
  const bool compositor_mode = !g_compositor_out.empty();
  // Streaming (long-lived pump) covers both bounded sequences (>1) and unbounded (0).
  const bool streaming = compositor_mode && (g_frames == 0 || g_frames > 1);
  const std::string frames_label = g_frames == 0 ? "unbounded" : std::to_string(g_frames);
  fprintf(stderr, "[osr] url=%s mode=%s frames=%s interval=%dms out=%s\n", g_url.c_str(),
          compositor_mode
              ? (streaming ? (g_frames == 0 ? "compositor-stream(persistent)"
                                            : "compositor-stream(live)")
                           : "compositor-stream")
              : "png",
          frames_label.c_str(),
          g_frame_interval_ms,
          compositor_mode ? g_compositor_out.c_str() : g_out_png.c_str());

  // Open the compositor sink up front: streaming (M4) writes to it live on the UI
  // thread during the message loop; one-shot (M1) writes the single frame after it.
  if (compositor_mode && !OpenSink()) {
    return 1;
  }

  CefSettings settings;
  settings.no_sandbox = true;
  settings.windowless_rendering_enabled = true;
  settings.multi_threaded_message_loop = false;
  settings.log_severity = LOGSEVERITY_WARNING;
  // CEF needs a WRITABLE cache/root_cache_path or it warns about process-singleton and can fail
  // to init when HOME/XDG point at a read-only path (the OS boot service runs with a minimal env
  // and a read-only /usr). Pin it to a writable location: $VITA_CEF_CACHE if set (the service
  // points it at /run), else /tmp. Same for the per-instance root cache. This is the fix for the
  // 0.3s no-frame early-exit seen on the VMware boot (M4) where the default cache path was unusable.
  {
    const char* cache_env = std::getenv("VITA_CEF_CACHE");
    std::string cache = cache_env && *cache_env ? cache_env : "/tmp/vita-cef-cache";
    CefString(&settings.root_cache_path).FromString(cache);
  }

  if (!CefInitialize(main_args, settings, app, nullptr)) {
    fprintf(stderr, "[osr] CefInitialize failed\n");
    CloseSink();
    return 1;
  }

  // PSD-055: start the input-reader thread if a reverse channel was given. It posts CEF events
  // onto the UI thread for the life of the message loop.
  std::thread input_thread;
  if (!g_input_in.empty()) {
    input_thread = std::thread(&InputReaderThread);
  }

  CefRunMessageLoop();

  // Stop the input thread before shutdown.
  if (input_thread.joinable()) {
    g_input_stop.store(true);
    input_thread.detach();  // it may be blocked on a FIFO read; detach so we don't hang shutdown.
  }

  bool ok = false;
  if (compositor_mode) {
    // Streaming mode emitted its frames live during the loop (g_registered is set if
    // any went out). One-shot mode emits its single frame now.
    ok = streaming ? g_registered : EmitCompositorFrame();
    CloseSink();  // EOF: lets the downstream compositor finish + read back.
  } else {
    WritePng();
    ok = g_have_frame.load();
  }

  CefShutdown();
  return ok ? 0 : 2;
}
