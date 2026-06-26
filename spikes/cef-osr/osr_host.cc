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
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "include/base/cef_callback.h"
#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_render_handler.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

namespace {

// Forward decl: the M4 streaming pump (OsrClient::StreamFrameTick, a method defined
// inside the class below) emits frames via this free function, which is defined later.
bool EmitCompositorFrame();

// --- configuration (fixed CEF view surface) ---
constexpr int kWidth = 1280;
constexpr int kHeight = 800;
// Compositor output is 1280x720 (DESKTOP_DEMO_OUTPUT_*). The M1 buffer surface is
// downscaled to this so it fills the output exactly (no clip / no letterbox bars).
constexpr int kCompWidth = 1280;
constexpr int kCompHeight = 720;
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
                  public CefLoadHandler {
 public:
  OsrClient() : render_handler_(new OsrRenderHandler()) {}

  CefRefPtr<CefRenderHandler> GetRenderHandler() override {
    return render_handler_;
  }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    browser_ = browser;
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

  // M4 streaming pump: emit the current frame to the compositor sink, then either
  // schedule the next tick or close the browser once g_frames have been emitted.
  void StreamFrameTick() {
    CEF_REQUIRE_UI_THREAD();
    if (browser_ && browser_->GetHost()) {
      browser_->GetHost()->Invalidate(PET_VIEW);
    }
    if (!EmitCompositorFrame()) {
      // A write failure means the downstream compositor pipe closed (it exited). In
      // unbounded mode that is the only stop path: close the browser and let the
      // process exit so the service can restart the whole pipe fail-closed.
      fprintf(stderr, "[osr] stream: frame emit failed at #%d (frames=%d) — closing\n",
              frames_emitted_ + 1, g_frames);
      if (browser_ && browser_->GetHost()) browser_->GetHost()->CloseBrowser(true);
      return;
    }
    frames_emitted_++;
    // Unbounded (persistent) mode: g_frames == 0 never reaches the close condition — the
    // pump reschedules itself forever, so the compositor keeps presenting the live desktop.
    if (g_frames != 0 && frames_emitted_ >= g_frames) {
      fprintf(stderr, "[osr] stream: emitted %d frames — closing\n", frames_emitted_);
      if (browser_ && browser_->GetHost()) browser_->GetHost()->CloseBrowser(true);
      return;
    }
    CefPostDelayedTask(
        TID_UI,
        CefCreateClosureTask(base::BindOnce(&OsrClient::StreamFrameTick, this)),
        g_frame_interval_ms);
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
  int frames_emitted_ = 0;  // M4 streaming: frames pushed to the compositor sink

  IMPLEMENT_REFCOUNTING(OsrClient);
  DISALLOW_COPY_AND_ASSIGN(OsrClient);
};

// App: configures command-line switches before CEF init.
class OsrApp : public CefApp, public CefBrowserProcessHandler {
 public:
  OsrApp() = default;

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
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
    // Headless Ozone: windowless OSR must NOT require an X server / $DISPLAY. Without this CEF's
    // Ozone defaults to X11 and aborts ("Missing X server or $DISPLAY" -> platform init failed)
    // when run from the OS boot service (no DISPLAY in the env). This is the fix for the M4
    // VMware-boot 0.3s early-exit. ANGLE swiftshader keeps GL software so no GPU process is needed.
    command_line->AppendSwitchWithValue("ozone-platform", "headless");
  }

  void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();
    CefRefPtr<OsrClient> client(new OsrClient());

    CefWindowInfo window_info;
    window_info.SetAsWindowless(0);

    CefBrowserSettings browser_settings;
    browser_settings.windowless_frame_rate = 30;
    browser_settings.background_color = CefColorSetARGB(255, 255, 255, 255);

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

// Build the downscaled (1280x720) RGBA hex for the current captured frame.
bool CurrentFrameHex(std::string* hex) {
  if (!g_have_frame.load() ||
      g_last_frame.size() != (size_t)kWidth * kHeight * 4) {
    return false;
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
    // z=10: the live desktop sits ABOVE the honest loading screen (z=0) so its first real frame
    // covers the loading indicator. The cursor surface is higher still (z=1000).
    stream += "updatePlacement " + g_surface_id + " 0 0 " +
              std::to_string(kCompWidth) + " " + std::to_string(kCompHeight) +
              " 10 true\n";
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
    InjectMouseMove(browser, vx, vy);
    fprintf(stderr, "[osr] input: SendMouseMove view=(%d,%d)\n", vx, vy);
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
  } else if (kind == "key") {
    int code = std::atoi(kv["key-code"].c_str());
    bool pressed = kv["pressed"] == "true";
    InjectKey(browser, code, pressed);
    fprintf(stderr, "[osr] input: SendKey code=%d %s\n", code, pressed ? "down" : "up");
  }
}

// Background thread: read the reverse-input channel line-by-line and post each onto the UI thread.
void InputReaderThread() {
  fprintf(stderr, "[osr] input: reader thread starting, channel=%s\n", g_input_in.c_str());
  // The channel is a FIFO the compositor opens for write; opening for read blocks until the
  // writer appears, which is fine (boot ordering). Reopen on EOF so a compositor restart resumes.
  while (!g_input_stop.load()) {
    std::ifstream in(g_input_in);
    if (!in.is_open()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      continue;
    }
    std::string line;
    while (!g_input_stop.load() && std::getline(in, line)) {
      if (line.empty()) continue;
      if (line.rfind("inputEvent", 0) != 0) continue;  // ignore non-event lines
      std::string copy = line;
      CefPostTask(TID_UI,
                  CefCreateClosureTask(base::BindOnce(&ApplyInputLineOnUi, copy)));
    }
    // EOF (writer closed): brief pause, then reopen.
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  fprintf(stderr, "[osr] input: reader thread exiting\n");
}

}  // namespace

int main(int argc, char* argv[]) {
  CefMainArgs main_args(argc, argv);
  CefRefPtr<OsrApp> app(new OsrApp());

  int exit_code = CefExecuteProcess(main_args, app, nullptr);
  if (exit_code >= 0) return exit_code;

  g_url = "file:///home/borg/Vita/ui_kits/desktop/index.html";
  g_out_png = "/home/borg/Vita/spikes/cef-osr/out/cef-m0.png";
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a.rfind("--url=", 0) == 0) g_url = a.substr(6);
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
    else if (a == "--surface-prearmed") g_surface_prearmed = true;       // instant-desktop
  }
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
