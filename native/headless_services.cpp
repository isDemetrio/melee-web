// Explicit boundaries of the offline headless reference.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "headless.h"
#include "audio.h"
#include "lcancel.h"
#include "user_gecko.h"
#include "exi_slippi.h"
#include "slippi_online.h"
#include "pc_settings_guest.h"
namespace host {
// Replaces WinMM output only. hle_stubs/audio_tick and AX still mix into real RAM/ARAM.
void audio_push(const uint8_t*, size_t) {}
void audio_push_native(const uint8_t*, size_t) {}
// Replaces USB/HID motors and calibration: scripted input has neither hardware nor drift.
void gcadapter_recalibrate(int) {}
void switchpro_recalibrate(int) {}
void input_rumble(int, bool) {}
void input_rumble_local(bool) {}
}
// Replaces optional user settings. No automatic input injection or user Gecko codes in this target.
namespace lcancel { void apply(host::PadState[4]) {} }
namespace user_gecko { void apply() {} }
namespace slippi::online {
bool is_online_match() { return false; }
int local_player_slot() { return -1; }
// Offline guest: there are no online display names to overlay.
std::array<std::string, 4> player_names_for_overlay() { return {}; }
}
namespace slippi {
// TODO(portability): implement the real Slippi EXI service before accepting Slippi translations.
// These are fatal guards, not dummy device replies. Boot rejects Slippi-enabled code first.
void dma_write(uint32_t, uint32_t) { host::die("TODO(portability): Slippi EXI DMA write"); }
void dma_read(uint32_t, uint32_t) { host::die("TODO(portability): Slippi EXI DMA read"); }
void imm_write(uint32_t, uint32_t) { host::die("TODO(portability): Slippi EXI immediate write"); }
uint32_t imm_read(uint32_t) { host::die("TODO(portability): Slippi EXI immediate read"); }
}
namespace gx {
// Patch 0007 separates this UI notification from the guest-memory write in gx_core.
// This target has no desktop PC Settings window to open; gx_core retains the write.
void settings_guest_options_frame(uint8_t, uint16_t, uint32_t) {}
}
