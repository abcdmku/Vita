// Deno uinput injector (PSD-055 verification) — all via libc FFI to get a real int fd.
// Creates an ABSOLUTE pointer (EV_ABS ABS_X/ABS_Y + BTN_LEFT), matching VMware's real VMMouse
// (which is an absolute device), so it exercises the exact POINTER_MOTION_ABSOLUTE path the fix
// added. Usage: deno run -A uinput-inject.ts create   (prints READY, reads stdin:
//   "moveto X Y" (absolute, in output pixels 0..1280 / 0..720) | "click" | "quit")
const libc = Deno.dlopen("libc.so.6", {
  open: { parameters: ["buffer", "i32", "i32"], result: "i32" },
  write: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  ioctl: { parameters: ["i32", "u64", "u64"], result: "i32" },
  close: { parameters: ["i32"], result: "i32" },
});
const cstr = (s: string) => new TextEncoder().encode(s + "\0");

const O_WRONLY = 1, O_NONBLOCK = 0o4000;
const EV_SYN = 0x00, EV_KEY = 0x01, EV_ABS = 0x03;
const ABS_X = 0x00, ABS_Y = 0x01, BTN_LEFT = 0x110;
const UI_DEV_CREATE = 0x5501n, UI_DEV_DESTROY = 0x5502n;
// _IOW('U', N, int): UI_SET_EVBIT=100, UI_SET_KEYBIT=101, UI_SET_ABSBIT=103, UI_SET_PROPBIT=110.
const UI_SET_EVBIT = 0x40045564n, UI_SET_KEYBIT = 0x40045565n, UI_SET_ABSBIT = 0x40045567n;
const UI_SET_PROPBIT = 0x4004556en;
const INPUT_PROP_POINTER = 0x00;  // mark this absolute device as a POINTER (mouse-like), not a joystick

const MAXX = 1280, MAXY = 720;

const fd = libc.symbols.open(cstr("/dev/uinput"), O_WRONLY | O_NONBLOCK, 0);
if (fd < 0) { console.error("open /dev/uinput failed"); Deno.exit(1); }
function ioctl(req: bigint, arg: number) {
  if (libc.symbols.ioctl(fd, req, BigInt(arg)) < 0) throw new Error(`ioctl ${req}`);
}
ioctl(UI_SET_EVBIT, EV_KEY); ioctl(UI_SET_KEYBIT, BTN_LEFT);
ioctl(UI_SET_EVBIT, EV_ABS); ioctl(UI_SET_ABSBIT, ABS_X); ioctl(UI_SET_ABSBIT, ABS_Y);
ioctl(UI_SET_PROPBIT, INPUT_PROP_POINTER);  // classify as an absolute POINTER (libinput pointer, not js)

// struct uinput_user_dev: char name[80]; input_id{u16 bus,vendor,product,version}; u32 ff_max;
// s32 absmax[64], absmin[64], absfuzz[64], absflat[64]  (ABS_CNT=64).
const ABS_OFF = 80 + 8 + 4;           // start of absmax[]
const dev = new Uint8Array(ABS_OFF + 64 * 4 * 4);
dev.set(new TextEncoder().encode("vita-test-mouse").subarray(0, 79), 0);
const dvv = new DataView(dev.buffer);
dvv.setUint16(80, 3, true); dvv.setUint16(82, 0x1234, true);   // bus=USB, vendor
dvv.setUint16(84, 0x5678, true); dvv.setUint16(86, 1, true);   // product, version
// absmax[ABS_X]=MAXX, absmax[ABS_Y]=MAXY ; absmin = 0 (already zero).
dvv.setInt32(ABS_OFF + ABS_X * 4, MAXX, true);
dvv.setInt32(ABS_OFF + ABS_Y * 4, MAXY, true);
libc.symbols.write(fd, dev, BigInt(dev.length));
libc.symbols.ioctl(fd, UI_DEV_CREATE, 0n);

function emit(type: number, code: number, value: number) {
  const b = new Uint8Array(24);
  const v = new DataView(b.buffer);
  v.setUint16(16, type, true); v.setUint16(18, code, true); v.setInt32(20, value, true);
  libc.symbols.write(fd, b, 24n);
}
const syn = () => emit(EV_SYN, 0, 0);
function moveto(x: number, y: number) {
  emit(EV_ABS, ABS_X, Math.max(0, Math.min(MAXX, x)));
  emit(EV_ABS, ABS_Y, Math.max(0, Math.min(MAXY, y)));
  syn();
}
function click() { emit(EV_KEY, BTN_LEFT, 1); syn(); emit(EV_KEY, BTN_LEFT, 0); syn(); }

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
    else if (line.startsWith("moveto ")) { const [, x, y] = line.split(/\s+/); moveto(parseInt(x ?? ""), parseInt(y ?? "")); }
  }
}
