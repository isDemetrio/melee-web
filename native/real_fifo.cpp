// Offline host adapter for the port's real GX decoder (Q10(a) experiment).
// SPDX-License-Identifier: GPL-2.0-or-later
#include "headless.h"
#include "gx_core.h"

namespace {
// Keep the decoder attached to a stable forwarding backend. gx::init resets GX state,
// so it must not be used to detach after device loss, including during submit_frame.
struct Forwarder final : gx::Backend {
  gx::Backend* target = nullptr;
  void submit_frame(const gx::Frame& frame) override {
    if (target) target->submit_frame(frame);
  }
  void submit_and_recycle(gx::Frame& frame) override {
    if (target) target->submit_and_recycle(frame);
    else frame.clear();
  }
};
Forwarder forwarder;
void ensure_initialized() {
  static const bool initialized = [] { gx::init(&forwarder); return true; }();
  (void)initialized;
}
}
namespace host {
void gx_set_backend(gx::Backend* backend) {
  ensure_initialized();
  forwarder.target = backend;
}
void gx_write(uint32_t value, int bytes) {
  if (bytes < 1 || bytes > 4) die("invalid FIFO write size");
  ensure_initialized();
  gx::write_fifo(value, bytes);
}
}
