struct P { int (*init)(void); int (*upd)(int); };
static int my_init(void) { return 1; }
static int my_upd(int x) { return x; }
const struct P G = { my_init, my_upd };
int run(const struct P *p) { return p->init() + p->upd(2); }
int caller(void) { return run(&G); }
