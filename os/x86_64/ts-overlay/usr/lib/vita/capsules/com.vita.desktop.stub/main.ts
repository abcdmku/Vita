const PACKAGE_ID = "com.vita.desktop.stub";
const SESSION_ID = "stub-session";

console.log(
  "VITA-DESKTOP-STUB: " +
    `id=${PACKAGE_ID} ` +
    `session=${SESSION_ID} ` +
    "running=OK status=OK",
);

setInterval(() => {
  // Keep the no-op desktop session alive until capsule.lifecycle stops it.
}, 60_000);
