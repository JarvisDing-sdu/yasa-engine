struct enc { const char *name; int (*encodefunc)(int); };
struct part { const struct enc *encoder; };
