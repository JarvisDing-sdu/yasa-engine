struct pp { int (*statemachine)(int); int (*endofresp)(int); };
#define PP_SETUP(p, s, e) do { (p)->statemachine = s; (p)->endofresp = e; } while(0)
int pp_statemach(struct pp *p);
