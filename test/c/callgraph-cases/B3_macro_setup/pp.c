#include "pp.h"
int pp_statemach(struct pp *p) { return p->statemachine(1) + p->endofresp(2); }
