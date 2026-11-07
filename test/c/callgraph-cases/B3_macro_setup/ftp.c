#include "pp.h"
static int ftp_sm(int x) { return x; }
static int ftp_eor(int x) { return x; }
void ftp_connect(struct pp *p) { PP_SETUP(p, ftp_sm, ftp_eor); }
