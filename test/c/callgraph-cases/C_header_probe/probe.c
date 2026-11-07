#include "p.h"
static int my_init(void) { return 1; }
static int my_upd(int x) { return x; }
const struct P G = { my_init, my_upd };
const struct P GD = { .upd = my_upd, .init = my_init };
int c_global_direct(void) { return G.init(); }
int c_global_ptr(void) { const struct P *q = &G; return q->init(); }
int c_designated(void) { return GD.init(); }
int c_local_positional(void) { struct P l = { my_init, my_upd }; return l.init(); }
int c_field_assign(void) { struct P l; l.init = my_init; return l.init(); }
static int run(const struct P *p) { return p->init(); }
int c_param_context(void) { return run(&G); }
