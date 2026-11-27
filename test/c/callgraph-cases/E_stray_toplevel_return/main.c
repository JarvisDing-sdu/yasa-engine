/* Processed after broken.h: its functions must still be registered. */
int leaf(int x) { return x; }
int caller(int y) { return leaf(y); }

struct hooks { int (*run)(int); };
static int stray(int x) { return x; }
static struct hooks callbacks = { .run = leaf };

/* Error recovery can expose statements from a lost function at file scope. */
if (1) {
  callbacks.run = stray;
  stray(0);
}
return 0;

static int (*after_recovery)(int) = leaf;
int use_initializer(int x) { return after_recovery(x); }
int dispatch(struct hooks *h, int x) { return h->run(x); }
