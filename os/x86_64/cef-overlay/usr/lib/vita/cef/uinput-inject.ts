// Deno uinput injector (PSD-055 verification) — all via libc FFI to get a real int fd.
// Usage: deno run -A uinput-inject.ts create   (prints READY, reads stdin: "move dx dy"|"click"|"quit")
const libc = Deno.dlopen("libc.so.6", {
  open: { parameters: ["buffer", "i32", "i32"], result: "i32" },
  write: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  ioctl: { parameters: ["i32", "u64", "u64"], result: "i32" },
  close: { parameters: ["i32"], result: "i32" },
});
const cstr = (s: string) => new TextEncoder().encode(s + "\0");

const O_WRONLY = 1, O_NONBLOCK = 0o4000;
const EV_SYN = 0x00, EV_KEY = 0x01, EV_REL = 0x02;
const REL_X = 0x00, REL_Y = 0x01, BTN_LEFT = 0x110;
const UI_DEV_CREATE = 0x5501n, UI_DEV_DESTROY = 0x5502n;
const UI_SET_EVBIT = 0x40045564n, UI_SET_KEYBIT = 0x40045565n, UI_SET_RELBIT = 0x40045566n;

const fd = libc.symbols.open(cstr("/dev/uinput"), O_WRONLY | O_NONBLOCK, 0);
if (fd < 0) { console.error("open /dev/uinput failed"); Deno.exit(1); }
function ioctl(req: bigint, arg: number) {
  if (libc.symbols.ioctl(fd, req, BigInt(arg)) < 0) throw new Error(`ioctl ${req}`);
}
ioctl(UI_SET_EVBIT, EV_KEY); ioctl(UI_SET_KEYBIT, BTN_LEFT);
ioctl(UI_SET_EVBIT, EV_REL); ioctl(UI_SET_RELBIT, REL_X); ioctl(UI_SET_RELBIT, REL_Y);

// uinput_user_dev
const dev = new Uint8Array(80 + 8 + 4 + 64 * 4 * 4);
dev.set(new TextEncoder().encode("vita-test-mouse").subarray(0, 79), 0);
const dvv = new DataView(dev.buffer);
dvv.setUint16(80, 3, true); dvv.setUint16(82, 0x1234, true);
dvv.setUint16(84, 0x5678, true); dvv.setUint16(86, 1, true);
libc.symbols.write(fd, dev, BigInt(dev.length));
libc.symbols.ioctl(fd, UI_DEV_CREATE, 0n);

function emit(type: number, code: number, value: number) {
  const b = new Uint8Array(24);
  const v = new DataView(b.buffer);
  v.setUint16(16, type, true); v.setUint16(18, code, true); v.setInt32(20, value, true);
  libc.symbols.write(fd, b, 24n);
}
const syn = () => emit(EV_SYN, 0, 0);
const move = (dx: number, dy: number) => { emit(EV_REL, REL_X, dx); emit(EV_REL, REL_Y, dy); syn(); };
const click = () => { emit(EV_KEY, BTN_LEFT, 1); syn(); emit(EV_KEY, BTN_LEFT, 0); syn(); };

console.log("READY");
const buf = new Uint8Array(1024); const dec = new TextDecoder(); let acc = "";
while (true) {
  const n = Deno.stdin.readSync(buf);
  if (n === null || n === 0) break;
  acc += dec.decode(buf.subarray(0, n));
  let nl;
  while ((nl = acc.indexOf("\n")) >= 0) {
    const line = acc.slice(0, nl).trim(); acc = acc.slice(nl + 1);
    if (line === "quit") { libc.symbols.ioctl(fd, UI_DEV_DESTROY, 0n); libc.symbols.close(fd); Deno.exit(0); }
    else if (line === "click") { click(); }
    else if (line.startsWith("move ")) { const [, dx, dy] = line.split(/\s+/); move(parseInt(dx), parseInt(dy)); }
  }
}
