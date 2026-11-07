#include "wc.h"
static void wc_data_dtor(void *p) { (void)p; }
void wc_init(struct wc *w) { w->dtor = wc_data_dtor; }
