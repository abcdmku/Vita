console.log("VITA-CAPSULE-WORKLOAD: id=local.test.capsule status=OK");

setInterval(() => {
  // Keep the proof capsule active so agentd can confirm systemd state and read DynamicUser's uid.
}, 60_000);
