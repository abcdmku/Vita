(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "sched_yield"
    (func $sched_yield (result i32)))
  (memory $memory 1)
  (export "memory" (memory $memory))
  (export "_start" (func $_start))
  (data (i32.const 16) "VITA-WASM-CAPSULE: sentinel=OK\n")
  (func $_start
    (i32.store (i32.const 0) (i32.const 16))
    (i32.store (i32.const 4) (i32.const 31))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))
    (loop $hold
      (drop (call $sched_yield))
      (br $hold))))
