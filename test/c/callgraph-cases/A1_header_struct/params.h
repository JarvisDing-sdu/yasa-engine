struct P { int (*init)(void); int (*upd)(int); };
extern const struct P G;
int run(const struct P *p);
