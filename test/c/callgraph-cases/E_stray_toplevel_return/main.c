/* Processed after broken.h: its functions must still be registered. */
int leaf(int x) { return x; }
int caller(int y) { return leaf(y); }
