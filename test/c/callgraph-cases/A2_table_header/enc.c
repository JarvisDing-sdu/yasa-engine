#include <string.h>
#include "enc.h"
static int enc_nop(int x) { return x; }
static int enc_b64(int x) { return x * 2; }
static const struct enc encoders[] = { {"binary", enc_nop}, {"base64", enc_b64}, {0, 0} };
static const struct enc *find_enc(const char *n) {
  const struct enc *e;
  for(e = encoders; e->name; e++) if(!strcmp(e->name, n)) return e;
  return 0;
}
void set_enc(struct part *p, const char *n) { p->encoder = find_enc(n); }
int read_part(struct part *p) { return p->encoder->encodefunc(1); }
