/* The C half of the ring's layout test, and the sequence both halves replay.
 *
 * `wasm/net/check_sab_ring.mjs` drives this program and owns the other half of the comparison: both
 * sides write the sequence below into a ring of the same size, and the driver requires the two
 * ring images to be identical byte for byte, then has each side read the other's image back. The
 * sequence is fixed rather than random so a failure is reproducible: one PRNG (xorshift32, seed
 * 0x1f123bb5) feeds both halves and produces the same payload bytes in C and in JavaScript.
 *
 *   node wasm/net/sab_ring_test.js --produce <path>   write the sequence, dump the ring image
 *   node wasm/net/sab_ring_test.js --consume <path>   read an image and verify it against the
 *                                                     sequence, using the header's own reader
 *
 * It is compiled without `-pthread` on purpose: this is a layout test, not a concurrency test, and
 * a single-threaded compile is the stricter check on the layout because it cannot fall back on
 * atomics to hide a torn write. The build has no upstream include and no game data.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sab_ring.h"

/* The same values the driver uses. RING_CAPACITY is the smallest legal power of two. */
#define RING_CAPACITY SAB_RING_MIN_CAPACITY
#define RNG_SEED 0x1f123bb5u
#define ROUNDS 64u
#define FIFO_CAPACITY (ROUNDS + 4u)
#define IMAGE_BYTES (SAB_RING_CONTROL_BYTES + RING_CAPACITY)

typedef struct {
  uint8_t lane;
  uint32_t length;
  uint32_t fnv;
} frame_ref;

typedef struct {
  frame_ref items[FIFO_CAPACITY];
  size_t head;
  size_t count;
} fifo;

static void fifo_push(fifo *queue, frame_ref item) {
  if (queue->count >= FIFO_CAPACITY) abort();
  queue->items[queue->count] = item;
  queue->count++;
}

static int fifo_take(fifo *queue, frame_ref *out) {
  if (queue->count == 0u) return 0;
  *out = queue->items[queue->head];
  queue->head++;
  queue->count--;
  return 1;
}

typedef struct {
  uint32_t written;
  uint32_t refused_full;
  uint32_t not_frames;
  uint32_t reads;
  uint32_t wrapped;
  uint32_t head;
  uint32_t tail;
  uint32_t capacity;
  uint32_t refused;
  uint32_t left;
} script_result;

static uint32_t rng_state;

static uint32_t rng_next(void) {
  rng_state ^= rng_state << 13;
  rng_state ^= rng_state >> 17;
  rng_state ^= rng_state << 5;
  return rng_state;
}

static uint32_t fnv1a32(const uint8_t *bytes, uint32_t length) {
  uint32_t hash = 0x811c9dc5u;
  uint32_t i;
  for (i = 0; i < length; i++) {
    hash ^= (uint32_t)bytes[i];
    hash *= 0x01000193u;
  }
  return hash;
}

/* The sequence. Returns 0 on failure, having printed the frame or the round that failed. */
static int run_script(sab_ring *ring, fifo *remaining, script_result *result) {
  uint8_t payload[SAB_RING_MAX_FRAME_BYTES + 1u];
  uint8_t scratch[SAB_RING_MAX_FRAME_BYTES];
  sab_ring_frame frame;
  uint32_t round;

  memset(result, 0, sizeof *result);
  remaining->head = 0;
  remaining->count = 0;
  rng_state = RNG_SEED;
  memset(payload, 0, sizeof payload);

  frame.lane = 0;
  frame.length = 0;
  frame.payload = scratch;

  /* Three writes that are not frames, on an empty ring. None may enter the ring, and none of them is
   * back-pressure, so `refused` must stay zero. */
  if (sab_ring_write(ring, 0u, payload, 0u) != SAB_RING_NOT_A_FRAME) {
    fprintf(stderr, "the empty payload was accepted\n");
    return 0;
  }
  if (sab_ring_write(ring, 0u, payload, SAB_RING_MAX_FRAME_BYTES + 1u) != SAB_RING_NOT_A_FRAME) {
    fprintf(stderr, "the oversized payload was accepted\n");
    return 0;
  }
  if (sab_ring_write(ring, 256u, payload, 1u) != SAB_RING_NOT_A_FRAME) {
    fprintf(stderr, "the lane outside one byte was accepted\n");
    return 0;
  }
  result->not_frames = 3u;
  if (sab_ring_used(ring) != 0u || sab_ring_head(ring) != 0u || sab_ring_tail(ring) != 0u ||
      sab_ring_refused(ring) != 0u) {
    fprintf(stderr, "a write that is not a frame changed the ring\n");
    return 0;
  }

  for (round = 0; round < ROUNDS; round++) {
    unsigned lane = (unsigned)(round & 1u);
    uint32_t length = 1u + (rng_next() % 300u);
    uint32_t head_before = sab_ring_head(ring);
    uint32_t i;

    for (i = 0; i < length; i++) payload[i] = (uint8_t)(rng_next() & 0xffu);

    if (sab_ring_write(ring, lane, payload, length) == SAB_RING_OK) {
      frame_ref item;
      result->written++;
      if (sab_ring_head(ring) <= head_before) result->wrapped = 1u;
      item.lane = (uint8_t)lane;
      item.length = length;
      item.fnv = fnv1a32(payload, length);
      fifo_push(remaining, item);
    } else {
      result->refused_full++;
    }

    if (round % 3u == 2u) {
      sab_ring_status status = sab_ring_read(ring, &frame);
      if (status == SAB_RING_OK) {
        frame_ref expected;
        result->reads++;
        if (!fifo_take(remaining, &expected)) {
          fprintf(stderr, "round %u: the ring returned a frame that was never written\n",
                  (unsigned)round);
          return 0;
        }
        if (expected.lane != frame.lane || expected.length != frame.length) {
          fprintf(stderr, "round %u: read lane/length %u/%u, wrote %u/%u\n", (unsigned)round,
                  (unsigned)frame.lane, (unsigned)frame.length, (unsigned)expected.lane,
                  (unsigned)expected.length);
          return 0;
        }
        if (fnv1a32(frame.payload, frame.length) != expected.fnv) {
          fprintf(stderr, "round %u: the payload differs from what was written\n", (unsigned)round);
          return 0;
        }
      } else if (status != SAB_RING_EMPTY) {
        fprintf(stderr, "round %u: reading returned status %d\n", (unsigned)round, (int)status);
        return 0;
      }
    }
  }

  result->head = sab_ring_head(ring);
  result->tail = sab_ring_tail(ring);
  result->capacity = ring->capacity;
  result->refused = sab_ring_refused(ring);
  result->left = (uint32_t)remaining->count;
  return 1;
}

static void print_state(const char *what, const script_result *result) {
  printf("state %s head=%u tail=%u capacity=%u refused=%u wrapped=%u written=%u refused_full=%u "
         "reads=%u left=%u\n",
         what, (unsigned)result->head, (unsigned)result->tail, (unsigned)result->capacity,
         (unsigned)result->refused, (unsigned)result->wrapped, (unsigned)result->written,
         (unsigned)result->refused_full, (unsigned)result->reads, (unsigned)result->left);
}

static uint8_t *read_file(const char *path, size_t *bytes) {
  FILE *file = fopen(path, "rb");
  long length;
  uint8_t *data;
  if (file == NULL) {
    fprintf(stderr, "cannot open %s\n", path);
    return NULL;
  }
  if (fseek(file, 0, SEEK_END) != 0) {
    fprintf(stderr, "cannot seek in %s\n", path);
    fclose(file);
    return NULL;
  }
  length = ftell(file);
  if (length < 0) {
    fprintf(stderr, "cannot tell the size of %s\n", path);
    fclose(file);
    return NULL;
  }
  rewind(file);
  data = malloc((size_t)length);
  if (data == NULL) {
    fprintf(stderr, "out of memory for %s\n", path);
    fclose(file);
    return NULL;
  }
  if (fread(data, 1, (size_t)length, file) != (size_t)length) {
    fprintf(stderr, "cannot read %s\n", path);
    free(data);
    fclose(file);
    return NULL;
  }
  fclose(file);
  *bytes = (size_t)length;
  return data;
}

static int write_file(const char *path, const uint8_t *data, size_t bytes) {
  FILE *file = fopen(path, "wb");
  if (file == NULL) {
    fprintf(stderr, "cannot write %s\n", path);
    return 0;
  }
  if (fwrite(data, 1, bytes, file) != bytes) {
    fprintf(stderr, "cannot write %zu bytes to %s\n", bytes, path);
    fclose(file);
    return 0;
  }
  fclose(file);
  return 1;
}

/* Write the sequence with the header's writer and dump the ring image. */
static int produce(const char *path) {
  uint8_t *memory = malloc(IMAGE_BYTES);
  sab_ring ring;
  fifo remaining;
  script_result result;

  if (memory == NULL) {
    fprintf(stderr, "out of memory\n");
    return 1;
  }
  if (!sab_ring_init(&ring, memory, RING_CAPACITY)) {
    fprintf(stderr, "cannot initialise the ring\n");
    free(memory);
    return 1;
  }
  if (!run_script(&ring, &remaining, &result)) {
    free(memory);
    return 1;
  }
  print_state("produce", &result);
  if (!write_file(path, memory, IMAGE_BYTES)) {
    free(memory);
    return 1;
  }
  free(memory);
  printf("PRODUCE OK\n");
  return 0;
}

/* Read an image with the header's reader and verify it against the sequence. */
static int consume(const char *path) {
  uint8_t *scratch = malloc(IMAGE_BYTES);
  sab_ring scratch_ring;
  fifo expected;
  script_result expected_result;
  uint8_t *image;
  size_t image_bytes = 0;
  sab_ring ring;
  uint8_t payload[SAB_RING_MAX_FRAME_BYTES];
  sab_ring_frame frame;
  uint32_t frames = 0;

  if (scratch == NULL) {
    fprintf(stderr, "out of memory\n");
    return 1;
  }
  if (!sab_ring_init(&scratch_ring, scratch, RING_CAPACITY)) {
    fprintf(stderr, "cannot initialise the scratch ring\n");
    free(scratch);
    return 1;
  }
  if (!run_script(&scratch_ring, &expected, &expected_result)) {
    free(scratch);
    return 1;
  }

  image = read_file(path, &image_bytes);
  if (image == NULL) {
    free(scratch);
    return 1;
  }
  if (image_bytes != (size_t)IMAGE_BYTES) {
    fprintf(stderr, "%s is %zu bytes, a ring image is %u\n", path, image_bytes,
            (unsigned)IMAGE_BYTES);
    free(image);
    free(scratch);
    return 1;
  }
  if (!sab_ring_attach(&ring, image)) {
    fprintf(stderr, "the image does not describe a usable ring\n");
    free(image);
    free(scratch);
    return 1;
  }
  if (ring.capacity != RING_CAPACITY) {
    fprintf(stderr, "the image says capacity %u, the sequence uses %u\n", (unsigned)ring.capacity,
            (unsigned)RING_CAPACITY);
    free(image);
    free(scratch);
    return 1;
  }
  if (sab_ring_head(&ring) != expected_result.head || sab_ring_tail(&ring) != expected_result.tail ||
      sab_ring_refused(&ring) != expected_result.refused) {
    fprintf(stderr, "the image ends at head=%u tail=%u refused=%u, the sequence at %u/%u/%u\n",
            (unsigned)sab_ring_head(&ring), (unsigned)sab_ring_tail(&ring),
            (unsigned)sab_ring_refused(&ring), (unsigned)expected_result.head,
            (unsigned)expected_result.tail, (unsigned)expected_result.refused);
    free(image);
    free(scratch);
    return 1;
  }

  frame.lane = 0;
  frame.length = 0;
  frame.payload = payload;
  for (;;) {
    sab_ring_status status = sab_ring_read(&ring, &frame);
    frame_ref want;
    if (status == SAB_RING_EMPTY) break;
    if (status != SAB_RING_OK) {
      fprintf(stderr, "frame %u: reading returned status %d\n", (unsigned)frames, (int)status);
      free(image);
      free(scratch);
      return 1;
    }
    if (!fifo_take(&expected, &want)) {
      fprintf(stderr, "frame %u: the image holds a frame the sequence never left\n",
              (unsigned)frames);
      free(image);
      free(scratch);
      return 1;
    }
    if (want.lane != frame.lane || want.length != frame.length ||
        want.fnv != fnv1a32(frame.payload, frame.length)) {
      fprintf(stderr, "frame %u: the image's frame does not match the sequence\n", (unsigned)frames);
      free(image);
      free(scratch);
      return 1;
    }
    frames++;
  }
  if (expected.count != 0u) {
    fprintf(stderr, "the image holds %zu frames fewer than the sequence left\n", expected.count);
    free(image);
    free(scratch);
    return 1;
  }
  if (frames != expected_result.left) {
    fprintf(stderr, "read %u frames from the image, the sequence left %u\n", (unsigned)frames,
            (unsigned)expected_result.left);
    free(image);
    free(scratch);
    return 1;
  }

  print_state("consume", &expected_result);
  free(image);
  free(scratch);
  printf("CONSUME OK frames=%u\n", (unsigned)frames);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--produce") == 0) return produce(argv[2]);
  if (argc == 3 && strcmp(argv[1], "--consume") == 0) return consume(argv[2]);
  fprintf(stderr, "usage: %s --produce <path> | --consume <path>\n", argv[0]);
  return 2;
}
