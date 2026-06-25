#include <chrono>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

struct Options {
  std::string engine = "cef";
  std::string app = "assets/heavy-app.html";
  int duration_ms = 5000;
};

std::string json_escape(std::string_view value) {
  std::ostringstream out;
  for (const char ch : value) {
    switch (ch) {
      case '\\':
        out << "\\\\";
        break;
      case '"':
        out << "\\\"";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        out << ch;
        break;
    }
  }
  return out.str();
}

std::string now_utc_placeholder() {
  return "vmware-target-runtime";
}

Options parse_options(int argc, char** argv) {
  Options options;
  for (int index = 1; index < argc; index += 1) {
    const std::string_view arg(argv[index]);
    if (arg.rfind("--engine=", 0) == 0) {
      options.engine = std::string(arg.substr(9));
    } else if (arg.rfind("--app=", 0) == 0) {
      options.app = std::string(arg.substr(6));
    } else if (arg.rfind("--duration-ms=", 0) == 0) {
      options.duration_ms = std::stoi(std::string(arg.substr(14)));
    } else {
      throw std::runtime_error("unknown argument: " + std::string(arg));
    }
  }
  if (options.engine != "cef" && options.engine != "wpe") {
    throw std::runtime_error("--engine must be cef or wpe");
  }
  if (options.duration_ms <= 0) {
    throw std::runtime_error("--duration-ms must be positive");
  }
  return options;
}

std::string unavailable_note(const Options& options) {
  if (options.engine == "cef") {
#if PSD_SPIKE_CEF_PRESENT
    return "CEF SDK was found at configure time, but this portable runner still requires the VMware GPU target path to be enabled.";
#else
    return "CEF_ROOT was not available at configure time; accelerated OnAcceleratedPaint shared-texture run is pending the VMware target.";
#endif
  }
#if PSD_SPIKE_WPE_PRESENT
  return "WPE WebKit was found at configure time, but this portable runner still requires the VMware GPU target path to be enabled.";
#else
  return "WPE WebKit was not available at configure time; fallback run is pending the VMware target.";
#endif
}

void write_unavailable_report(const Options& options) {
  const std::string timestamp = now_utc_placeholder();
  std::cout
      << "{\n"
      << "  \"schemaVersion\": 1,\n"
      << "  \"generatedAt\": \"" << timestamp << "\",\n"
      << "  \"budgetFps\": 60,\n"
      << "  \"runs\": [\n"
      << "    {\n"
      << "      \"engine\": \"" << options.engine << "\",\n"
      << "      \"state\": \"unavailable\",\n"
      << "      \"timestamp\": \"" << timestamp << "\",\n"
      << "      \"target\": {\n"
      << "        \"os\": \"vmware-target-required\",\n"
      << "        \"gpu\": \"vmware-3d-required\",\n"
      << "        \"vmware3d\": false,\n"
      << "        \"driver\": \"pending\"\n"
      << "      },\n"
      << "      \"texture\": {\n"
      << "        \"mode\": \"unavailable\",\n"
      << "        \"handleKind\": \"none\",\n"
      << "        \"dimensions\": { \"width\": 0, \"height\": 0 },\n"
      << "        \"reusedAcrossMotionFrames\": false,\n"
      << "        \"acceleratedPaintEvents\": 0\n"
      << "      },\n"
      << "      \"motion\": {\n"
      << "        \"compositedFrames\": 0,\n"
      << "        \"durationMs\": 1,\n"
      << "        \"webPaintEventsBefore\": 0,\n"
      << "        \"webPaintEventsAfter\": 0,\n"
      << "        \"contentTextureIdChanges\": 0,\n"
      << "        \"cpuReadbackFramesDuringMotion\": 0\n"
      << "      },\n"
      << "      \"frameTimesMs\": [],\n"
      << "      \"screenshot\": { \"path\": \"artifacts/pending.png\" },\n"
      << "      \"notes\": [\"" << json_escape(unavailable_note(options)) << "\", \"app=" << json_escape(options.app) << "\"]\n"
      << "    }\n"
      << "  ],\n"
      << "  \"notes\": [\"Native measurement must run inside the VMware Workstation Pro GPU target with 3D acceleration enabled.\"]\n"
      << "}\n";
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const Options options = parse_options(argc, argv);
    write_unavailable_report(options);
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
