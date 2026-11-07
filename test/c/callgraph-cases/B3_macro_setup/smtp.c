#include "pp.h"
static int smtp_sm(int x) { return x; }
static int smtp_eor(int x) { return x; }
void smtp_connect(struct pp *p) { PP_SETUP(p, smtp_sm, smtp_eor); }
