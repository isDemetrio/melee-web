// Linux reference host, adapted from pinned port/runtime/host/host.cpp.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "headless.h"
#include "memory_range.h"
#include "guest_registry.h"
#include "guest_symbols.h"
#include "ax_ucode.h"
#include "gecko_data.h"
#include "wasm/compat/sha1.h"
#include <chrono>
#ifdef MELEE_OFFLINE_COST
#include <emscripten/emscripten.h>
#endif
#include <mutex>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <thread>
#include <strings.h>
namespace hle { void audio_tick(bool); void dvd_poll(); void dvd_settle(); }
namespace host {
Options options;
std::string dol_path;
std::string sim_times_path;
uint8_t* ram = nullptr;
uint32_t ram_size = ppc::RAM_SIZE;
uint8_t* aram = nullptr;
ppc::Context* cpu = nullptr;

static FILE* g_disc = nullptr;
static FILE* g_state_trace = nullptr;
static FILE* g_state_digest = nullptr;
static FILE* g_sim_times = nullptr;
static std::chrono::steady_clock::time_point g_sim_resume;
static uint32_t g_fst_offset, g_fst_size, g_fst_max;
static std::deque<Completion> g_completions;
static bool g_pe_finish_pending = false;
static bool g_pe_token_pending = false;
static uint16_t g_pe_token = 0;
static uint32_t g_retraces = 0;
static std::atomic<uint32_t> g_profiler_frame{0};
static std::vector<uint32_t> g_slow_sim_frames;
static std::atomic<bool> g_exit{false};
static std::atomic<int> g_exit_code{0};
static std::chrono::steady_clock::time_point g_next_frame;
static uint8_t g_mmio[0x10000];      // 0xCC000000 - 0xCC00FFFF register file (big-endian bytes)
static bool g_in_interrupt = false;

// Replaces the Windows asynchronous log writer; diagnostics never pollute CSV stdout.
static std::mutex log_mutex;
void log(const char* fmt, ...) {
  std::lock_guard<std::mutex> lock(log_mutex);
  va_list args; va_start(args, fmt); vfprintf(stderr, fmt, args); va_end(args);
  fputc('\n', stderr);
}
void log_guest_text(const char* data, size_t len) { fwrite(data, 1, len, stderr); }
void log_flush() { fflush(stderr); }
[[noreturn]] void die(const char* fmt, ...) {
  va_list args; va_start(args, fmt); fputs("FATAL: ", stderr);
  vfprintf(stderr, fmt, args); va_end(args); fputc('\n', stderr); std::fflush(nullptr); std::_Exit(1);
}
// Cost accounting is diagnostic only; replace Windows calibrated TSC profiling.
const double tsc_seconds = 0;
#ifdef MELEE_OFFLINE_COST
static double g_cost_seconds[SIM_COST_COUNT]{};
static uint64_t g_cost_calls[SIM_COST_COUNT]{};
static FILE* g_decoder_cost = nullptr;
static void reset_decoder_cost() {
  std::memset(g_cost_seconds, 0, sizeof g_cost_seconds);
  std::memset(g_cost_calls, 0, sizeof g_cost_calls);
}
void sim_cost_add(int slot, double seconds) {
  if (slot >= 0 && slot < SIM_COST_COUNT) {
    g_cost_seconds[slot] += seconds;
    ++g_cost_calls[slot];
  }
}
// Called once by the spike worker, after /work exists and before callMain.
extern "C" EMSCRIPTEN_KEEPALIVE int melee_decoder_cost(int mode) {
  if (mode < 0 || mode > 2 || g_decoder_cost || g_retraces) return 0;
  if (mode == 1) {
    g_decoder_cost = std::fopen("/work/decoder_cost.csv", "w");
    if (!g_decoder_cost) return 0;
    std::fputs("retrace,sim_ms,match_frame,record_ms,texture_ms,observer_ms,rest_ms,decode_ms,decode_rest_ms,non_decode_ms,record_calls,texture_calls,observer_calls,decode_calls\n", g_decoder_cost);
  }
  reset_decoder_cost();
  offline_cost_mode = mode;
  return 1;
}
static void record_decoder_cost(double sim_ms, uint32_t match_frame) {
  if (!g_decoder_cost) return;
  const double record = g_cost_seconds[SIM_RECORD] * 1000;
  const double texture = g_cost_seconds[SIM_SNAPSHOT] * 1000;
  const double observer = g_cost_seconds[SIM_OBSERVE] * 1000;
  const double decode = g_cost_seconds[SIM_DECODE] * 1000;
  // Exclusive phases sum to sim_ms. Preserve signed residuals: never hide bad accounting.
  std::fprintf(g_decoder_cost, "%u,%.6f,%u,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%llu,%llu,%llu,%llu\n",
      g_retraces, sim_ms, match_frame, record - texture - observer, texture, observer,
      sim_ms - record, decode, decode - record, sim_ms - decode,
      (unsigned long long)g_cost_calls[SIM_RECORD], (unsigned long long)g_cost_calls[SIM_SNAPSHOT],
      (unsigned long long)g_cost_calls[SIM_OBSERVE], (unsigned long long)g_cost_calls[SIM_DECODE]);
  std::fflush(g_decoder_cost);
}
#else
void sim_cost_add(int, double) {}
#endif
// No adapter/presentation latency instrumentation in the offline host.
TickTiming& tick_timing() { static TickTiming timing; return timing; }
double now_seconds() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
const char* symbol_name(uint32_t addr) {
  // Binary search the sorted function name table for the containing function.
  size_t lo = 0, hi = guest::name_table_count;
  while (lo < hi) {
    size_t mid = (lo + hi) / 2;
    if (guest::name_table[mid].addr <= addr) lo = mid + 1; else hi = mid;
  }
  if (lo == 0) return "?";
  return guest::name_table[lo - 1].name;
}

// ---------------- memory ----------------
uint8_t* game_image = nullptr;
uint32_t game_image_size = 0;
uint8_t* try_ptr(uint32_t addr, uint32_t bytes) {
  uint32_t off = addr & 0x3FFFFFFFu;
  if (valid_range(off, bytes, ram_size)) return ram + off;
  constexpr uint32_t IMAGE_PHYS = 0x10000000u;
  if (game_image && off >= IMAGE_PHYS && valid_range(off - IMAGE_PHYS, bytes, game_image_size)) return game_image + (off - IMAGE_PHYS);
  return nullptr;
}
uint8_t* ptr(uint32_t addr, uint32_t bytes) {
  uint8_t* p = try_ptr(addr, bytes);
  if (!p) die("host access outside RAM: %08X+%X", addr, bytes);
  return p;
}
uint32_t rd32(uint32_t a) { uint32_t v; std::memcpy(&v, ptr(a, 4), 4); return _byteswap_ulong(v); }
uint16_t rd16(uint32_t a) { uint16_t v; std::memcpy(&v, ptr(a, 2), 2); return _byteswap_ushort(v); }
uint8_t rd8(uint32_t a) { return *ptr(a); }
void mark_ram_write(uint32_t a, uint32_t bytes) { ppc::mark_ram_write(a, bytes); }
void wr32(uint32_t a, uint32_t v) { v = _byteswap_ulong(v); std::memcpy(ptr(a, 4), &v, 4); mark_ram_write(a, 4); }
void wr16(uint32_t a, uint16_t v) { v = _byteswap_ushort(v); std::memcpy(ptr(a, 2), &v, 2); mark_ram_write(a, 2); }
void wr8(uint32_t a, uint8_t v) { *ptr(a) = v; mark_ram_write(a, 1); }
std::string cstr(uint32_t addr, size_t max) {
  std::string s;
  for (size_t i = 0; i < max; ++i) { char ch = (char)rd8(addr + (uint32_t)i); if (!ch) break; s += ch; }
  return s;
}

// ---------------- disc ----------------
bool disc_open(const std::string& path) {
  g_disc = std::fopen(path.c_str(), "rb");
  if (!g_disc) return false;
  uint8_t hdr[0x440];
  if (!disc_read(0, hdr, sizeof hdr)) return false;
  auto be = [&](int o) { return ((uint32_t)hdr[o] << 24) | ((uint32_t)hdr[o + 1] << 16) | ((uint32_t)hdr[o + 2] << 8) | hdr[o + 3]; };
  g_fst_offset = be(0x424);
  g_fst_size = be(0x428);
  g_fst_max = be(0x42C);
  if (std::memcmp(hdr, "GALE01", 6) != 0) log("warning: disc id is not GALE01");
  return true;
}
uint64_t g_disc_reads = 0, g_disc_bytes = 0;
static std::mutex g_disc_mutex;   // the DVD worker and the simulation thread share the file
bool disc_read(uint32_t offset, void* dst, uint32_t size) {
  std::lock_guard<std::mutex> lk(g_disc_mutex);
  if (!g_disc) return false;
  if (fseeko(g_disc, offset, SEEK_SET) != 0) return false;
  ++g_disc_reads;
  g_disc_bytes += size;
  bool ok = std::fread(dst, 1, size, g_disc) == size;
  auto* output = (uint8_t*)dst;
  if (ok && ram && output >= ram && output <= ram + ppc::RAM_SIZE &&
      size <= (uint32_t)(ram + ppc::RAM_SIZE - output))
    ppc::mark_ram_write(ppc::RAM_BASE + (uint32_t)(output - ram), size);
  return ok;
}
bool disc_read_file(uint32_t vanilla_file_start, uint32_t file_offset, void* dst, uint32_t size) {
  // Replaces cosmetic overrides: this reference uses unmodified ISO assets only.
  uint64_t absolute = (uint64_t)vanilla_file_start + file_offset;
  if (absolute > UINT32_MAX) return false;
  return disc_read((uint32_t)absolute, dst, size);
}
uint32_t disc_fst_offset() { return g_fst_offset; }
uint32_t disc_fst_size() { return g_fst_size; }

// Looks a file up by name in the disc's FST (root and nested directories; exact match first,
// then case-insensitive). Used to serve ISO files to host-side loaders (Slippi game files).
bool disc_find_file(const std::string& name, uint32_t* offset, uint32_t* size) {
  static std::vector<uint8_t> fst;
  if (fst.empty()) {
    if (!g_fst_size) return false;
    fst.resize(g_fst_size);
    if (!disc_read(g_fst_offset, fst.data(), g_fst_size)) { fst.clear(); return false; }
  }
  auto be32 = [&](size_t o) { return o + 4 <= fst.size() ? ((uint32_t)fst[o] << 24) | ((uint32_t)fst[o + 1] << 16) | ((uint32_t)fst[o + 2] << 8) | fst[o + 3] : 0u; };
  uint32_t entries = be32(8);
  size_t strings = (size_t)entries * 12;
  if (strings > fst.size()) return false;
  for (int pass = 0; pass < 2; ++pass) {
    for (uint32_t i = 1; i < entries; ++i) {
      uint32_t a = be32(i * 12);
      if (a >> 24) continue;   // directory
      size_t so = strings + (a & 0xFFFFFF);
      if (so >= fst.size()) continue;
      const char* n = (const char*)&fst[so];
      size_t maxlen = fst.size() - so;
      bool match = pass == 0 ? (std::strncmp(n, name.c_str(), maxlen) == 0) : (strncasecmp(n, name.c_str(), maxlen) == 0);
      if (match && std::strlen(n) == name.size()) {
        if (offset) *offset = be32(i * 12 + 4);
        if (size) *size = be32(i * 12 + 8);
        return true;
      }
    }
  }
  return false;
}
uint32_t disc_fst_max_size() { return g_fst_max; }

// ---------------- boot ----------------
static uint32_t disc_dol_offset() {
  uint8_t hdr[4];
  if (!disc_read(0x420, hdr, 4)) die("cannot read disc DOL offset");
  return ((uint32_t)hdr[0] << 24) | ((uint32_t)hdr[1] << 16) | ((uint32_t)hdr[2] << 8) | hdr[3];
}
// An explicit DOL can supply boot sections, but DVD/FST still require the ISO.
static bool read_dol(uint32_t offset, void* dst, uint32_t size) {
  if (dol_path.empty()) {
    const uint64_t absolute = uint64_t(disc_dol_offset()) + offset;
    return absolute <= UINT32_MAX && disc_read(uint32_t(absolute), dst, size);
  }
  FILE* file = std::fopen(dol_path.c_str(), "rb");
  if (!file) return false;
  const bool ok = fseeko(file, offset, SEEK_SET) == 0 && std::fread(dst, 1, size, file) == size;
  std::fclose(file);
  return ok;
}
// Both engines are built for the retail main.dol: the recompiled one runs its code, the native one
// reads its data. A modded disc (a patched DOL, m-ex and friends) fails the SHA-1 of NTSC 1.02.
bool disc_has_vanilla_dol() {
  constexpr uint32_t dol_size = 0x4385E0u;
  std::vector<uint8_t> image(dol_size);
  if (!read_dol(0, image.data(), dol_size)) die("cannot read full Melee DOL");
  // Shared portable retail SHA-1 gate on native and WASM.
  const auto digest = wasm_compat::sha1(image.data(), image.size());
  const uint8_t expected[20] = {0x08,0xe0,0xbf,0x20,0x13,0x4d,0xfc,0xb2,0x60,0x69,0x96,0x71,0x00,0x45,0x27,0xb2,0xd6,0xbb,0x1a,0x45};
  return std::memcmp(digest.data(), expected, 20) == 0;
}
static void load_dol_from_disc() {
  const uint32_t dol_offset = dol_path.empty() ? disc_dol_offset() : 0;
  if (!disc_has_vanilla_dol())
    die("ISO DOL does not match vanilla Melee NTSC 1.02; recompiled code cannot run this image");
  uint8_t dh[0x100];
  if (!read_dol(0, dh, sizeof dh)) die("cannot read DOL header");
  auto be = [&](int o) { return ((uint32_t)dh[o] << 24) | ((uint32_t)dh[o + 1] << 16) | ((uint32_t)dh[o + 2] << 8) | dh[o + 3]; };
  for (int i = 0; i < 18; ++i) {
    uint32_t off = be(i * 4), addr = be(0x48 + i * 4), size = be(0x90 + i * 4);
    if (!size) continue;
    if (!read_dol(off, ptr(addr, size), size)) die("cannot read DOL section %d", i);
  }
  // The DOL header's bss range overlaps the loaded .sdata section; the guest's own
  // __init_data zeroes .bss/.sbss precisely and RAM starts zeroed, so do not memset here.
  log("boot: DOL loaded from disc offset %08X, bss %08X+%X, entry %08X", dol_offset, be(0xD8), be(0xDC), be(0xE0));
}

void init_state_digest() {
  if (!options.state_digest.empty()) {
    g_state_digest = std::fopen(options.state_digest.c_str(), "w");
    if (!g_state_digest) die("cannot open state digest");
    std::fprintf(g_state_digest, "frame,rng,scene");
    for (unsigned slot = 0; slot < 6; ++slot)
      for (const char* field : {"present", "stocks", "action", "anim_frame", "pos_x", "pos_y", "pos_z",
                                "vel_x", "vel_y", "vel_z", "percent", "facing"})
        std::fprintf(g_state_digest, ",p%u_%s", slot, field);
    std::fprintf(g_state_digest, ",scene_major,match_frame");
    std::fputc('\n', g_state_digest);
  }
}

void boot_setup() {
  init_state_digest();
  if (!options.state_trace.empty()) {
    g_state_trace = options.state_trace == "-" ? stdout : std::fopen(options.state_trace.c_str(), "w");
    if (!g_state_trace) die("cannot open state trace");
    std::fprintf(g_state_trace, "retrace,cpu,ram,aram,events\n");
  }
  if (!sim_times_path.empty()) {
    g_sim_times = std::fopen(sim_times_path.c_str(), "w");
    if (!g_sim_times) die("cannot open sim times");
    std::fprintf(g_sim_times, "retrace,sim_ms,match_frame\n");
  }
  ram = (uint8_t*)std::calloc(ppc::RAM_SIZE + 64, 1);
  aram = (uint8_t*)std::calloc(0x01000000, 1);
  ax::set_memory({rd16, rd32, wr16, wr32, aram, 0x01000000});
  ax::reset();
  cpu = new ppc::Context();
  std::memset(cpu, 0, sizeof *cpu);
  if (!ram || !aram) die("out of memory");
  std::memset(g_mmio, 0, sizeof g_mmio);

  load_dol_from_disc();

  // Low memory, mirroring Dolphin's Boot_BS2Emu.cpp (GC path) plus what the apploader leaves.
  disc_read(0, ptr(0x80000000, 0x20), 0x20);              // disc id
  wr32(0x80000020, 0x0D15EA5E);                      // booted from bootrom
  wr32(0x80000028, ppc::RAM_SIZE);                   // physical memory size
  wr32(0x8000002C, 0x10000006);                      // console type (Dolphin reports devkit)
  wr32(0x80000030, 0);                               // arena lo (0 = use linker default)
  wr32(0x800000CC, 0);                               // NTSC
  wr32(0x800000D0, 0x01000000);                      // ARAM size
  wr32(0x800000F0, ppc::RAM_SIZE);                   // simulated memory size
  wr32(0x800000F8, 0x09A7EC80);                      // bus clock
  wr32(0x800000FC, 0x1CF7C580);                      // cpu clock
  wr32(0x80000300, 0x4C000064);                      // rfi stubs
  wr32(0x80000800, 0x4C000064);
  wr32(0x80000C00, 0x4C000064);
  uint64_t tb = options.time_base;
  if (!tb) {
    // Dolphin presets the timebase from the RTC (seconds since GC epoch 2000-01-01) * 40.5 MHz.
    auto now = std::chrono::system_clock::now().time_since_epoch();
    uint64_t secs = (uint64_t)std::chrono::duration_cast<std::chrono::seconds>(now).count();
    const uint64_t GC_EPOCH = 946684800ull;
    tb = (secs - GC_EPOCH) * TB_HZ;
  }
  // Like Dolphin: the timebase register starts near zero; 0x800030D8 holds the epoch adjust
  // that __OSGetSystemTime adds to mftb.
  wr32(0x800030D8, (uint32_t)(tb >> 32));
  wr32(0x800030DC, (uint32_t)tb);
  cpu->tb = 0;

  // Apploader: FST at the top of RAM, arena hi below it.
  if (!valid_range(0, g_fst_max, ppc::RAM_SIZE) || g_fst_size > g_fst_max) die("invalid FST size");
  uint32_t fst_addr = (0x81800000u - g_fst_max) & ~31u;
  if (!disc_read(g_fst_offset, ptr(fst_addr, g_fst_size), g_fst_size)) die("cannot read FST");
  wr32(0x80000038, fst_addr);
  wr32(0x8000003C, g_fst_max);
  wr32(0x80000034, fst_addr);                        // arena hi
  log("boot: FST %u bytes at %08X (max %X), arena hi %08X", g_fst_size, fst_addr, g_fst_max, fst_addr);
  // TODO(portability): port Slippi EXI, game-file service and code installation together.
  // Never boot a translated Slippi guest with fake EXI replies.
  if (gecko::codehandler_bin_size || gecko::slippi_gct_size)
    die("TODO(portability): Slippi EXI unavailable; regenerate with --no-slippi");

  cpu->msr = 0x00002030u | 0x8000u;                  // FP | DR | IR | EE
  cpu->fpscr = 0;
  ppc::update_mxcsr(*cpu);
  g_next_frame = std::chrono::steady_clock::now();
  g_sim_resume = g_next_frame;
#ifdef MELEE_OFFLINE_COST
  reset_decoder_cost(); // Match the first sim interval; exclude boot/loading before it.
#endif
}

// ---------------- guest calls from host ----------------
void call_guest(uint32_t addr, uint32_t r3, uint32_t r4, uint32_t r5, uint32_t r6) {
  ppc::Context& c = *cpu;
  uint32_t saved_lr = c.lr;
  c.r[3] = r3; c.r[4] = r4; c.r[5] = r5; c.r[6] = r6;
  c.lr = 0;
  ppc::call(c, ram, addr);
  c.lr = saved_lr;
}

// ---------------- events ----------------
void post_completion(Completion fn) { g_completions.push_back(std::move(fn)); }
void set_pe_finish_pending() { g_pe_finish_pending = true; }
void set_pe_token_pending(uint16_t token) { g_pe_token = token; g_pe_token_pending = true; }
bool exit_requested() { return g_exit; }
void request_exit(int code) { g_exit_code.store(code); g_exit.store(true); }
int exit_code() { return g_exit_code.load(); }
uint32_t retrace_count() { return g_retraces; }
uint32_t profiler_frame_id() { return g_profiler_frame.load(std::memory_order_relaxed); }
const std::vector<uint32_t>& slow_sim_frames() { return g_slow_sim_frames; }
// The VI retrace is periodic in virtual time, like the hardware interrupt: `g_next_retrace_tb`
// is the timebase value of the next retrace. A sleeping guest (wait_event) jumps time straight
// to that boundary; a guest that busy-waits with interrupts enabled advances time in small steps
// at HLE entry points and loop polls and takes the retrace when it crosses the boundary (Slippi's
// lag-reduction code waits for pad data that the retrace path produces).
static uint64_t g_next_retrace_tb = TB_PER_FRAME;
static bool g_in_retrace = false;
void (*native_retrace)() = nullptr;
void (*native_state_snapshot)(MuStatePod*) = nullptr;
bool retrace_due() { return cpu->tb >= g_next_retrace_tb && !g_in_retrace; }
uint64_t next_retrace_tb() { return g_next_retrace_tb; }
void advance_time(uint64_t ticks) { cpu->tb += ticks; }
static void advance_frame() {
  if (cpu->tb < g_next_retrace_tb) cpu->tb = g_next_retrace_tb;   // idle: jump to the boundary
  g_next_retrace_tb += TB_PER_FRAME;
}

void deliver_interrupt(uint32_t number) {
  // __OSInterruptHandlerTable lives at 0x80003040 (OS_INTERRUPTTABLE_ADDR).
  uint32_t handler = rd32(0x80003040u + number * 4);
  if (!handler) return;
  uint32_t context = rd32(0x800000D4u);  // OS current context (virtual address)
  ppc::Context& c = *cpu;
  ppc::Context saved = c;                // handlers clobber registers; restore like an rfi would
  bool was = g_in_interrupt;
  g_in_interrupt = true;
  try {
    call_guest(handler, number, context);
  } catch (const LoadContextUnwind&) {
  }
  g_in_interrupt = was;
  uint64_t tb = c.tb;
  c = saved;
  c.tb = tb;
  ppc::update_mxcsr(c);
}

static void fire_due_alarms(bool force);
static bool deliver_completions(bool force);

static void validate_alarm_queue(const char* where);
void pump_completions() {
  // Called from HLE entry points the guest polls. Virtual time flows a little so periodic
  // alarms (pad sampling) fire even in loops that never sleep. Nothing is delivered while the
  // guest has interrupts disabled; ppc::mtmsr flushes when they come back on.
  advance_time(2048);
  hle::dvd_poll();
  validate_alarm_queue("hle entry");
  if (!ppc::interrupts_on(*cpu)) return;
  fire_due_alarms(false);
  hle::audio_tick(false);
  deliver_completions(false);
  if (cpu->tb >= g_next_retrace_tb && !g_in_retrace) retrace();   // periodic VI interrupt during busy waits
}

// Diagnostic: the OSAlarm queue must only ever link alarms whose handlers are code. A corrupt
// link is reported at the first HLE entry after it appears so the call trace points at the writer.
static void validate_alarm_queue(const char* where) {
  static bool reported = false;
  if (reported) return;
  uint32_t a = rd32(gs::AlarmQueue), prev = 0;
  for (int guard = 0; a && guard < 64; ++guard) {
    bool bad = a < 0x80003000u || a >= 0x81800000u;
    uint32_t handler = bad ? 0 : rd32(a);
    // Handlers live in the DOL's text or in the Slippi code table caves; nothing else is code.
    bool code = (handler >= 0x80003100u && handler < 0x803B7240u) || (handler >= 0x8065C000u && handler < 0x8071B000u);
    if (!bad) bad = !code || (handler & 3) || rd32(a + 16) != prev;
    if (bad) {
      reported = true;
      log("ALARM QUEUE CORRUPT (%s): entry %08X handler %08X prev %08X (expected %08X) next %08X head %08X tail %08X retrace %u",
          where, a, handler, bad && a >= 0x80003000u && a < 0x81800000u ? rd32(a + 16) : 0, prev, a >= 0x80003000u && a < 0x81800000u ? rd32(a + 20) : 0,
          rd32(gs::AlarmQueue), rd32(gs::AlarmQueue + 4), g_retraces);
      ppc::fatal(*cpu, "alarm queue corrupt", a);
      return;
    }
    prev = a; a = rd32(a + 20);
  }
}

static void fire_due_alarms(bool force) {
  // OSAlarm queue head lives in the SDK's static AlarmQueue; fire through the installed
  // decrementer exception handler (OSExceptionTable[8] at 0x80003000 + 8*4) so the guest's
  // own callback logic runs. The handler expects an exception frame; the asm wrapper just
  // saves GPRs into the context and tail-calls DecrementerExceptionCallback, which processes
  // one alarm and re-arms periodic ones, so loop while the head is due.
  static bool firing = false;
  if (firing) return;
  if (!force && !ppc::interrupts_on(*cpu)) return;
  firing = true;
  for (int guard = 0; guard < 16; ++guard) {
    validate_alarm_queue(guard ? "after previous alarm handler" : "entry");
    uint32_t head = rd32(gs::AlarmQueue);
    if (!head) break;
    uint64_t fire = ((uint64_t)rd32(head + 8) << 32) | rd32(head + 12);
    // Alarm times are OS system time: timebase + the adjust at 0x800030D8.
    uint64_t adjust = ((uint64_t)rd32(0x800030D8u) << 32) | rd32(0x800030DCu);
    if ((int64_t)fire > (int64_t)(cpu->tb + adjust)) break;
    uint32_t handler = rd32(0x80003000u + 8 * 4);
    if (!handler) break;
    uint32_t context = rd32(0x800000D4u);
    static int reported = 0;
    if (options.trace_calls && reported++ < 40)
      log("[alarm] head=%08X fire=%llu tb=%llu handler=%08X cb=%08X period=%llu", head, (unsigned long long)fire, (unsigned long long)cpu->tb,
          handler, rd32(head), (unsigned long long)(((uint64_t)rd32(head + 24) << 32) | rd32(head + 28)));
    ppc::Context& c = *cpu;
    ppc::Context saved = c;
    try {
      call_guest(handler, 8, context);
    } catch (const LoadContextUnwind&) {
    }
    uint64_t tb = c.tb;
    c = saved;
    c.tb = tb;
    ppc::update_mxcsr(c);
    static char where[64];
    std::snprintf(where, sizeof where, "after alarm %08X handler %08X", head, rd32(head));
    validate_alarm_queue(where);
  }
  firing = false;
}

bool g_has_window = false;

uint64_t hash_bytes(const void* data, size_t len) {
  const uint8_t* p = (const uint8_t*)data;
  uint64_t h = 0xcbf29ce484222325ull;
  size_t i = 0;
  for (; i + 8 <= len; i += 8) { uint64_t v; std::memcpy(&v, p + i, 8); h = (h ^ v) * 0x100000001b3ull; h ^= h >> 29; }
  for (; i < len; ++i) { h = (h ^ p[i]) * 0x100000001b3ull; }
  return h;
}
// Field-wise CPU hash excludes C++ padding and diagnostic counters/trace history.
static void trace_state() {
  if (!g_state_trace) return;
  hle::dvd_settle();   // a disc read still being copied in would make the RAM hash depend on the machine's load
  uint64_t h = 0;
  auto add = [&](const auto& v) { h = (h ^ hash_bytes(&v, sizeof v)) * 0x100000001b3ull; };
  const auto& c = *cpu;
  add(c.r); add(c.f); add(c.cr); add(c.lr); add(c.ctr);
  add(c.ca); add(c.so); add(c.ov); add(c.fpscr); add(c.gqr);
  add(c.msr); add(c.hid0); add(c.hid2); add(c.dec); add(c.tb); add(c.spr);
  uint64_t events = (uint64_t)g_completions.size() << 32 |
      (uint64_t)g_pe_token << 8 | (g_pe_finish_pending ? 1 : 0) | (g_pe_token_pending ? 2 : 0);
  std::fprintf(g_state_trace, "%u,%016llX,%016llX,%016llX,%016llX\n", g_retraces,
      (unsigned long long)h, (unsigned long long)hash_bytes(ram, ppc::RAM_SIZE),
      (unsigned long long)hash_bytes(aram, 0x01000000), (unsigned long long)events);
  std::fflush(g_state_trace);
}

// Just the scene fields, cheap enough to call every retrace when an @scene script needs to know
// when the game reaches a particular mode/state (window.cpp). Shares the same addresses
// digest_state() uses for the full snapshot so the two never disagree about what "scene" means.
void current_scene(uint32_t* major, uint32_t* minor, uint32_t* match_frame) {
  if (native_state_snapshot) {
    MuStatePod state{};
    native_state_snapshot(&state);
    *major = state.scene_major;
    *minor = state.scene;
    *match_frame = state.match_frame;
  } else {
    *major = rd8(0x80479D30u);   // GameRouting::curr_mode (state_machine + 0)
    *minor = rd8(0x80479D33u);   // GameRouting::curr_state_id (state_machine + 3)
    *match_frame = rd32(0x8046B6C4u); // VsSceneController state frame count
  }
}

static void digest_state() {
  if (!g_state_digest) return;
  MuStatePod state{};
  if (native_state_snapshot) {
    native_state_snapshot(&state);
  } else {
    const uint32_t seed = rd32(0x804D5F94u);
    if (seed && try_ptr(seed, 4)) state.rng = rd32(seed);
    state.scene = rd8(0x80479D33u);         // GameRouting::curr_state_id (state_machine + 3)
    state.scene_major = rd8(0x80479D30u);   // GameRouting::curr_mode (state_machine + 0)
    state.match_frame = rd32(0x8046B6C4u);  // VsSceneController(0x8046B6A0)->state.frame_count (+0x24)
    for (uint32_t slot = 0; slot < 6; ++slot) {
      const uint32_t player = 0x80453080u + slot * 0xE90u;
      if (rd32(player) != 2) continue;
      const uint32_t active = rd8(player + 0xCu);
      const uint32_t gobj = rd32(player + 0xB0u + (active & 1u) * 4u);
      if (!gobj || !try_ptr(gobj, 0x30)) continue;
      const uint32_t fp = rd32(gobj + 0x2Cu);
      if (!fp || !try_ptr(fp, 0x1834)) continue;
      if (rd32(fp) != gobj) continue;
      MuFighterState& f = state.player[slot];
      f.present = 1;
      f.stocks = static_cast<int8_t>(rd8(player + 0x8Eu));
      f.action = rd32(fp + 0x10u);
      f.anim_frame = rd32(fp + 0x894u);
      f.pos_x = rd32(fp + 0xB0u); f.pos_y = rd32(fp + 0xB4u); f.pos_z = rd32(fp + 0xB8u);
      f.vel_x = rd32(fp + 0x80u); f.vel_y = rd32(fp + 0x84u); f.vel_z = rd32(fp + 0x88u);
      f.percent = rd32(fp + 0x1830u);
      f.facing = rd32(fp + 0x2Cu);
    }
  }
  std::fprintf(g_state_digest, "%u,%08X,%08X", g_retraces, state.rng, state.scene);
  for (const auto& f : state.player) {
    const uint32_t* words = &f.present;
    for (unsigned index = 0; index < 12; ++index) std::fprintf(g_state_digest, ",%08X", words[index]);
  }
  std::fprintf(g_state_digest, ",%08X,%08X", state.scene_major, state.match_frame);
  std::fputc('\n', g_state_digest);
  std::fflush(g_state_digest);
}

// --sim-times: wall time spent simulating since the previous retrace finished its checkpoint
// bookkeeping, so the 40 MiB of RAM/ARAM hashing below is never counted. --fast only.
static void record_sim_time() {
  if (!g_sim_times) return;
  const auto now = std::chrono::steady_clock::now();
  uint32_t major = 0, minor = 0, match_frame = 0;
  current_scene(&major, &minor, &match_frame);
  const double sim_ms = std::chrono::duration<double, std::milli>(now - g_sim_resume).count();
  std::fprintf(g_sim_times, "%u,%.4f,%u\n", g_retraces, sim_ms, match_frame);
#ifdef MELEE_OFFLINE_COST
  record_decoder_cost(sim_ms, match_frame);
#endif
  std::fflush(g_sim_times);
}

// Same virtual-time and interrupt order as Windows retrace(), without UI/network/profiling.
void retrace() {
  struct Guard { Guard() { g_in_retrace = true; } ~Guard() { g_in_retrace = false; } } guard;
  ++g_retraces;
  advance_frame();
  // Replaces Windows wait_for_tick; --fast avoids wall-clock pacing entirely.
  if (!options.fast) {
    g_next_frame += std::chrono::microseconds(16667);
    auto now = std::chrono::steady_clock::now();
    if (g_next_frame > now) std::this_thread::sleep_until(g_next_frame);
    else if (now - g_next_frame > std::chrono::milliseconds(34)) g_next_frame = now;
  }
  fire_due_alarms(true);
  hle::audio_tick(true);
  uint16_t di0 = ((uint16_t)g_mmio[0x2030] << 8) | g_mmio[0x2031];
  di0 |= 0x8000;
  g_mmio[0x2030] = uint8_t(di0 >> 8); g_mmio[0x2031] = uint8_t(di0);
  deliver_interrupt(24);
  record_sim_time();
  trace_state();
  digest_state();
#ifdef MELEE_OFFLINE_COST
  if (offline_cost_mode == 1) reset_decoder_cost();
#endif
  if (g_sim_times) g_sim_resume = std::chrono::steady_clock::now();
  if (options.frames && g_retraces >= options.frames) request_exit(0);
  if (g_exit) throw ExitRequested{g_exit_code.load()};
}
// Nesting: a callback that sleeps (OSSleepThread inside a DVD/ARQ chain) is a wait point where
// hardware would run further completions, so forced delivery may nest; polled entry points
// (force = false) never nest so callback order stays as posted.
static int g_pump_depth = 0;
static bool deliver_completions(bool force) {
  if (g_completions.empty()) return false;
  if (!force && (g_pump_depth > 0 || !ppc::interrupts_on(*cpu))) return false;
  if (g_pump_depth >= 16) return false;
  ++g_pump_depth;
  size_t n = g_completions.size();
  ppc::Context saved = *cpu;
  for (size_t i = 0; i < n && !g_completions.empty(); ++i) {
    Completion fn = std::move(g_completions.front());
    g_completions.pop_front();
    fn();
  }
  uint64_t tb = cpu->tb;
  *cpu = saved;
  cpu->tb = tb;
  ppc::update_mxcsr(*cpu);
  --g_pump_depth;
  return true;
}

void wait_event() {
  if (g_pe_finish_pending) {
    g_pe_finish_pending = false;
    // PE_ISR (0xCC00100A): finish interrupt status bit 3.
    g_mmio[0x100B] |= 0x08;
    deliver_interrupt(19);  // __OS_INTERRUPT_PI_PE_FINISH
    return;
  }
  if (g_pe_token_pending) {
    g_pe_token_pending = false;
    g_mmio[0x100B] |= 0x04;
    g_mmio[0x100E] = (uint8_t)(g_pe_token >> 8); g_mmio[0x100F] = (uint8_t)g_pe_token;
    deliver_interrupt(18);  // __OS_INTERRUPT_PI_PE_TOKEN
    return;
  }
  // The sleeping thread yields: interrupts are effectively enabled during the switch, so pending
  // completions run now (nested if this sleep happens inside another callback). Otherwise time moves on.
  hle::dvd_poll();
  if (deliver_completions(true)) return;
  retrace();
}

}  // namespace host

namespace ppc {
void loop_poll(Context& c) {
  (void)c;
  host::pump_completions();   // advances time; fires alarms / audio frames / completions when EE is set
}
void interrupts_enabled(Context& c) {
  // Called from mtmsr when EE goes 0 -> 1: flush events that arrived while masked.
  if (host::g_pump_depth == 0) host::deliver_completions(true);   // never nest from inside a callback here
}
}  // namespace ppc

namespace host {

// ---------------- MMIO ----------------
static uint32_t mmio_get(uint32_t off, int bytes) {
  uint32_t v = 0;
  for (int i = 0; i < bytes; ++i) v = (v << 8) | g_mmio[(off + i) & 0xFFFF];
  return v;
}
static void mmio_put(uint32_t off, uint32_t value, int bytes) {
  for (int i = bytes - 1; i >= 0; --i) { g_mmio[(off + i) & 0xFFFF] = (uint8_t)value; value >>= 8; }
}

uint32_t mmio_read(uint32_t addr, int bytes) {
  if ((addr & 0xFFFF0000u) == 0xCC000000u) {
    uint32_t off = addr & 0xFFFF;
    switch (off & 0xFFFE) {
      case 0x2002: return 0;                 // VI: vertical position (VIGetCurrentLine)
      case 0x2000: return 0;
      case 0x0000: return 0;                 // CP status: fifo idle, not overflowed
      case 0x0004: return 0;                 // CP control
      case 0x0034: case 0x0036: return mmio_get(off, bytes);   // CP fifo rw distance (we keep 0)
      case 0x3000: return 0;                 // PI INTSR
      case 0x5004: return 0;                 // DSP mailbox from DSP: nothing pending
      case 0x5000: return 0;                 // DSP mailbox to DSP: not busy
      case 0x500A: return mmio_get(off, bytes) & ~0x0001u;  // DSP CSR: DSP not "reset in progress"
      default: return mmio_get(off, bytes);
    }
  }
  if ((addr & 0xF8000000u) == 0xC8000000u) return 0;  // EFB peek
  static int reported = 0;
  if (reported++ < 20) {
    log("mmio read %08X (%d) from %s lr=%08X", addr, bytes, symbol_name(cpu->last_pc), cpu->lr);
    if (reported <= 2) {
      log("  recent entries:");
      for (uint32_t i = 48; i < 64; ++i) { uint32_t pc = cpu->trace[(cpu->trace_pos + i) & 63]; if (pc) log("    %08X %s", pc, symbol_name(pc)); }
    }
  }
  return 0;
}

void mmio_write(uint32_t addr, uint32_t value, int bytes) {
  if ((addr & 0xFFFFC000u) == 0xCC008000u) { gx_write(value, bytes); return; }
  if ((addr & 0xFFFF0000u) == 0xCC000000u) {
    uint32_t off = addr & 0xFFFF;
    mmio_put(off, value, bytes);
    if (off == 0x3000 || off == 0x3004) return;
    return;
  }
  if ((addr & 0xF8000000u) == 0xC8000000u) return;  // EFB poke
  static int reported = 0;
  if (reported++ < 20) log("mmio write %08X = %08X (%d) from %s", addr, value, bytes, symbol_name(cpu->last_pc));
}

} // namespace host
