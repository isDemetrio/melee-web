/* The C half of the netcode's single-producer / single-consumer ring.
 *
 * The TypeScript half is `web/src/net/sab_ring.ts` and the layout they both implement is written
 * down in `docs/NETCODE_MAP.md`, "Transport". This header is layout plus inline accessors only: no
 * allocation, no logging, no dependency outside <stdint.h>, <stddef.h> and <string.h>, so it can be
 * included from the netcode thread without pulling anything else in.
 *
 * Layout, all little-endian, which is WASM memory order:
 *
 *   control block, 16 bytes = four int32 slots
 *     0  head      byte offset of the next write, in [0, capacity); producer-owned
 *     1  tail      byte offset of the next read,  in [0, capacity); consumer-owned
 *     2  capacity  bytes of the data region; written once by sab_ring_init
 *     3  refused   frames the producer did not enqueue for lack of space
 *   data region, `capacity` bytes, starting at byte 16
 *     frame = [u32 payload length][u8 lane][payload]
 *
 * The rules both halves share, and the reason each one is there:
 *
 *   - `capacity` is a power of two, so the wrap arithmetic is a mask and not a division.
 *   - One byte is left unused: a frame is written only when `used + size < capacity`, so
 *     `head == tail` means "empty" without ambiguity.
 *   - A frame may wrap the end of the data region. The producer writes it as at most two segments
 *     and publishes `head` only after both, so a consumer that loads `head` never sees half a
 *     frame; the consumer publishes `tail` only after copying the payload out.
 *   - A zero-byte payload, a payload above SAB_RING_MAX_FRAME_BYTES and a lane outside one byte are
 *     not frames: the writer refuses them without touching the ring and without counting them as
 *     back-pressure.
 *
 * Concurrency. `sab_ring_load`/`sab_ring_store` publish and read the two indices with release and
 * acquire semantics when the build has threads (`__EMSCRIPTEN_PTHREADS__`), and with plain accesses
 * otherwise -- which is what makes this header usable by the layout test, which is compiled without
 * `-pthread` and is not a concurrency test. What is deliberately *not* here: the notify that wakes a
 * waiting consumer. That belongs to the thread that waits, and in a threaded Emscripten build it is
 * `emscripten_atomic_notify` from <emscripten/threading.h>; the TypeScript side does its half with
 * `Atomics.notify` on slot 0.
 *
 * The memory must be at least four-byte aligned and must be shared memory for the two indices to
 * mean anything: a malloc'd block or the base of a SharedArrayBuffer both are.
 */

#ifndef MELEE_WASM_NET_SAB_RING_H
#define MELEE_WASM_NET_SAB_RING_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define SAB_RING_CONTROL_BYTES 16u
#define SAB_RING_SLOT_HEAD 0u
#define SAB_RING_SLOT_TAIL 1u
#define SAB_RING_SLOT_CAPACITY 2u
#define SAB_RING_SLOT_REFUSED 3u

#define SAB_RING_FRAME_HEADER_BYTES 5u

/* Largest payload a frame may carry; the largest Slippi message is a few hundred bytes
 * (docs/NETCODE_MAP.md, "Packet formats"), so this is a rejection threshold, not a design limit. */
#define SAB_RING_MAX_FRAME_BYTES 1024u

/* Smallest usable data region: one maximum-size frame plus the byte that is left unused. */
#define SAB_RING_MIN_CAPACITY 2048u

/* Lanes mirror ENet channel use: channel 0 is reliable and ordered, channels 1-2 are neither. */
#define SAB_RING_LANE_RELIABLE 0u
#define SAB_RING_LANE_UNRELIABLE 1u

typedef enum {
  SAB_RING_OK = 0,         /* the frame is in the ring, or was taken out of it */
  SAB_RING_EMPTY = 1,      /* no complete frame is published */
  SAB_RING_FULL = 2,       /* back-pressure: the frame did not enter the ring */
  SAB_RING_NOT_A_FRAME = 3,/* zero-length, above the maximum, or a lane outside one byte */
  SAB_RING_CORRUPT = 4     /* a header no single producer can have written */
} sab_ring_status;

typedef struct {
  uint8_t *memory; /* control block at byte 0, data region at SAB_RING_CONTROL_BYTES */
  uint32_t capacity;
} sab_ring;

/* A frame as the consumer sees it. `payload` is the caller's buffer, at least
 * SAB_RING_MAX_FRAME_BYTES long, and `sab_ring_read` copies into it: the producer may overwrite the
 * ring as soon as `tail` moves, so a pointer into the ring would be invalidated by the next write. */
typedef struct {
  uint8_t lane;
  uint32_t length;
  uint8_t *payload;
} sab_ring_frame;

static inline volatile int32_t *sab_ring_slot(const sab_ring *ring, unsigned slot) {
  return (volatile int32_t *)(void *)(ring->memory + (size_t)slot * 4u);
}

static inline int32_t sab_ring_load(const sab_ring *ring, unsigned slot) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  return __atomic_load_n(sab_ring_slot(ring, slot), __ATOMIC_ACQUIRE);
#else
  return *sab_ring_slot(ring, slot);
#endif
}

static inline void sab_ring_store(sab_ring *ring, unsigned slot, int32_t value) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  __atomic_store_n(sab_ring_slot(ring, slot), value, __ATOMIC_RELEASE);
#else
  *sab_ring_slot(ring, slot) = value;
#endif
}

/* The refusal counter is shared, so it is incremented atomically where the build has threads. */
static inline void sab_ring_add(sab_ring *ring, unsigned slot, int32_t delta) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  __atomic_add_fetch(sab_ring_slot(ring, slot), delta, __ATOMIC_RELAXED);
#else
  *sab_ring_slot(ring, slot) += delta;
#endif
}

static inline int sab_ring_is_power_of_two(uint32_t value) {
  return value != 0u && (value & (value - 1u)) == 0u;
}

/* Lay a ring over memory the caller owns, and publish the capacity. Returns 0 on success. */
static inline int sab_ring_init(sab_ring *ring, void *memory, uint32_t capacity) {
  if (memory == NULL) return 0;
  if (!sab_ring_is_power_of_two(capacity) || capacity < SAB_RING_MIN_CAPACITY) return 0;
  ring->memory = (uint8_t *)memory;
  ring->capacity = capacity;
  sab_ring_store(ring, SAB_RING_SLOT_HEAD, 0);
  sab_ring_store(ring, SAB_RING_SLOT_TAIL, 0);
  sab_ring_store(ring, SAB_RING_SLOT_REFUSED, 0);
  sab_ring_store(ring, SAB_RING_SLOT_CAPACITY, (int32_t)capacity);
  return 1;
}

/* Take the capacity from the control block, so a ring image is self-describing. */
static inline int sab_ring_attach(sab_ring *ring, void *memory) {
  if (memory == NULL) return 0;
  ring->memory = (uint8_t *)memory;
  ring->capacity = 0;
  uint32_t capacity = (uint32_t)sab_ring_load(ring, SAB_RING_SLOT_CAPACITY);
  if (!sab_ring_is_power_of_two(capacity) || capacity < SAB_RING_MIN_CAPACITY) return 0;
  ring->capacity = capacity;
  return 1;
}

static inline uint32_t sab_ring_head(const sab_ring *ring) {
  return (uint32_t)sab_ring_load(ring, SAB_RING_SLOT_HEAD);
}

static inline uint32_t sab_ring_tail(const sab_ring *ring) {
  return (uint32_t)sab_ring_load(ring, SAB_RING_SLOT_TAIL);
}

static inline uint32_t sab_ring_refused(const sab_ring *ring) {
  return (uint32_t)sab_ring_load(ring, SAB_RING_SLOT_REFUSED);
}

static inline uint32_t sab_ring_used(const sab_ring *ring) {
  return (sab_ring_head(ring) - sab_ring_tail(ring) + ring->capacity) & (ring->capacity - 1u);
}

/* Bytes a producer may still use. The last byte is never usable, by design. */
static inline uint32_t sab_ring_free(const sab_ring *ring) {
  return ring->capacity - 1u - sab_ring_used(ring);
}

/* Copy `source` into the data region at `offset`, splitting at the end of the region. The caller has
 * already checked that the frame fits, so the second segment cannot reach `tail`. */
static inline void sab_ring_write_at(const sab_ring *ring, uint32_t offset, const uint8_t *source,
                                     uint32_t length) {
  uint32_t first = length;
  if (first > ring->capacity - offset) first = ring->capacity - offset;
  memcpy(ring->memory + SAB_RING_CONTROL_BYTES + offset, source, first);
  if (first < length) {
    memcpy(ring->memory + SAB_RING_CONTROL_BYTES, source + first, length - first);
  }
}

static inline void sab_ring_read_at(const sab_ring *ring, uint32_t offset, uint8_t *target,
                                    uint32_t length) {
  uint32_t first = length;
  if (first > ring->capacity - offset) first = ring->capacity - offset;
  memcpy(target, ring->memory + SAB_RING_CONTROL_BYTES + offset, first);
  if (first < length) {
    memcpy(target + first, ring->memory + SAB_RING_CONTROL_BYTES, length - first);
  }
}

/* Enqueue one frame. Never waits and never writes partially. */
static inline sab_ring_status sab_ring_write(sab_ring *ring, unsigned lane, const uint8_t *payload,
                                             uint32_t length) {
  if (lane > 255u) return SAB_RING_NOT_A_FRAME;
  if (payload == NULL || length == 0u || length > SAB_RING_MAX_FRAME_BYTES) {
    return SAB_RING_NOT_A_FRAME;
  }

  uint32_t size = SAB_RING_FRAME_HEADER_BYTES + length;
  uint32_t head = sab_ring_head(ring);
  uint32_t used = (head - sab_ring_tail(ring) + ring->capacity) & (ring->capacity - 1u);
  if (used + size >= ring->capacity) {
    sab_ring_add(ring, SAB_RING_SLOT_REFUSED, 1);
    return SAB_RING_FULL;
  }

  uint8_t header[SAB_RING_FRAME_HEADER_BYTES];
  header[0] = (uint8_t)(length & 0xffu);
  header[1] = (uint8_t)((length >> 8) & 0xffu);
  header[2] = (uint8_t)((length >> 16) & 0xffu);
  header[3] = (uint8_t)((length >> 24) & 0xffu);
  header[4] = (uint8_t)lane;
  sab_ring_write_at(ring, head, header, SAB_RING_FRAME_HEADER_BYTES);
  sab_ring_write_at(ring, (head + SAB_RING_FRAME_HEADER_BYTES) & (ring->capacity - 1u), payload,
                    length);

  /* Release: everything above is visible to a consumer that loads `head` after this store. */
  sab_ring_store(ring, SAB_RING_SLOT_HEAD, (int32_t)((head + size) & (ring->capacity - 1u)));
  return SAB_RING_OK;
}

/* Dequeue one frame into `frame->payload`. Returns SAB_RING_EMPTY when nothing is published. */
static inline sab_ring_status sab_ring_read(sab_ring *ring, sab_ring_frame *frame) {
  if (frame == NULL || frame->payload == NULL) return SAB_RING_NOT_A_FRAME;

  uint32_t head = sab_ring_head(ring);
  uint32_t tail = sab_ring_tail(ring);
  uint32_t used = (head - tail + ring->capacity) & (ring->capacity - 1u);
  if (used < SAB_RING_FRAME_HEADER_BYTES) return SAB_RING_EMPTY;

  uint8_t header[SAB_RING_FRAME_HEADER_BYTES];
  sab_ring_read_at(ring, tail, header, SAB_RING_FRAME_HEADER_BYTES);
  uint32_t length = (uint32_t)header[0] | ((uint32_t)header[1] << 8) | ((uint32_t)header[2] << 16) |
                    ((uint32_t)header[3] << 24);
  if (length == 0u || length > SAB_RING_MAX_FRAME_BYTES) return SAB_RING_CORRUPT;

  uint32_t size = SAB_RING_FRAME_HEADER_BYTES + length;
  if (used < size) return SAB_RING_CORRUPT;

  sab_ring_read_at(ring, (tail + SAB_RING_FRAME_HEADER_BYTES) & (ring->capacity - 1u), frame->payload,
                   length);
  frame->lane = header[4];
  frame->length = length;
  sab_ring_store(ring, SAB_RING_SLOT_TAIL, (int32_t)((tail + size) & (ring->capacity - 1u)));
  return SAB_RING_OK;
}

#endif /* MELEE_WASM_NET_SAB_RING_H */
