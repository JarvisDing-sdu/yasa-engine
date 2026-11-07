#include "wc.h"
void wc_free(struct wc *w) { if(w->dtor) w->dtor(w->data); }
