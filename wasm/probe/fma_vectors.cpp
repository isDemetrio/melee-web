#include "ppc.h"
#include <cstdio>
#include <cstring>
#include <string>

// Streaming SHA-256, with known-answer checks before any floating-point work.
class Sha256 {
  uint32_t h[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                   0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
  uint8_t block[64]{};
  uint64_t bytes = 0;
  size_t used = 0;
  static uint32_t rotr(uint32_t x, unsigned n) { return (x >> n) | (x << (32-n)); }
  void compress() {
    static constexpr uint32_t k[64] = {
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
    uint32_t w[64];
    for (unsigned i=0;i<16;++i)
      w[i]=(uint32_t(block[4*i])<<24)|(uint32_t(block[4*i+1])<<16)|
           (uint32_t(block[4*i+2])<<8)|block[4*i+3];
    for (unsigned i=16;i<64;++i) {
      uint32_t x=w[i-15], y=w[i-2];
      w[i]=w[i-16]+(rotr(x,7)^rotr(x,18)^(x>>3))+w[i-7]+(rotr(y,17)^rotr(y,19)^(y>>10));
    }
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],v=h[7];
    for (unsigned i=0;i<64;++i) {
      uint32_t t1=v+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+k[i]+w[i];
      uint32_t t2=(rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c));
      v=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
    }
    h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=v;
  }
public:
  void put(uint8_t x) {
    ++bytes; block[used++]=x;
    if (used==64) { compress(); used=0; }
  }
  void result(double x) {
    uint64_t bits; std::memcpy(&bits,&x,8);
    // Fixed little-endian binary64 encoding, including every NaN payload/sign bit.
    for (unsigned j=0;j<8;++j) put(uint8_t(bits>>(8*j)));
  }
  std::string finish() {
    const uint64_t bits=bytes*8;
    put(0x80);
    while (used!=56) put(0);
    for (int j=7;j>=0;--j) put(uint8_t(bits>>(8*j)));
    char out[65];
    for (unsigned i=0;i<8;++i) std::snprintf(out+8*i,9,"%08x",unsigned(h[i]));
    return out;
  }
};

static uint64_t random_bits(uint64_t& state) {
  state += 0x9e3779b97f4a7c15ull;
  uint64_t z=state;
  z=(z^(z>>30))*0xbf58476d1ce4e5b9ull;
  z=(z^(z>>27))*0x94d049bb133111ebull;
  return z^(z>>31);
}

int main() {
  static_assert(sizeof(double)==8 && sizeof(float)==4, "IEEE widths required");
  Sha256 empty, abc, million;
  for (uint8_t c : {'a','b','c'}) abc.put(c);
  for (unsigned i=0;i<1000000;++i) million.put('a');
  if (empty.finish()!="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ||
      abc.finish()!="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" ||
      million.finish()!="cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0") {
    std::fputs("SHA-256 self-test failed\n",stderr); return 1;
  }
  constexpr uint64_t edge[] = {
    0,0x8000000000000000ull,1,0x8000000000000001ull,
    0x000fffffffffffffull,0x800fffffffffffffull,0x0010000000000000ull,
    0x8010000000000000ull,0x3ff0000000000000ull,0xbff0000000000000ull,
    0x7fefffffffffffffull,0xffefffffffffffffull,0x7ff0000000000000ull,
    0xfff0000000000000ull,0x7ff8000000000001ull,0xfff8000000001234ull,
    0x7ff0000000000001ull,0xfff0000000005678ull,
    0x3ff0000008000000ull,0x3ff0000007ffffffull,
    0x3ff0000010000000ull,0x3fefffffe0000000ull,0x3ff0000000000001ull,
    0x3fefffffffffffffull};
  constexpr uint64_t E=sizeof(edge)/sizeof(edge[0]);
  uint64_t state=0x4d454c4545574153ull;
  Sha256 hash;
  using Op=double(*)(double,double,double);
  const Op ops[]={ppc::fmadd,ppc::fmsub,ppc::fnmadd,ppc::fnmsub};
  for (uint64_t i=0;i<1000000;++i) {
    // Separate draws: C++ argument evaluation order must not affect the corpus.
    uint64_t a=random_bits(state), c=random_bits(state), b=random_bits(state);
    if (i<E*E*E) { a=edge[i%E]; c=edge[(i/E)%E]; b=edge[(i/(E*E))%E]; }
    else if (i%4==0) {
      // More finite values near unity, with cancellation and rounding boundaries.
      a=(a&0x800fffffffffffffull)|0x3ff0000000000000ull;
      c=(c&0x800fffffffffffffull)|0x3ff0000000000000ull;
      b=(b&0x800fffffffffffffull)|0x3ff0000000000000ull;
    }
    double av=ppc::bits_to_double(a), cv=ppc::bits_to_double(c), bv=ppc::bits_to_double(b);
    // port/recomp/emit.py:586-610: doubles, then fs(op(a,f25(c),b)) singles.
    for (Op op : ops) hash.result(op(av,cv,bv));
    for (Op op : ops) hash.result(ppc::fs(op(av,ppc::f25(cv),bv)));
  }
  std::puts(hash.finish().c_str());
}
