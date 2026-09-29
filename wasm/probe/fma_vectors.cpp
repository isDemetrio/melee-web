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
  void put64(uint64_t bits) {
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

static bool self_test() {
  Sha256 empty, abc, million;
  for (uint8_t c : {'a','b','c'}) abc.put(c);
  for (unsigned i=0;i<1000000;++i) million.put('a');
  return empty.finish()=="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" &&
         abc.finish()=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" &&
         million.finish()=="cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";
}

constexpr uint64_t kTriples=1000000, kPaths=8;
constexpr uint64_t kEdge[] = {
  0,0x8000000000000000ull,1,0x8000000000000001ull,
  0x000fffffffffffffull,0x800fffffffffffffull,0x0010000000000000ull,
  0x8010000000000000ull,0x3ff0000000000000ull,0xbff0000000000000ull,
  0x7fefffffffffffffull,0xffefffffffffffffull,0x7ff0000000000000ull,
  0xfff0000000000000ull,0x7ff8000000000001ull,0xfff8000000001234ull,
  0x7ff0000000000001ull,0xfff0000000005678ull,
  0x3ff0000008000000ull,0x3ff0000007ffffffull,
  0x3ff0000010000000ull,0x3fefffffe0000000ull,0x3ff0000000000001ull,
  0x3fefffffffffffffull};
constexpr uint64_t E=sizeof(kEdge)/sizeof(kEdge[0]);
const char* const kPathNames[kPaths]={"fmadd","fmsub","fnmadd","fnmsub",
                                      "fmadds","fmsubs","fnmadds","fnmsubs"};

struct Triple { uint64_t a, c, b; };

// The comparison regenerates the corpus natively, so it must stay integer-only.
class Corpus {
  uint64_t state=0x4d454c4545574153ull;
  uint64_t random_bits() {
    state += 0x9e3779b97f4a7c15ull;
    uint64_t z=state;
    z=(z^(z>>30))*0xbf58476d1ce4e5b9ull;
    z=(z^(z>>27))*0x94d049bb133111ebull;
    return z^(z>>31);
  }
public:
  Triple next(uint64_t i) {
    // Separate draws: C++ argument evaluation order must not affect the corpus.
    uint64_t a=random_bits(), c=random_bits(), b=random_bits();
    if (i<E*E*E) { a=kEdge[i%E]; c=kEdge[(i/E)%E]; b=kEdge[(i/(E*E))%E]; }
    else if (i%4==0) {
      // More finite values near unity, with cancellation and rounding boundaries.
      a=(a&0x800fffffffffffffull)|0x3ff0000000000000ull;
      c=(c&0x800fffffffffffffull)|0x3ff0000000000000ull;
      b=(b&0x800fffffffffffffull)|0x3ff0000000000000ull;
    }
    return {a,c,b};
  }
};

static uint64_t bits(double d) { uint64_t u; std::memcpy(&u,&d,8); return u; }

static void compute(const Triple& t, uint64_t out[kPaths]) {
  using Op=double(*)(double,double,double);
  const Op ops[]={ppc::fmadd,ppc::fmsub,ppc::fnmadd,ppc::fnmsub};
  double av=ppc::bits_to_double(t.a), cv=ppc::bits_to_double(t.c), bv=ppc::bits_to_double(t.b);
  unsigned k=0;
  // port/recomp/emit.py:586-610: doubles, then fs(op(a,f25(c),b)) singles.
  for (Op op : ops) out[k++]=bits(op(av,cv,bv));
  for (Op op : ops) out[k++]=bits(ppc::fs(op(av,ppc::f25(cv),bv)));
}

// Hash order and bytes match the earlier hash-only probe, so its digests stay comparable.
static int measure(const char* dump_path) {
  FILE* dump=nullptr;
  if (dump_path && !(dump=std::fopen(dump_path,"wb"))) {
    std::fprintf(stderr,"cannot create %s\n",dump_path); return 2;
  }
  Corpus corpus;
  Sha256 hash;
  for (uint64_t i=0;i<kTriples;++i) {
    uint64_t out[kPaths];
    compute(corpus.next(i),out);
    uint8_t record[8*kPaths];
    for (unsigned k=0;k<kPaths;++k) {
      hash.put64(out[k]);
      for (unsigned j=0;j<8;++j) record[8*k+j]=uint8_t(out[k]>>(8*j));
    }
    if (dump && std::fwrite(record,1,sizeof record,dump)!=sizeof record) {
      std::fprintf(stderr,"short write to %s\n",dump_path); return 2;
    }
  }
  if (dump && std::fclose(dump)!=0) { std::fprintf(stderr,"cannot close %s\n",dump_path); return 2; }
  std::puts(hash.finish().c_str());
  return 0;
}

constexpr uint64_t kSign=0x8000000000000000ull, kExp=0x7ff0000000000000ull,
                   kMant=0x000fffffffffffffull;
static bool is_nan(uint64_t u) { return (u&~kSign)>kExp; }
static bool is_inf(uint64_t u) { return (u&~kSign)==kExp; }
static bool is_zero(uint64_t u) { return (u&~kSign)==0; }
static bool is_subnormal(uint64_t u) { return (u&kExp)==0 && (u&kMant)!=0; }

// Class of the operands actually fed to the op (the single paths see f25(c)).
enum Input { kOrdinary, kSubnormalIn, kInfIn, kNanIn, kInputs };
const char* const kInputNames[kInputs]={"ordinary","subnormal-in","inf-in","nan-in"};
static Input input_class(const Triple& t) {
  const uint64_t v[]={t.a,t.c,t.b};
  bool nan=false, inf=false, sub=false;
  for (uint64_t u : v) { nan|=is_nan(u); inf|=is_inf(u); sub|=is_subnormal(u); }
  return nan?kNanIn:inf?kInfIn:sub?kSubnormalIn:kOrdinary;
}

// Kind of a divergence, from both result bit patterns; the first matching rule wins.
enum Kind { kNanness, kNanSign, kNanPayload, kZeroSign, kSubnormal, kValue, kKinds };
const char* const kKindNames[kKinds]={"nan-vs-number","nan-sign","nan-payload",
                                      "zero-sign","subnormal","value"};
static Kind classify(uint64_t n, uint64_t w, const Triple& in) {
  if (is_nan(n)!=is_nan(w)) return kNanness;
  if (is_nan(n)) return ((n^w)&kSign) ? kNanSign : kNanPayload;
  if (is_zero(n) && is_zero(w)) return kZeroSign;
  if (is_subnormal(in.a)||is_subnormal(in.c)||is_subnormal(in.b)||is_subnormal(n)||is_subnormal(w))
    return kSubnormal;
  return kValue;
}

// Only NaN-to-NaN differences in payload/quiet bits, with equal sign, may be exempted:
// FP compares, fsel and fctiw (ppc.h) cannot see them, so they matter only if a NaN
// reaches guest state at all. A NaN sign flip is not exempt: an integer sign test on
// a stored float reads it. NaN-ness, zero sign, subnormal and value differences change
// arithmetic outright. Ordinary operands (normal or zero) are never exempt, whatever
// the result: they are what real gameplay feeds these ops.
static bool exempt(Kind k, Input in, bool allow_nan_payload) {
  return allow_nan_payload && k==kNanPayload && in!=kOrdinary;
}

class Dump {
  FILE* f;
public:
  explicit Dump(const char* path) : f(std::fopen(path,"rb")) {}
  ~Dump() { if (f) std::fclose(f); }
  bool ok() const { return f!=nullptr; }
  bool read(uint64_t& u) {
    uint8_t b[8];
    if (std::fread(b,1,8,f)!=8) return false;
    u=0;
    for (unsigned j=0;j<8;++j) u|=uint64_t(b[j])<<(8*j);
    return true;
  }
  bool at_end() { return std::fgetc(f)==EOF && !std::ferror(f); }
};

struct Example { bool seen; uint64_t i; unsigned path; Triple in; uint64_t native, wasm; };

static void print_example(const char* label, const Example& e) {
  if (!e.seen) return;
  std::printf("first %-13s triple %7llu %-7s a=%016llx c=%016llx b=%016llx "
              "native=%016llx wasm=%016llx\n",label,(unsigned long long)e.i,kPathNames[e.path],
              (unsigned long long)e.in.a,(unsigned long long)e.in.c,(unsigned long long)e.in.b,
              (unsigned long long)e.native,(unsigned long long)e.wasm);
}

static int compare(const char* native_path, const char* wasm_path, bool allow_nan_payload) {
  Dump native(native_path), wasm(wasm_path);
  if (!native.ok()||!wasm.ok()) { std::fputs("cannot open dump\n",stderr); return 2; }
  Corpus corpus;
  Sha256 native_hash, wasm_hash;
  uint64_t results[kInputs]{}, divergent[kInputs]{}, count[kKinds][kInputs]{};
  uint64_t total_divergent=0, violations=0;
  Example first[kKinds]{}, first_violation{};
  for (uint64_t i=0;i<kTriples;++i) {
    const Triple t=corpus.next(i);
    const Triple fed_single={t.a,bits(ppc::f25(ppc::bits_to_double(t.c))),t.b};
    for (unsigned k=0;k<kPaths;++k) {
      uint64_t n, w;
      if (!native.read(n)||!wasm.read(w)) { std::fputs("truncated dump\n",stderr); return 2; }
      native_hash.put64(n); wasm_hash.put64(w);
      const Triple& in = k<4 ? t : fed_single;
      const Input ic=input_class(in);
      ++results[ic];
      if (n==w) continue;
      const Kind kind=classify(n,w,in);
      ++total_divergent; ++divergent[ic]; ++count[kind][ic];
      const Example e{true,i,k,in,n,w};
      if (!first[kind].seen) first[kind]=e;
      if (!exempt(kind,ic,allow_nan_payload)) {
        ++violations;
        if (!first_violation.seen) first_violation=e;
      }
    }
  }
  if (!native.at_end()||!wasm.at_end()) { std::fputs("dump longer than corpus\n",stderr); return 2; }
  const std::string nh=native_hash.finish(), wh=wasm_hash.finish();
  std::printf("sha256 native %s\nsha256 wasm %s\n",nh.c_str(),wh.c_str());
  if ((nh==wh)!=(total_divergent==0)) { std::fputs("hash/classification disagree\n",stderr); return 2; }
  std::printf("results %llu (%llu triples x %llu paths), divergent %llu\n\n",
              (unsigned long long)(kTriples*kPaths),(unsigned long long)kTriples,
              (unsigned long long)kPaths,(unsigned long long)total_divergent);
  std::printf("%-13s %9s %9s\n","input class","results","divergent");
  for (unsigned c=0;c<kInputs;++c)
    std::printf("%-13s %9llu %9llu\n",kInputNames[c],(unsigned long long)results[c],
                (unsigned long long)divergent[c]);
  std::printf("\n%-13s %-6s %9s","divergence","gate","total");
  for (unsigned c=0;c<kInputs;++c) std::printf(" %12s",kInputNames[c]);
  std::puts("");
  for (unsigned k=0;k<kKinds;++k) {
    uint64_t sum=0;
    for (unsigned c=0;c<kInputs;++c) sum+=count[k][c];
    // "exempt" only when the non-ordinary cells are; ordinary cells always fail.
    const char* gate=exempt(Kind(k),kNanIn,allow_nan_payload) ? "exempt" : "FAIL";
    std::printf("%-13s %-6s %9llu",kKindNames[k],gate,(unsigned long long)sum);
    for (unsigned c=0;c<kInputs;++c) std::printf(" %12llu",(unsigned long long)count[k][c]);
    std::puts("");
  }
  std::puts("");
  for (unsigned k=0;k<kKinds;++k) print_example(kKindNames[k],first[k]);
  print_example("violation",first_violation);
  const char* permitted=allow_nan_payload
      ? "NaN payload/quiet-bit differences on non-ordinary inputs"
      : "none (bit-exact)";
  if (violations) {
    std::printf("GATE FAIL: %llu divergent results outside the permitted class: %s\n",
                (unsigned long long)violations,permitted);
    return 1;
  }
  std::printf("GATE PASS: no divergence outside the permitted class: %s\n",permitted);
  return 0;
}

static int usage() {
  std::fputs("usage: fma_vectors [--dump FILE]\n"
             "       fma_vectors --compare NATIVE WASM [--allow-nan-payload-differences]\n",stderr);
  return 2;
}

int main(int argc, char** argv) {
  static_assert(sizeof(double)==8 && sizeof(float)==4, "IEEE widths required");
  if (!self_test()) { std::fputs("SHA-256 self-test failed\n",stderr); return 1; }
  if (argc==1) return measure(nullptr);
  const std::string mode=argv[1];
  if (mode=="--dump" && argc==3) return measure(argv[2]);
  if (mode=="--compare" && argc==4) return compare(argv[2],argv[3],false);
  if (mode=="--compare" && argc==5 && std::string(argv[4])=="--allow-nan-payload-differences")
    return compare(argv[2],argv[3],true);
  return usage();
}
