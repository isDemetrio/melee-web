// Measurement-only counters for the general RAM-write invalidator.
#pragma once
#include <cstdint>
namespace memory_measure {
inline bool enabled = false;
enum Counter { CALLS, ZERO_BYTES, OUT_OF_RANGE, SINGLE_BLOCK, MULTI_BLOCK,
               BYTES_1, BYTES_2, BYTES_4, BYTES_8, BYTES_OTHER,
               BLOCK_CHECKS, WATCHED_HITS, COUNT };
inline const char* names[] = {"calls", "zero_bytes", "out_of_range", "single_block", "multi_block",
  "bytes_1", "bytes_2", "bytes_4", "bytes_8", "bytes_other", "block_checks", "watched_hits"};
inline uint64_t counters[COUNT]{};
inline void count(Counter c) { if (enabled) ++counters[c]; }
}
