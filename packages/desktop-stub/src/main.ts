import { runDesktopStubSession } from "./session.ts";

const result = runDesktopStubSession({
  emit: (line) => {
    console.log(line);
  },
});

console.log(
  "VITA-DESKTOP-STUB: " +
    `id=${result.registration.packageId} ` +
    `session=${result.registration.sessionId} ` +
    "stopped=OK status=OK",
);
